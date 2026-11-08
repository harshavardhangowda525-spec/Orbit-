import 'reflect-metadata';
import { createApp } from './app.factory';
import { config } from './config';
import { logger } from './logger';

async function main() {
  const app = await createApp();
  app.enableShutdownHooks();
  await app.listen(config.port);
  logger.log(`Orbit API listening on :${config.port}`, 'Main');
}

main().catch((e) => {
  logger.error(e instanceof Error ? e.message : String(e), e instanceof Error ? e.stack : undefined, 'Main');
  process.exit(1);
});
