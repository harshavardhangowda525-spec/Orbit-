import type { Tx } from '../db/db.service';

/**
 * Keeps the Crew in line with the plan after a plan change: agents the new plan
 * unlocks are switched on; agents it no longer includes are switched off (so,
 * for example, Nudge stops sending after a downgrade to Free). Agents that were
 * on both plans keep whatever the owner chose.
 */
export async function syncCrewToPlan(tx: Tx, businessId: string, oldPlanId: string | null, newPlanId: string) {
  if (oldPlanId === newPlanId) return;
  await tx.q(
    `WITH p AS (
       SELECT (SELECT features->'agents' FROM plans WHERE id = $2) AS old_agents, (SELECT features->'agents' FROM plans WHERE id = $3) AS new_agents
     )
     UPDATE agents a SET enabled = CASE
         WHEN NOT (p.new_agents ? a.agent_key) THEN false
         WHEN NOT COALESCE(p.old_agents ? a.agent_key, false) THEN true
         ELSE a.enabled END
     FROM p WHERE a.business_id = $1 AND a.agent_key <> 'orbit'`,
    [businessId, oldPlanId, newPlanId],
  );
}
