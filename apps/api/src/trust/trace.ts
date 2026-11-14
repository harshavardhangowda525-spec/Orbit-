import type { DecisionTrace, Sentence, TraceFact } from '@orbit/shared';
import type { Tx } from '../db/db.service';

/** A decision trace as recorded at the moment of the action (see packages/shared/src/trust.ts). */
export type TraceInput = Omit<DecisionTrace, 'id' | 'createdAt' | 'customer'> & { taskId?: string | null; customerId?: string | null };

/** Store the real reasons for an action. Must run inside withTenant. Returns the trace id. */
export async function recordTrace(tx: Tx, t: TraceInput): Promise<string> {
  const r = await tx.one(
    `INSERT INTO decision_traces (agent_key, task_id, customer_id, action, trigger, rule, facts, alternatives, approver)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      t.agent, t.taskId ?? null, t.customerId ?? null, JSON.stringify(t.action), JSON.stringify(t.trigger), t.rule ? JSON.stringify(t.rule) : null,
      JSON.stringify(t.facts ?? []), JSON.stringify(t.alternatives ?? []), JSON.stringify(t.approver ?? { kind: 'not_needed' }),
    ],
  );
  return r.id as string;
}

/** The agent's name as the owner sees it (they may have renamed it). */
export async function agentName(tx: Tx, key: string): Promise<string> {
  const a = await tx.one(`SELECT display_name FROM agents WHERE agent_key = $1`, [key]);
  return a?.display_name ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/** Has the owner said "Don't do this again for {customer}" for this rule? */
export async function hasException(tx: Tx, customerId: string | null | undefined, ruleCode: string): Promise<boolean> {
  if (!customerId) return false;
  return !!(await tx.one(`SELECT 1 FROM customer_exceptions WHERE customer_id = $1 AND action_code = $2`, [customerId, ruleCode]));
}

export const fact = (code: string, key: string, params: Sentence['params'] = {}, ref?: TraceFact['ref']): TraceFact => ({ code, text: { key, params }, ...(ref ? { ref } : {}) });
export const firstName = (c: { name?: string | null; phone?: string | null } | null | undefined) => (c?.name ?? '').split(' ')[0] || c?.phone || '—';
