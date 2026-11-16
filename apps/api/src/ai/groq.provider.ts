import { logger } from '../logger';
import { AiUnavailableError, type AiBlock, type AiMessage, type AiProvider, type AiRequest, type AiResponse, type AiTool, type VisionRequest, type VisionResponse } from './provider';

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

  /** Vision uses Groq's image-capable model, whatever the text route says. */
  see(req: VisionRequest): Promise<VisionResponse> {
    return groqSee(req);
  }

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

/**
 * Groq models that can see images, best first. Groq retires and renames these
 * (Llama 3.2 vision, then Llama 4 Scout/Maverick, then Qwen 3.x 27B), so Orbit
 * tries whatever the account lists that looks like a vision model, plus Groq's
 * documented current one, and keeps the first that accepts an image.
 * GROQ_VISION_MODEL (env) always goes first.
 */
export const GROQ_VISION_FALLBACK = 'qwen/qwen3.8-27b';
const VISION_PREFERRED = [/qwen\/qwen3\.\d+-27b/i, /llama-4-maverick/i, /llama-4-scout/i, /vision|-vl\b|vl-|llava|pixtral|gemma-3/i];
export function groqVisionCandidates(ids: string[], env = process.env.GROQ_VISION_MODEL): string[] {
  const out: string[] = [];
  const add = (id: string | undefined) => id && !out.includes(id) && out.push(id);
  add(env);
  for (const re of VISION_PREFERRED) for (const id of ids) if (re.test(id) && !NOT_CHAT.test(id)) add(id);
  add(GROQ_VISION_FALLBACK);
  return out;
}
/** Kept for callers/tests: the best vision model in a list, or null. */
export function pickGroqVisionModel(ids: string[]): string | null {
  return groqVisionCandidates(ids, '').find((id) => ids.includes(id)) ?? null;
}
let visionModel: { id: string; at: number } | null = null;
/** The model refused an image or does not exist: try the next one. */
const NO_VISION = /image|vision|multimodal|content.*(type|part)|does not support|not supported|model_not_found|does not exist|decommissioned|not have access|no longer supported/i;

/** Groq vision: images in, one JSON object out (JSON mode). PDFs are turned into page images on the phone first. */
export async function groqSee(req: VisionRequest): Promise<VisionResponse> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new AiUnavailableError('GROQ_API_KEY is not set');
  if (req.images.some((i) => i.mime === 'application/pdf')) throw new AiUnavailableError('Groq cannot read PDFs directly');
  const cached = visionModel && Date.now() - visionModel.at < 6 * 3600_000 ? visionModel.id : null;
  const listed = cached ? [] : await listModels(key);
  const candidates = cached ? [cached, ...groqVisionCandidates(listed).filter((m) => m !== cached)] : groqVisionCandidates(listed);
  let lastMsg = 'no candidate';
  for (const model of candidates) {
    const body = (json: boolean) => JSON.stringify({
      model,
      temperature: 0,
      max_completion_tokens: req.maxTokens ?? 4000,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: [{ type: 'text', text: req.prompt }, ...req.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } }))] },
      ],
    });
    let res: Response;
    let data: any;
    try {
      res = await fetch(GROQ_URL, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body(true), signal: AbortSignal.timeout(60_000) });
      data = await res.json().catch(() => ({}));
      // Some models refuse JSON mode together with images: ask again without it (the prompt still asks for JSON).
      if (!res.ok && /response_format|json/i.test(data?.error?.message ?? '')) {
        res = await fetch(GROQ_URL, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body(false), signal: AbortSignal.timeout(60_000) });
        data = await res.json().catch(() => ({}));
      }
    } catch (e) {
      throw new AiUnavailableError(`Groq unreachable: ${(e as Error).message}`);
    }
    if (res.ok) {
      if (visionModel?.id !== model) logger.log(`Groq vision model: ${model}`, 'AI');
      visionModel = { id: model, at: Date.now() };
      return {
        text: String(data.choices?.[0]?.message?.content ?? ''),
        model: data.model ?? model,
        usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0, cacheRead: 0, cacheWrite: 0 },
      };
    }
    lastMsg = data?.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) throw new AiUnavailableError('Groq key missing or invalid');
    if (res.status === 429 || res.status >= 500) throw new AiUnavailableError(`Groq unavailable: ${lastMsg}`);
    if (model === visionModel?.id) visionModel = null;
    if (!NO_VISION.test(lastMsg) && res.status !== 404) throw new AiUnavailableError(`Groq vision failed: ${lastMsg}`);
    logger.warn(`Groq model ${model} cannot read images (${lastMsg.slice(0, 160)}); trying the next one`, 'AI');
  }
  logger.warn(`No Groq vision model worked. Models on this account: ${listed.join(', ') || '(list unavailable)'}. Set GROQ_VISION_MODEL to one that reads images.`, 'AI');
  throw new AiUnavailableError(`No Groq model that can read images worked (${lastMsg})`);
}

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
