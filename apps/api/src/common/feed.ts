import type { AgentKey, Sentence } from '@orbit/shared';
import type { Tx } from '../db/db.service';
import { liveToBusiness } from '../realtime/live';
import { recordTrace, type TraceInput } from '../trust/trace';

/**
 * Post an event to the Orbit Feed (and push it live to The Bridge).
 * Must be called inside withTenant (business_id comes from the context).
 */
export async function postFeed(
  tx: Tx,
  agent: AgentKey,
  eventType: string,
  sentence: Sentence,
  opts: { entityType?: string; entityId?: string; valueAmount?: number; minutesSaved?: number; at?: Date; channel?: string; trace?: TraceInput | string | null } = {},
) {
  // The reasons for the action ("Why?"): recorded now, or an id recorded earlier (e.g. when it was held).
  const traceId = typeof opts.trace === 'string' ? opts.trace : opts.trace ? await recordTrace(tx, opts.trace) : null;
  const row = await tx.one(
    `INSERT INTO feed_events (agent_key, event_type, sentence, entity_type, entity_id, value_amount, minutes_saved, at, channel, trace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, now()), $9, $10) RETURNING id, at`,
    [agent, eventType, JSON.stringify(sentence), opts.entityType ?? null, opts.entityId ?? null, opts.valueAmount ?? 0, opts.minutesSaved ?? 0, opts.at ?? null, opts.channel ?? null, traceId],
  );
  liveToBusiness(tx, { type: 'feed.new', data: { id: row.id } });
  liveToBusiness(tx, { type: 'stats.changed' });
  return { ...row, traceId } as { id: string; at: Date; traceId: string | null };
}

/** Record live activity for an agent (drives the ticker and agent pings). Returns the task id. */
export async function startActivity(tx: Tx, agent: AgentKey, goal: string, activity: Sentence, inputs: Record<string, unknown> = {}) {
  const t = await tx.one(
    `INSERT INTO tasks (agent_key, created_by_kind, goal, inputs, status, activity, started_at, attempts)
     VALUES ($1, 'system', $2, $3, 'running', $4, now(), 1) RETURNING id`,
    [agent, goal, JSON.stringify(inputs), JSON.stringify(activity)],
  );
  liveToBusiness(tx, { type: 'task.status', data: { id: t.id, agent, status: 'running' } });
  return t.id as string;
}

export async function finishActivity(tx: Tx, taskId: string, status: 'done' | 'failed', result: unknown = null, error?: string) {
  const t = await tx.one(
    `UPDATE tasks SET status = $2, result = $3, error = $4, finished_at = now() WHERE id = $1 RETURNING agent_key`,
    [taskId, status, JSON.stringify(result), error ?? null],
  );
  if (t) liveToBusiness(tx, { type: 'task.status', data: { id: taskId, agent: t.agent_key, status } });
}
