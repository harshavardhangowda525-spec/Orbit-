import { AsyncLocalStorage } from 'node:async_hooks';

/** Per-request context, so every log line can carry business_id and user_id. */
export interface RequestContext {
  requestId: string;
  businessId?: string;
  userId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | undefined {
  return requestContext.getStore();
}
