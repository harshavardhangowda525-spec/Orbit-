import { execSync } from 'node:child_process';
import { Client } from 'pg';

/**
 * Fresh sample data for every run: re-seed Glow Studio / IronCore Gym and clear
 * sign-in code history (the API allows 5 codes per number per hour).
 * Uses the local development database; never point this at production.
 */
export default async function globalSetup() {
  const url = process.env.DATABASE_MIGRATION_URL ?? 'postgres://orbit_migrator:orbit_migrator_dev@localhost:5432/orbit';
  if (/prod/i.test(url)) throw new Error('Refusing to reset a production-looking database');
  execSync('npm run db:seed', { cwd: `${__dirname}/../../..`, stdio: 'ignore' });
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query(`DELETE FROM otp_codes WHERE phone LIKE '+9198000000%' OR created_at > now() - interval '2 hours'`);
  await c.end();
  // Public pages are cached for 60 s; give the web server a clean start by asking it once.
  await fetch(`${process.env.WEB_URL ?? 'http://localhost:3000'}/glow-studio`).catch(() => undefined);
}
