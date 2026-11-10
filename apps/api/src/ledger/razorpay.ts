import { createHmac, timingSafeEqual } from 'node:crypto';

/** Razorpay payment links for a business's own Razorpay account (its key id + secret). */
const API = 'https://api.razorpay.com/v1';

export interface RazorpayKeys {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

export class RazorpayError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call(keys: Pick<RazorpayKeys, 'keyId' | 'keySecret'>, path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { authorization: `Basic ${Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString('base64')}`, 'content-type': 'application/json' },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const d: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new RazorpayError(res.status, d?.error?.description ?? `Razorpay error ${res.status}`);
  return d;
}

/** A harmless read that fails with 401 for wrong keys. */
export async function checkKeys(keys: Pick<RazorpayKeys, 'keyId' | 'keySecret'>) {
  await call(keys, '/payment_links?count=1');
}

export interface LinkInput {
  amount: number; // rupees
  currency: string;
  description: string;
  reference: string;
  invoiceId: string;
  customer: { name?: string | null; contact?: string | null; email?: string | null };
  callbackUrl: string;
}

export async function createLink(keys: RazorpayKeys, l: LinkInput): Promise<{ id: string; url: string }> {
  const d = await call(keys, '/payment_links', {
    body: {
      amount: Math.round(l.amount * 100),
      currency: l.currency,
      accept_partial: false,
      reference_id: l.reference.slice(0, 40),
      description: l.description.slice(0, 2048),
      customer: Object.fromEntries(Object.entries({ name: l.customer.name, contact: l.customer.contact, email: l.customer.email }).filter(([, v]) => v)),
      // Orbit sends the message itself (WhatsApp/SMS/email), so Razorpay does not.
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { orbit_invoice_id: l.invoiceId },
      callback_url: l.callbackUrl,
      callback_method: 'get',
    },
  });
  return { id: d.id, url: d.short_url };
}

export async function getLink(keys: RazorpayKeys, id: string): Promise<{ status: string; amountPaid: number; paymentId: string | null; method: string | null }> {
  const d = await call(keys, `/payment_links/${encodeURIComponent(id)}`);
  const p = (d.payments ?? []).find((x: any) => x.status === 'captured') ?? d.payments?.[0];
  return { status: d.status, amountPaid: (d.amount_paid ?? 0) / 100, paymentId: p?.payment_id ?? null, method: p?.method ?? null };
}

export async function cancelLink(keys: RazorpayKeys, id: string) {
  await call(keys, `/payment_links/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
}

/** X-Razorpay-Signature = hex HMAC-SHA256(webhook secret, raw body). */
export function validWebhook(raw: Buffer | undefined, signature: string | undefined, secret: string): boolean {
  if (!raw || !signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  const got = Buffer.from(signature, 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}
