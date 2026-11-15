import type { Sentence } from '@orbit/shared';
import type { Tx } from '../db/db.service';
import { badRequest, notFound } from '../common/errors';
import { liveToBusiness } from '../realtime/live';

/**
 * Settings and knowledge changes keep their previous version for 24 hours so the
 * owner can undo them (Teach changes will use the same table). Only these columns
 * are ever written back.
 */
const ENTITIES = {
  agent: { table: 'agents', key: 'agent_key', cols: ['enabled', 'display_name', 'personality', 'auto_approval_rules'] },
  knowledge_item: { table: 'knowledge_items', key: 'id', cols: ['type', 'title', 'content', 'active', 'deleted_at'] },
  profile: { table: 'business_profiles', key: 'business_id', cols: ['review_url', 'hold_seconds', 'review_before_send'] },
  expense: { table: 'expenses', key: 'id', cols: ['category', 'total', 'bill_date', 'vendor_name', 'status', 'deleted_at'] },
  revenue_entry: { table: 'revenue_entries', key: 'id', cols: ['amount', 'mode', 'entry_date', 'note', 'deleted_at'] },
} as const;
export type VersionedEntity = keyof typeof ENTITIES;
const JSON_COLS = new Set(['auto_approval_rules', 'hold_seconds', 'review_before_send']);

/** Current values of the versioned columns (null if the row does not exist). */
export async function snapshot(tx: Tx, entity: VersionedEntity, id: string) {
  const e = ENTITIES[entity];
  return tx.one(`SELECT ${e.cols.join(', ')} FROM ${e.table} WHERE ${e.key} = $1`, [id]);
}

export async function recordVersion(
  tx: Tx,
  v: { entity: VersionedEntity; id: string; label: Sentence; before: unknown; after: unknown; by?: string | null; source?: 'settings' | 'teach' },
) {
  if (JSON.stringify(v.before) === JSON.stringify(v.after)) return null;
  const r = await tx.one(
    `INSERT INTO field_versions (entity_type, entity_id, label, before, after, source, changed_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [v.entity, v.id, JSON.stringify(v.label), v.before == null ? null : JSON.stringify(v.before), v.after == null ? null : JSON.stringify(v.after), v.source ?? 'settings', v.by ?? null],
  );
  liveToBusiness(tx, { type: 'changes.updated' });
  return r.id as string;
}

/** Undo a change within 24 hours: the thing goes back exactly as it was. */
export async function revertVersion(tx: Tx, id: string, userId: string | null) {
  const v = await tx.one(`SELECT * FROM field_versions WHERE id = $1 FOR UPDATE`, [id]);
  if (!v) throw notFound();
  if (v.reverted_at) return { ok: true, already: true };
  if (new Date(v.undo_until) < new Date()) throw badRequest('too_late', 'Changes can be undone for 24 hours. This one is older.');
  const newer = await tx.one(
    `SELECT 1 FROM field_versions WHERE entity_type = $1 AND entity_id = $2 AND id <> $3 AND reverted_at IS NULL AND created_at > (SELECT created_at FROM field_versions WHERE id = $3)`,
    [v.entity_type, v.entity_id, v.id],
  );
  if (newer) throw badRequest('newer_change', 'This was changed again after that. Undo the newer change first.');
  const e = ENTITIES[v.entity_type as VersionedEntity];
  if (!e) throw badRequest('cannot_undo', 'This change cannot be undone.');
  if (v.before == null) {
    // The change created it (a new FAQ, bill or sale): undoing removes it.
    if (v.entity_type === 'knowledge_item') await tx.q(`UPDATE knowledge_items SET deleted_at = now() WHERE id = $1`, [v.entity_id]);
    else if (v.entity_type === 'expense') await tx.q(`UPDATE expenses SET status = 'deleted', deleted_at = now() WHERE id = $1`, [v.entity_id]);
    else if (v.entity_type === 'revenue_entry') await tx.q(`UPDATE revenue_entries SET deleted_at = now() WHERE id = $1`, [v.entity_id]);
    else throw badRequest('cannot_undo', 'This change cannot be undone.');
  } else {
    const cols = e.cols.filter((c) => c in v.before);
    const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    const vals = cols.map((c) => (JSON_COLS.has(c) && v.before[c] != null ? JSON.stringify(v.before[c]) : v.before[c]));
    const r = await tx.one(`UPDATE ${e.table} SET ${sets} WHERE ${e.key} = $1 RETURNING 1 AS ok`, [v.entity_id, ...vals]);
    if (!r) throw notFound('That no longer exists.');
  }
  await tx.q(`UPDATE field_versions SET reverted_at = now(), reverted_by = $2 WHERE id = $1`, [id, userId]);
  liveToBusiness(tx, { type: 'changes.updated' });
  liveToBusiness(tx, { type: 'stats.changed' });
  return { ok: true };
}

export async function recentChanges(tx: Tx) {
  return tx.q(
    `SELECT id, entity_type AS entity, label, source, created_at AS "createdAt", undo_until AS "undoUntil", reverted_at AS "revertedAt"
     FROM field_versions WHERE created_at > now() - interval '24 hours' ORDER BY created_at DESC LIMIT 20`,
  );
}
