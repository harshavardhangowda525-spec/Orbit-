import { Injectable } from '@nestjs/common';
import { AI_TIERS, TIER_RANK, resolveRouting, type AgentKey, type AiProviderKey, type AiRoute, type AiRouting, type AiTaskType, type AiTier } from '@orbit/shared';
import { DbService } from '../db/db.service';
import { runtime } from '../config';
import { AiUnavailableError, ClaudeProvider, costOf, type AiProvider, type AiRequest, type AiResponse } from './provider';
import { FakeProvider } from './fake.provider';
import { GroqProvider } from './groq.provider';
import { logger } from '../logger';

const CACHE_MS = 30_000;

/** Which kind of work an agent's call is, for routing. */
export function taskTypeFor(agent: AgentKey): AiTaskType {
  if (agent === 'orbit') return 'command';
  if (agent === 'aria' || agent === 'vox') return 'conversation';
  return 'simple';
}

/**
 * The single entry point for LLM calls.
 *
 * Every call is routed by the business's plan tier (free / standard / premium)
 * and the kind of task (customer conversation, Command Orbit, simple text) to a
 * provider and model set in admin (platform setting "ai.routing"). If that
 * provider fails or is rate-limited, the tier's fallbacks are tried, then (for
 * paid tiers only) the routes of lower tiers: a business may temporarily get a
 * cheaper model, never a more expensive one. Every attempt is logged per
 * business with provider, model, tier, tokens and cost. Provider and model
 * names never leave the server: errors shown to people say only "Orbit".
 */
@Injectable()
export class AiService {
  /** Providers by key. In tests (AI_PROVIDER=fake) every key is the scripted fake. */
  providers: Partial<Record<AiProviderKey, AiProvider>>;
  private routing: { at: number; value: AiRouting } | null = null;
  private tiers = new Map<string, { at: number; tier: AiTier }>();

  constructor(private readonly db: DbService) {
    if (runtime.aiProvider === 'fake') {
      const fake = new FakeProvider();
      this.providers = { fake, groq: fake, claude: fake };
    } else {
      this.providers = { groq: new GroqProvider(), claude: new ClaudeProvider() };
    }
    logger.log(`AI routing by plan tier (${runtime.aiProvider === 'fake' ? 'offline demo' : 'live providers'})`, 'AI');
  }

  /** The scripted provider used in tests and offline demos. */
  get fake(): FakeProvider | null {
    return this.providers.fake instanceof FakeProvider ? this.providers.fake : null;
  }

  /** Back-compat: the provider serving the default route. */
  get provider(): AiProvider {
    return this.providers.fake ?? this.providers.groq!;
  }

  /** Forget cached routing and tiers (after an admin edit or a plan change). */
  invalidate(businessId?: string) {
    this.routing = null;
    if (businessId) this.tiers.delete(businessId);
    else this.tiers.clear();
  }

  async currentRouting(): Promise<AiRouting> {
    if (this.routing && Date.now() - this.routing.at < CACHE_MS) return this.routing.value;
    const row = await this.db.one<{ value: unknown }>(`SELECT value FROM platform_settings WHERE key = 'ai.routing'`).catch(() => null);
    const value = resolveRouting(row?.value);
    this.routing = { at: Date.now(), value };
    return value;
  }

  async tierOf(businessId: string): Promise<AiTier> {
    const hit = this.tiers.get(businessId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.tier;
    const r = await this.db.one<{ tier: string | null }>(
      `SELECT p.features->>'aiTier' AS tier FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.id = $1`,
      [businessId],
    );
    const tier = (AI_TIERS as string[]).includes(r?.tier ?? '') ? (r!.tier as AiTier) : 'free';
    this.tiers.set(businessId, { at: Date.now(), tier });
    return tier;
  }

  /** Primary route, the tier's fallbacks, then lower tiers' routes for the same task (never higher). */
  chainFor(routing: AiRouting, tier: AiTier, task: AiTaskType): { route: AiRoute; tier: AiTier }[] {
    const out: { route: AiRoute; tier: AiTier }[] = [];
    const add = (route: AiRoute, t: AiTier) => {
      if (!out.some((x) => x.route.provider === route.provider && x.route.model === route.model)) out.push({ route, tier: t });
    };
    add(routing[tier].routes[task], tier);
    for (const r of routing[tier].fallback) add(r, tier);
    for (const lower of [...AI_TIERS].filter((t) => TIER_RANK[t] < TIER_RANK[tier]).sort((a, b) => TIER_RANK[b] - TIER_RANK[a])) {
      add(routing[lower].routes[task], lower);
      for (const r of routing[lower].fallback) add(r, lower);
    }
    return out;
  }

  async complete(
    businessId: string,
    agent: AgentKey,
    req: AiRequest,
    ref: { conversationId?: string; taskId?: string } = {},
    opts: { task?: AiTaskType } = {},
  ): Promise<AiResponse> {
    const task = opts.task ?? taskTypeFor(agent);
    const tier = await this.tierOf(businessId);
    const chain = this.chainFor(await this.currentRouting(), tier, task);
    let lastError: unknown = null;
    for (const [i, step] of chain.entries()) {
      const provider = this.providers[step.route.provider];
      if (!provider) continue;
      try {
        const res = await provider.complete(req, step.route.model);
        await this.log(businessId, agent, ref, { provider: provider.name, tier: step.tier, task, failover: i > 0, res });
        if (i > 0) logger.warn(`AI failover for business ${businessId}: served by ${provider.name}/${res.model} after ${i} failed attempt(s)`, 'AI');
        return res;
      } catch (e) {
        lastError = e;
        logger.warn(`AI attempt failed (${step.route.provider}/${step.route.model}, ${tier}/${task}): ${(e as Error).message}`, 'AI');
        await this.log(businessId, agent, ref, { provider: step.route.provider, tier: step.tier, task, failover: i > 0, model: step.route.model, error: (e as Error).message }).catch(() => undefined);
      }
    }
    throw new AiUnavailableError(`Orbit could not reach any AI provider (${(lastError as Error)?.message ?? 'no route'})`);
  }

  private async log(
    businessId: string,
    agent: AgentKey,
    ref: { conversationId?: string; taskId?: string },
    o: { provider: string; tier: AiTier; task: AiTaskType; failover: boolean; res?: AiResponse; model?: string; error?: string },
  ) {
    const usage = o.res?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const model = o.res?.model ?? o.model ?? 'unknown';
    const cost = o.res ? costOf(model, usage) : 0;
    await this.db.withTenant(businessId, async (tx) => {
      await tx.q(
        `INSERT INTO ai_usage (agent_key, model, conversation_id, task_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, stop_reason, provider, tier, task_type, failover, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [agent, model, o.error ? null : ref.conversationId ?? null, ref.taskId ?? null, usage.input, usage.output, usage.cacheRead, usage.cacheWrite, cost, o.res?.stopReason ?? null, o.provider, o.tier, o.task, o.failover, o.error?.slice(0, 500) ?? null],
      );
      if (o.res) {
        await tx.q(
          `INSERT INTO usage_counters (period, ai_messages, ai_cost) VALUES (to_char(now(), 'YYYY-MM'), 1, $1)
           ON CONFLICT (business_id, period) DO UPDATE SET ai_messages = usage_counters.ai_messages + 1, ai_cost = usage_counters.ai_cost + EXCLUDED.ai_cost`,
          [cost],
        );
      }
    });
  }
}
