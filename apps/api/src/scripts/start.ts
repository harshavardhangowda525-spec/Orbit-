import { Client } from 'pg';
import { config, pgSsl } from '../config';
import { migrate } from './migrate';

/**
 * Production entry point (Docker / Render): apply migrations, optionally add the
 * two demo businesses once (SEED_DEMO=true, only if they are not there yet),
 * then start the API.
 */
/** Names the setting that is wrong (never its value: it holds a password). */
function checkUrls() {
  const problems: string[] = [];
  const check = (name: string, protocols: string[], required: boolean) => {
    const v = process.env[name];
    if (!v) {
      if (required) problems.push(`${name} is not set.`);
      return;
    }
    if (/[<>]/.test(v)) return problems.push(`${name} still contains a placeholder like <ref> or <pooler-host>. Replace it with the real value from Supabase.`);
    if (/\s/.test(v)) return problems.push(`${name} contains a space. Paste it again without spaces or line breaks.`);
    try {
      const u = new URL(v);
      if (!protocols.includes(u.protocol)) problems.push(`${name} should start with ${protocols.map((x) => `${x}//`).join(' or ')}.`);
    } catch {
      problems.push(`${name} is not a valid address. Check for missing parts, or special characters in the password (use letters and numbers only).`);
    }
  };
  const hosted = process.env.NODE_ENV === 'production';
  for (const n of ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'DATABASE_MIGRATION_URL']) check(n, ['postgres:', 'postgresql:'], hosted);
  check('REDIS_URL', ['redis:', 'rediss:'], false);
  for (const n of ['SUPABASE_URL', 'SUPABASE_JWKS_URL', 'WEB_BASE_URL', 'PUBLIC_BASE_URL']) check(n, ['https:', 'http:'], false);
  for (const o of (process.env.WEB_ORIGIN ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    if (!/^https?:\/\/[^/\s]+$/.test(o)) problems.push(`WEB_ORIGIN should be just the web address, like https://orbit-web-xxxx.onrender.com (no path or trailing slash).`);
  }
  if (problems.length) throw new Error(`Settings need fixing in Render (orbit-api → Environment):\n - ${problems.join('\n - ')}`);
}

async function start() {
  checkUrls();
  await migrate(config.databaseMigrationUrl);
  if (process.env.SEED_DEMO === 'true') {
    const c = new Client({ connectionString: config.databaseMigrationUrl, ssl: pgSsl() });
    await c.connect();
    const exists = await c.query(`SELECT 1 FROM businesses WHERE slug = 'glow-studio'`);
    await c.end();
    if (!exists.rowCount) {
      const { seed } = require('./seed');
      await seed(config.databaseMigrationUrl);
      console.log('Demo businesses added (Glow Studio, IronCore Gym).');
    }
  }
  require('../main');
}

start().catch((e) => {
  console.error(`Startup failed: ${e.message}`);
  process.exit(1);
});
