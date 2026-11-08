import { PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';
import { AppError } from './errors';

export class ZodPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodSchema<T>) {}
  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      // Plain language for the owner: name the field, never the validator's wording.
      const first = r.error.issues[0];
      const field = (first?.path ?? []).filter((p) => typeof p === 'string').map((p) => String(p).replace(/([A-Z])/g, ' $1').toLowerCase()).pop();
      throw new AppError(400, 'invalid_input', field ? `Please check the ${field}.` : 'Please check the details and try again.');
    }
    return r.data;
  }
}
