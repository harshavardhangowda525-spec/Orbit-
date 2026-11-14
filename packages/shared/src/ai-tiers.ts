import type { AiTier } from './plans';

/**
 * AI routing: which provider and model serve each tier and kind of task.
 * Stored in platform settings (key "ai.routing") and edited in admin; these
 * are the defaults. Provider and model names are internal: businesses and
 * their customers only ever see "Orbit" and the Crew.
 */
export type AiProviderKey = 'groq' | 'claude' | 'fake';
/** conversation: customer chats and calls; command: Command Orbit and planning; simple: short low-risk text. */
export type AiTaskType = 'conversation' | 'command' | 'simple';
export interface AiRoute { provider: AiProviderKey; model: string }
export interface AiTierConfig { routes: Record<AiTaskType, AiRoute>; fallback: AiRoute[] }
export type AiRouting = Record<AiTier, AiTierConfig>;

export const AI_TIERS: AiTier[] = ['free', 'standard', 'premium'];
export const AI_TASK_TYPES: AiTaskType[] = ['conversation', 'command', 'simple'];
/** Cheapest first: a paid tier may fall back to a lower tier, never a free one up. */
export const TIER_RANK: Record<AiTier, number> = { free: 0, standard: 1, premium: 2 };

const g = (model: string): AiRoute => ({ provider: 'groq', model });

/** Defaults: Groq-hosted open models on every tier until a premium provider is added in admin. */
export const DEFAULT_AI_ROUTING: AiRouting = {
  free: {
    routes: { conversation: g('openai/gpt-oss-20b'), command: g('openai/gpt-oss-20b'), simple: g('llama-3.1-8b-instant') },
    fallback: [g('llama-3.1-8b-instant')],
  },
  standard: {
    routes: { conversation: g('openai/gpt-oss-120b'), command: g('openai/gpt-oss-120b'), simple: g('openai/gpt-oss-20b') },
    fallback: [g('openai/gpt-oss-20b'), g('llama-3.1-8b-instant')],
  },
  premium: {
    routes: { conversation: g('openai/gpt-oss-120b'), command: g('openai/gpt-oss-120b'), simple: g('openai/gpt-oss-20b') },
    fallback: [g('openai/gpt-oss-20b'), g('llama-3.1-8b-instant')],
  },
};

/** Fill gaps in a stored routing with the defaults, so a partial admin edit never breaks routing. */
export function resolveRouting(stored: unknown): AiRouting {
  const out = JSON.parse(JSON.stringify(DEFAULT_AI_ROUTING)) as AiRouting;
  const s = (stored ?? {}) as Partial<Record<AiTier, Partial<AiTierConfig>>>;
  for (const tier of AI_TIERS) {
    const t = s[tier];
    if (!t) continue;
    for (const task of AI_TASK_TYPES) {
      const r = t.routes?.[task];
      if (r?.provider && r.model) out[tier].routes[task] = { provider: r.provider, model: r.model };
    }
    if (Array.isArray(t.fallback)) out[tier].fallback = t.fallback.filter((r) => r?.provider && r.model).map((r) => ({ provider: r.provider, model: r.model }));
  }
  return out;
}

/** Words that must never reach a business or a customer (provider and model names). */
export const PROVIDER_WORDS = /\b(groq|anthropic|claude|openai|gpt-oss|gpt-?\d|llama|mixtral|gemma|qwen|kimi|sarvam|bulbul|saaras|deepseek|gemini)\b/i;
