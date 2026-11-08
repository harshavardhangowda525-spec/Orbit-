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
  app.enableCors({ origin: config.webOrigins, allowedHeaders: ['authorization', 'content-type', 'x-business-id', 'x-request-id'] });
  app.useBodyParser('json', { limit: '256kb' });
  return app;
}

export async function createApp() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger, bodyParser: false });
  return configureApp(app);
}
