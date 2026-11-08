import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { ThrottlerException } from '@nestjs/throttler';
import { logger } from '../logger';

/** Every error becomes { error: { code, message } } in plain language. Internals are logged, never shown. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof ThrottlerException) {
      return res.status(429).json({ error: { code: 'too_many_requests', message: 'Too many tries. Please wait a minute and try again.' } });
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse() as any;
      if (body && typeof body === 'object' && body.error?.code) return res.status(status).json(body);
      const message = status === 401 ? 'Please sign in again.' : status === 404 ? 'We could not find that.' : 'Something was not right with that request.';
      const code = status === 401 ? 'unauthorized' : status === 404 ? 'not_found' : 'bad_request';
      return res.status(status).json({ error: { code, message } });
    }
    logger.error(exception instanceof Error ? exception.message : String(exception), exception instanceof Error ? exception.stack : undefined, 'Unhandled');
    return res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong on our side. Please try again.' } });
  }
}
