import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { requestContext } from '../context';
import { logger } from '../logger';

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction) {
  const requestId = (req.headers['x-request-id'] as string) || randomUUID();
  res.setHeader('x-request-id', requestId);
  const started = Date.now();
  requestContext.run({ requestId }, () => {
    res.on('finish', () => {
      logger.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms`, 'HTTP');
    });
    next();
  });
}
