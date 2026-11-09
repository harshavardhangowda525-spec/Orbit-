import { Injectable } from '@nestjs/common';
import type { AgentKey } from '@orbit/shared';
import { DbService } from '../db/db.service';
import { runtime } from '../config';
import { ClaudeProvider, costOf, type AiProvider, type AiRequest, type AiResponse } from './provider';
import { FakeProvider } from './fake.provider';
import { GroqProvider } from './groq.provider';
import { logger } from '../logger';

/**
 * The single entry point for LLM calls. Picks the provider and records tokens
 * and cost per business and per agent (ai_usage + usage_counters).
 */
@Injectable()
export class AiService {
  readonly provider: AiProvider;
  constructor(private readonly db: DbService) {
    const p = runtime.aiProvider;
    if (!['claude', 'groq', 'fake'].includes(p)) logger.warn(`Unknown AI_PROVIDER "${p}"; using claude. Valid values: claude, groq, fake.`, 'AI');
    this.provider = p === 'fake' ? new FakeProvider() : p === 'groq' ? new GroqProvider() : new ClaudeProvider();
    logger.log(`AI provider: ${this.provider.name}`, 'AI');
  }

  get fake(): FakeProvider | null {
    return this.provider instanceof FakeProvider ? this.provider : null;
  }

  async complete(businessId: string, agent: AgentKey, req: AiRequest, ref: { conversationId?: string; taskId?: string } = {}): Promise<AiResponse> {
    const res = await this.provider.complete(req);
    const cost = costOf(res.model, res.usage);
    await this.db.withTenant(businessId, async (tx) => {
      await tx.q(
        `INSERT INTO ai_usage (agent_key, model, conversation_id, task_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, stop_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [agent, res.model, ref.conversationId ?? null, ref.taskId ?? null, res.usage.input, res.usage.output, res.usage.cacheRead, res.usage.cacheWrite, cost, res.stopReason],
      );
      await tx.q(
        `INSERT INTO usage_counters (period, ai_messages, ai_cost) VALUES (to_char(now(), 'YYYY-MM'), 1, $1)
         ON CONFLICT (business_id, period) DO UPDATE SET ai_messages = usage_counters.ai_messages + 1, ai_cost = usage_counters.ai_cost + EXCLUDED.ai_cost`,
        [cost],
      );
    });
    return res;
  }
}
