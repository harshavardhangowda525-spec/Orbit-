import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { config } from './config';
import { logger } from './logger';
import { AllExceptionsFilter } from './common/exception.filter';
import { requestContextMiddleware } from './common/request-context.middleware';

export function configureApp(app: NestExpressApplication) {
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(requestContextMiddleware);
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableCors({ origin: config.webOrigins, allowedHeaders: ['authorization', 'content-type', 'x-business-id', 'x-request-id', 'x-visitor-token', 'x-admin-session'], exposedHeaders: ['content-disposition'] });
  // Keep the raw bytes too: Meta signs webhook bodies (X-Hub-Signature-256).
  app.useBodyParser('json', { limit: '256kb', verify: (req: any, _res: unknown, buf: Buffer) => { req.rawBody = buf; } });
  return app;
}

export async function createApp() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger, bodyParser: false });
  return configureApp(app);
}
