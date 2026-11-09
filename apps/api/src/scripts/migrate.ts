import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { config, pgSsl } from '../config';
import { Tx } from '../db/db.service';
import { seedPlatform } from './platform-seed';

/** Applies migrations/*.sql in order, once each, then seeds base plans and templates. */
export async function migrate(url = config.databaseMigrationUrl, quiet = false) {
  const client = new Client({ connectionString: url, ssl: pgSsl() });
  await client.connect();
  try {
    // Say plainly which database user this is and whether it may create tables (the usual hosting mistake).
    const who = (await client.query<{ u: string; can: boolean }>(`SELECT current_user AS u, has_schema_privilege(current_user, 'public', 'CREATE') AS can`)).rows[0];
    if (!who.can) {
      throw new Error(
        `DATABASE_MIGRATION_URL connects as "${who.u}", which cannot create tables. ` +
          (who.u === 'orbit_migrator'
            ? 'Run infra/db/supabase-setup.sql again (GRANT USAGE, CREATE ON SCHEMA public TO orbit_migrator).'
            : 'It must use the orbit_migrator user (postgresql://orbit_migrator.<project>:...@...:5432/postgres).'),
      );
    }
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
