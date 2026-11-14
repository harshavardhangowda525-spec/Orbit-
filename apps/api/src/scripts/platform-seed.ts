import { DEFAULT_PLANS, TEMPLATES } from '@orbit/shared';
import type { Tx } from '../db/db.service';

/**
 * Base configuration every environment needs: plans and business-type templates.
 * Plans: inserts only what is missing. Templates: refreshed unless an admin edited them.
 */
export async function seedPlatform(tx: Tx) {
  for (const p of DEFAULT_PLANS) {
    await tx.q(
      // Built-in plans follow the latest defaults until an admin edits them (updated_by set).
      `INSERT INTO plans (code, name, prices, limits, features, sort_order) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, prices = EXCLUDED.prices, limits = EXCLUDED.limits, features = EXCLUDED.features, sort_order = EXCLUDED.sort_order
       WHERE plans.updated_by IS NULL`,
      [p.code, p.name, JSON.stringify(p.prices), JSON.stringify(p.limits), JSON.stringify(p.features), p.sortOrder],
    );
  }
  // Plans that are no longer built in (e.g. the old "base") stay for history but are not offered.
  await tx.q(`UPDATE plans SET active = false WHERE code <> ALL($1::text[]) AND updated_by IS NULL AND active`, [DEFAULT_PLANS.map((p) => p.code)]);
  for (const t of Object.values(TEMPLATES)) {
    // Templates an admin never edited follow the latest built-in version; edited ones are left alone.
    await tx.q(
      `INSERT INTO business_templates (type, content) VALUES ($1, $2)
       ON CONFLICT (type) DO UPDATE SET content = EXCLUDED.content WHERE business_templates.updated_by IS NULL`,
      [t.type, JSON.stringify(t)],
    );
  }
}
