import type { LoggerService } from '@nestjs/common';
import { currentContext } from './context';

/** Structured JSON logger. Every line includes requestId, businessId and userId when known. */
export class JsonLogger implements LoggerService {
  private write(level: string, message: unknown, context?: string, extra?: Record<string, unknown>) {
    if (process.env.LOG_SILENT === 'true' && level !== 'error') return;
    const ctx = currentContext();
    const line = {
      level,
      time: new Date().toISOString(),
      msg: typeof message === 'string' ? message : JSON.stringify(message),
      context,
      requestId: ctx?.requestId,
      business_id: ctx?.businessId,
      user_id: ctx?.userId,
      ...extra,
    };
    (level === 'error' ? process.stderr : process.stdout).write(JSON.stringify(line) + '\n');
  }
  log(message: unknown, context?: string) {
    this.write('info', message, context);
  }
  error(message: unknown, trace?: string, context?: string) {
    this.write('error', message, context, trace ? { trace } : undefined);
  }
  warn(message: unknown, context?: string) {
    this.write('warn', message, context);
  }
  debug(message: unknown, context?: string) {
    if (process.env.LOG_DEBUG === 'true') this.write('debug', message, context);
  }
  verbose(message: unknown, context?: string) {
    this.debug(message, context);
  }
}

export const logger = new JsonLogger();
