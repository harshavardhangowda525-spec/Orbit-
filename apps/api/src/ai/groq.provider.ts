import { logger } from '../logger';
import { AiUnavailableError, type AiBlock, type AiMessage, type AiProvider, type AiRequest, type AiResponse, type AiTool } from './provider';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const GROQ_DEFAULT_MODEL = 'openai/gpt-oss-120b';

/** Groq's model: GROQ_MODEL, else AI_MODEL unless that names a Claude model, else the default. */
export function groqModel(): string {
  const ai = process.env.AI_MODEL ?? '';
  return process.env.GROQ_MODEL || (ai && !ai.startsWith('claude') ? ai : GROQ_DEFAULT_MODEL);
}

/** Preferred chat models with tool use, best first (Groq retires models; the list is matched against what the account has). */
const PREFERRED = [/^openai\/gpt-oss-120b/, /llama-4-maverick/, /kimi-k2/, /llama-3\.3-70b/, /qwen3-32b/, /llama-4-scout/, /^openai\/gpt-oss-20b/, /qwen/, /llama-3\.1-8b/];
const NOT_CHAT = /whisper|tts|guard|playai|orpheus|compound|allam|distil|embed/i;
/** Replacement chosen for each model Groq refused; kept for the life of the process. */
const replaced = new Map<string, string>();
export const resetGroqFallback = () => replaced.clear();

/** Pick the best chat model the account can use from Groq's model list. */
export function pickGroqModel(ids: string[], refused: string): string | null {
  const usable = ids.filter((id) => id !== refused && !NOT_CHAT.test(id));
  for (const re of PREFERRED) {
    const hit = usable.find((id) => re.test(id));
    if (hit) return hit;
  }
  return usable[0] ?? null;
}

const MODEL_GONE = /does not exist|decommissioned|model_not_found|not have access|no longer supported|deprecated/i;

type OaMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

const text = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => (typeof x === 'string' ? x : x?.text ?? '')).join('\n') : '');

/** Orbit's (Anthropic-shaped) conversation → OpenAI-style chat messages that Groq accepts. */
export function toGroqMessages(system: string, messages: AiMessage[]): OaMessage[] {
  const out: OaMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content } as OaMessage);
      continue;
    }
    const blocks = m.content as any[];
    if (m.role === 'assistant') {
      const said = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: 'assistant', content: said || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // User turn: tool results become "tool" messages; any text stays a user message.
    for (const b of blocks.filter((x) => x.type === 'tool_result')) {
      const body = text(b.content);
      out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? JSON.stringify({ error: body }) : body });
    }
    const said = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (said) out.push({ role: 'user', content: said });
  }
  return out;
}

export function toGroqTools(tools: AiTool[]) {
  return tools.map((t: any) => ({ type: 'function' as const, function: { name: t.name, description: t.description ?? '', parameters: t.input_schema } }));
}

/** Groq's reply → Orbit blocks (text + tool_use), so Aria's loop does not care which provider answered. */
export function fromGroqChoice(choice: any): { content: AiBlock[]; stopReason: string } {
  const msg = choice?.message ?? {};
  const content: AiBlock[] = [];
  if (msg.content) content.push({ type: 'text', text: String(msg.content), citations: null } as AiBlock);
  for (const c of msg.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = c.function?.arguments ? JSON.parse(c.function.arguments) : {};
    } catch {
      input = {};
    }
    content.push({ type: 'tool_use', id: c.id, name: c.function?.name, input } as AiBlock);
  }
  const fr = choice?.finish_reason;
  const stopReason = content.some((b) => b.type === 'tool_use') ? 'tool_use' : fr === 'length' ? 'max_tokens' : 'end_turn';
  return { content, stopReason };
}

/**
 * Groq (OpenAI-compatible API, open models such as Llama). Cheaper and very
 * fast; tool use and Hindi/Kannada are less reliable than Claude, which the
 * guardrails (no invented prices, handover on failure) cover.
 */
export class GroqProvider implements AiProvider {
  readonly name = 'groq';

  /** `model` comes from the tier routing; without one, GROQ_MODEL / the default. */
  async complete(req: AiRequest, model?: string): Promise<AiResponse> {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new AiUnavailableError('GROQ_API_KEY is not set');
    const requested = model || groqModel();
    const configured = replaced.get(requested) ?? requested;
    try {
      return await this.send(key, configured, req);
    } catch (e) {
      if (!(e instanceof ModelGone)) throw e;
      // The model was retired or is not on this account: ask Groq what is available and use the best one.
      const ids = await listModels(key);
      const next = pickGroqModel(ids, configured);
      if (!next) throw new AiUnavailableError(`Groq model ${configured} is not available and no other chat model was found`);
      logger.warn(`Groq model ${configured} is not available; using ${next}. Change it in admin → AI routing.`, 'AI');
      replaced.set(requested, next);
      return this.send(key, next, req);
    }
  }

  private async send(key: string, model: string, req: AiRequest): Promise<AiResponse> {
    const body: Record<string, unknown> = {
      model,
      messages: toGroqMessages(req.system, req.messages),
      max_tokens: req.maxTokens ?? 2000,
      temperature: 0.3,
    };
    if (req.tools.length) {
      body.tools = toGroqTools(req.tools);
      body.tool_choice = 'auto';
    }
    let res: Response;
    try {
      res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (e) {
      throw new AiUnavailableError(`Groq unreachable: ${(e as Error).message}`);
    }
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message ?? `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) throw new AiUnavailableError('Groq key missing or invalid');
      if (res.status === 429 || res.status >= 500) throw new AiUnavailableError(`Groq unavailable: ${msg}`);
      if ((res.status === 404 || res.status === 400) && (data?.error?.code === 'model_not_found' || data?.error?.code === 'model_decommissioned' || MODEL_GONE.test(msg))) throw new ModelGone(msg);
      // e.g. 400 tool_use_failed: the model wrote a broken tool call. Aria hands over instead of guessing.
      throw new AiUnavailableError(`Groq request failed: ${msg}`);
    }
    const { content, stopReason } = fromGroqChoice(data.choices?.[0]);
    return {
      content,
      stopReason,
      model: data.model ?? model,
      usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0, cacheRead: 0, cacheWrite: 0 },
    };
  }
}

class ModelGone extends Error {}

async function listModels(key: string): Promise<string[]> {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    const d: any = await res.json().catch(() => ({}));
    if (!res.ok) return [];
    return (d.data ?? []).filter((m: any) => m.active !== false).map((m: any) => String(m.id));
  } catch {
    return [];
  }
}
