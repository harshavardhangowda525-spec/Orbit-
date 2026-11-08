import { DEFAULT_PLANS, TEMPLATES } from '@orbit/shared';
import type { Tx } from '../db/db.service';

/**
 * Base configuration every environment needs: plans and business-type templates.
 * Inserts only what is missing, so admin edits are never overwritten.
 */
export async function seedPlatform(tx: Tx) {
  for (const p of DEFAULT_PLANS) {
    await tx.q(
      `INSERT INTO plans (code, name, prices, limits, features, sort_order) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (code) DO NOTHING`,
      [p.code, p.name, JSON.stringify(p.prices), JSON.stringify(p.limits), JSON.stringify(p.features), p.sortOrder],
    );
  }
  for (const t of Object.values(TEMPLATES)) {
    await tx.q(`INSERT INTO business_templates (type, content) VALUES ($1, $2) ON CONFLICT (type) DO NOTHING`, [t.type, JSON.stringify(t)]);
  }
}
