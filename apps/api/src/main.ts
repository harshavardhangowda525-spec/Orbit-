import 'reflect-metadata';
import { createApp } from './app.factory';
import { config } from './config';
import { logger } from './logger';
import { attachWebSockets } from './realtime/ws.gateway';
import { JobsService } from './jobs/jobs.service';

async function main() {
  const app = await createApp();
  app.enableShutdownHooks();
  await app.listen(config.port);
  attachWebSockets(app, app.getHttpServer());
  if (process.env.JOBS_ENABLED !== 'false') {
    await app.get(JobsService).start([{ name: 'briefing.sweep', everyMs: 15 * 60_000 }, { name: 'powers.gmail_poll', everyMs: 5 * 60_000 }, { name: 'powers.outlook_poll', everyMs: 5 * 60_000 }, { name: 'ledger.reminders', everyMs: 60 * 60_000 }, { name: 'ledger.sync_links', everyMs: 30 * 60_000 }, { name: 'ledger.deposit_expiry', everyMs: 10 * 60_000 }, { name: 'nudge.renewals', everyMs: 6 * 60 * 60_000 }]);
  }
  logger.log(`Orbit API listening on :${config.port}`, 'Main');
}

main().catch((e) => {
  logger.error(e instanceof Error ? e.message : String(e), e instanceof Error ? e.stack : undefined, 'Main');
  process.exit(1);
});
