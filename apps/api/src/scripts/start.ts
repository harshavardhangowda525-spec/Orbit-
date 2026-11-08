import { Client } from 'pg';
import { config, pgSsl } from '../config';
import { migrate } from './migrate';

/**
 * Production entry point (Docker / Render): apply migrations, optionally add the
 * two demo businesses once (SEED_DEMO=true, only if they are not there yet),
 * then start the API.
 */
async function start() {
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
