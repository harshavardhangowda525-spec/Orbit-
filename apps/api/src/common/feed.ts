import type { AgentKey, Sentence } from '@orbit/shared';
import type { Tx } from '../db/db.service';

/** Post an event to the Orbit Feed. Must be called inside withTenant (business_id comes from the context). */
export async function postFeed(
  tx: Tx,
  agent: AgentKey,
  eventType: string,
  sentence: Sentence,
  opts: { entityType?: string; entityId?: string; valueAmount?: number; minutesSaved?: number; at?: Date } = {},
) {
  await tx.q(
    `INSERT INTO feed_events (agent_key, event_type, sentence, entity_type, entity_id, value_amount, minutes_saved, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, now()))`,
    [agent, eventType, JSON.stringify(sentence), opts.entityType ?? null, opts.entityId ?? null, opts.valueAmount ?? 0, opts.minutesSaved ?? 0, opts.at ?? null],
  );
}
