import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { config } from '../config';
import { Tx } from '../db/db.service';
import { seedPlatform } from './platform-seed';

/** Applies migrations/*.sql in order, once each, then seeds base plans and templates. */
export async function migrate(url = config.databaseMigrationUrl, quiet = false) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query<{ name: string }>(`SELECT name FROM schema_migrations`)).rows.map((r) => r.name));
    const dir = join(__dirname, '..', '..', 'migrations');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
        await client.query('COMMIT');
        if (!quiet) console.log(`applied ${file}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
      }
    }
    await client.query('BEGIN');
    await seedPlatform(new Tx(client as any));
    await client.query('COMMIT');
    if (!quiet) console.log('plans and templates ready');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  migrate().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
