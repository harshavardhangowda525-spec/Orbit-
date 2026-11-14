import Anthropic from '@anthropic-ai/sdk';
import { runtime } from '../config';

export type AiMessage = Anthropic.Beta.BetaMessageParam;
export type AiTool = Anthropic.Beta.BetaTool;
export type AiBlock = Anthropic.Beta.BetaContentBlock;

export interface AiRequest {
  /** Stable instructions + business facts (cached prefix). */
  system: string;
  messages: AiMessage[];
  tools: AiTool[];
  maxTokens?: number;
}

export interface AiResponse {
  content: AiBlock[];
  stopReason: string | null;
  model: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** Swappable provider so the rest of Orbit never talks to an LLM SDK directly. */
export interface AiProvider {
  readonly name: string;
  /** `model` is chosen by the tier routing; providers fall back to their own default without it. */
  complete(req: AiRequest, model?: string): Promise<AiResponse>;
}

export class AiUnavailableError extends Error {}

/** $ per 1M tokens: input, output, cache read, cache write (5-minute). */
const PRICES: Record<string, [number, number, number, number]> = {
  'claude-opus-5-5': [4, 20, 0.2, 5],
  'claude-sonnet-5-5': [2, 10, 0.2, 2.5],
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125],
  // Groq (approximate list prices).
  'llama-3.3-70b-versatile': [0.59, 0.79, 0, 0],
  'llama-3.1-8b-instant': [0.05, 0.08, 0, 0],
  'openai/gpt-oss-120b': [0.15, 0.75, 0, 0],
  'openai/gpt-oss-20b': [0.1, 0.5, 0, 0],
};
/** Unknown non-Claude models (e.g. another Groq model) are priced like a mid-size open model. */
const OPEN_MODEL_PRICE: [number, number, number, number] = [0.59, 0.79, 0, 0];
export function costOf(model: string, u: AiResponse['usage']): number {
  const p = PRICES[model] ?? (model.startsWith('claude') ? PRICES['claude-opus-5-5'] : model === 'fake' ? [0, 0, 0, 0] : OPEN_MODEL_PRICE);
  return (u.input * p[0] + u.output * p[1] + u.cacheRead * p[2] + u.cacheWrite * p[3]) / 1_000_000;
}

/**
 * Claude via the official SDK. Low effort keeps chat replies to a few seconds;
 * the stable system prompt + tool list are cached; server-side fallbacks keep
 * a customer conversation going if a request is declined by a safety classifier.
 */
export class ClaudeProvider implements AiProvider {
  readonly name = 'claude';
  private _client: Anthropic | null = null;
  /** Created on first use, so servers without an Anthropic key still start. */
  private get client() {
    return (this._client ??= new Anthropic({ timeout: 45_000, maxRetries: 2 }));
  }

  async complete(req: AiRequest, model?: string): Promise<AiResponse> {
    if (!process.env.ANTHROPIC_API_KEY) throw new AiUnavailableError('ANTHROPIC_API_KEY is not set');
    try {
      const r = await this.client.beta.messages.create({
        model: model && model.startsWith('claude') ? model : runtime.aiModel,
        max_tokens: req.maxTokens ?? 4000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: (process.env.AI_EFFORT as any) ?? 'low' },
        cache_control: { type: 'ephemeral' },
        system: req.system,
        tools: req.tools,
        messages: req.messages,
      } as any);
      return {
        content: r.content,
        stopReason: r.stop_reason,
        model: r.model,
        usage: {
          input: r.usage.input_tokens ?? 0,
          output: r.usage.output_tokens ?? 0,
          cacheRead: r.usage.cache_read_input_tokens ?? 0,
          cacheWrite: r.usage.cache_creation_input_tokens ?? 0,
        },
      };
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new AiUnavailableError('AI key missing or invalid');
      if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError) {
        throw new AiUnavailableError(`AI provider unavailable: ${(e as Error).message}`);
      }
      throw e;
    }
  }
}
