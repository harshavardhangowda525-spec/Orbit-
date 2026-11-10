import { Client } from 'pg';

/** Reset the test database to a clean, fully migrated state once per test run. */
export default async function globalSetup() {
  require('./env');
  const url = process.env.DATABASE_MIGRATION_URL!;
  const c = new Client({ connectionString: url });
  await c.connect();
  const tables = (await c.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user`)).rows;
  if (tables.length) await c.query(`DROP TABLE ${tables.map((r) => `"${r.t}"`).join(', ')} CASCADE`);
  await c.query(`DROP FUNCTION IF EXISTS set_updated_at() CASCADE; DROP FUNCTION IF EXISTS app_current_business() CASCADE; DROP FUNCTION IF EXISTS invoices_locked() CASCADE;`);
  await c.end();
  const { migrate } = require('../src/scripts/migrate');
  await migrate(url, true);
}
