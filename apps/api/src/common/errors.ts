import { HttpException } from '@nestjs/common';

/** Plain-language error with a stable code the web app can translate. */
export class AppError extends HttpException {
  /** `details` go alongside the code and message (e.g. the bill a duplicate matches). */
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super({ error: { code, message, ...(details ?? {}) } }, status);
  }
}

export const notFound = (message = 'We could not find that.') => new AppError(404, 'not_found', message);
export const forbidden = (message = 'You do not have access to this.') => new AppError(403, 'forbidden', message);
export const badRequest = (code: string, message: string) => new AppError(400, code, message);
