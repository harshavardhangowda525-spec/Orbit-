import { execSync } from 'node:child_process';
import { Client } from 'pg';

/**
 * Fresh sample data for every run: re-seed Glow Studio / IronCore Gym (owners log in
 * with SEED_PASSWORD) and remove businesses left by earlier onboarding runs.
 * Uses the local development database; never point this at production.
 */
export default async function globalSetup() {
  const url = process.env.DATABASE_MIGRATION_URL ?? 'postgres://orbit_migrator:orbit_migrator_dev@localhost:5432/orbit';
  if (/prod/i.test(url)) throw new Error('Refusing to reset a production-looking database');
  execSync('npm run db:seed', { cwd: `${__dirname}/../../..`, stdio: 'ignore' });
  const c = new Client({ connectionString: url });
  await c.connect();
  // Businesses made by the onboarding test on earlier runs.
  await c.query(`DELETE FROM businesses WHERE slug ~ '^(sunrise-salon|peak-fitness)'`);
  await c.end();
  // Public pages are cached for 60 s; give the web server a clean start by asking it once.
  await fetch(`${process.env.WEB_URL ?? 'http://localhost:3000'}/glow-studio`).catch(() => undefined);
}
