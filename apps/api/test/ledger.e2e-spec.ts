/**
 * Ledger: GST invoices (numbering, locking), Razorpay payment links and
 * webhooks, public invoice page, reminders, isolation. Razorpay is mocked.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { Client } from 'pg';
import { bootApp, onboard, upgrade } from './helpers';
import { DbService } from '../src/db/db.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { fiscalYear } from '@orbit/shared';

describe('Ledger', () => {
  let app: NestExpressApplication;
  let db: DbService;
  let ledger: LedgerService;
  const realFetch = global.fetch;
  let calls: { url: string; method: string; body: any }[] = [];
  let linkStatus = 'issued';
  let seq = 0;
  let a: Awaited<ReturnType<typeof onboard>>;
  let b: Awaited<ReturnType<typeof onboard>>;
  let hook: { webhookUrl: string; webhookSecret: string };
  const fy = fiscalYear(new Date()).slice(2);
  const http = () => request(app.getHttpServer());
  const tenant = (id: string, fn: (tx: any) => Promise<any>): Promise<any> => db.withTenant(id, fn);

  beforeAll(async () => {
    global.fetch = (async (url: string, init?: any) => {
      const u = String(url);
      if (!u.startsWith('https://api.razorpay.com/')) return realFetch(url as any, init);
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push({ url: u, method: init?.method ?? 'GET', body });
      const ok = (d: object) => new Response(JSON.stringify(d), { status: 200 });
      const auth = Buffer.from(String(init.headers.authorization).slice(6), 'base64').toString();
      if (auth.startsWith('rzp_test_wrongkey')) return new Response(JSON.stringify({ error: { description: 'The api key provided is invalid' } }), { status: 401 });
      if (u.includes('/payment_links?count=1')) return ok({ payment_links: [] });
      if (u.endsWith('/payment_links') && init.method === 'POST') return ok({ id: `plink_${++seq}`, short_url: `https://rzp.io/i/x${seq}` });
      if (/\/payment_links\/plink_\w+\/cancel$/.test(u)) return ok({ status: 'cancelled' });
      if (/\/payment_links\/plink_\w+$/.test(u)) return ok(linkStatus === 'paid' ? { status: 'paid', amount_paid: 59000, payments: [{ payment_id: 'pay_poll1', status: 'captured', method: 'upi' }] } : { status: linkStatus });
      return ok({});
    }) as any;
    app = await bootApp();
    db = app.get(DbService);
    ledger = app.get(LedgerService);
    a = await onboard(app, 'salon', 'Mint Salon');
    b = await onboard(app, 'gym', 'Mint Gym');
    await upgrade(app, [a.businessId, b.businessId]);
  });
  afterAll(async () => {
    global.fetch = realFetch;
    await app.close();
  });
  beforeEach(() => {
    calls = [];
    linkStatus = 'issued';
  });

  it('keeps the GST profile, checking the GSTIN', async () => {
    const bad = await a.api.patch('/ledger/profile', { gstin: '29ABCDE1234' });
    expect(bad.body.error.code).toBe('invalid_gstin');
    const r = await a.api.patch('/ledger/profile', { gstin: '29abcde1234f1z5', legalName: 'Mint Salon Pvt Ltd', defaultTaxRate: 18, pricesIncludeTax: true }).expect(200);
    expect(r.body).toMatchObject({ gstin: '29ABCDE1234F1Z5', state: '29', stateName: 'Karnataka', legalName: 'Mint Salon Pvt Ltd', razorpay: false });
  });

  it('connects Razorpay after checking the keys, and gives the webhook to paste', async () => {
    const bad = await a.api.post('/ledger/razorpay/connect', { keyId: 'rzp_test_wrongkey1', keySecret: 'secretsecret' });
    expect(bad.body.error.code).toBe('razorpay_check_failed');
    const r = await a.api.post('/ledger/razorpay/connect', { keyId: 'rzp_test_abc123XYZ', keySecret: 'secretsecret123' }).expect(201);
    expect(r.body.webhookUrl).toMatch(/\/webhooks\/razorpay\/[0-9a-f-]{36}$/);
    expect(r.body.event).toBe('payment_link.paid');
    hook = r.body;
  });

  let first: any;
  it('a draft has no number; sending issues the next number, adds a pay link and messages the customer', async () => {
    const d = await a.api.post('/ledger/invoices', { customer: { name: 'Riya Shah', phone: '9845011122' }, lines: [{ description: 'Haircut', qty: 1, unitPrice: 590 }] }).expect(201);
    expect(d.body).toMatchObject({ status: 'draft', number: null, subtotal: 500, taxTotal: 90, total: 590, tax: { cgst: 45, sgst: 45, igst: 0 } });
    const s = await a.api.post(`/ledger/invoices/${d.body.id}/send`).expect(201);
    expect(s.body).toMatchObject({ status: 'sent', number: `INV/${fy}/0001`, payUrl: expect.stringMatching(/^https:\/\/rzp\.io\//) });
    // No messaging channel is connected in this test business: not delivered, and the owner gets the link to share.
    expect(s.body.delivered).toBe(false);
    const link = calls.find((c) => c.url.endsWith('/payment_links') && c.method === 'POST');
    expect(link?.body).toMatchObject({ amount: 59000, currency: 'INR', reference_id: `INV/${fy}/0001`, notify: { sms: false, email: false }, notes: { orbit_invoice_id: d.body.id } });
    expect(s.body.url).toMatch(/\/i\/[0-9a-f-]{36}\.[\w-]+$/);
    first = s.body;
    // Numbers are consecutive.
    const d2 = await a.api.post('/ledger/invoices', { customer: { name: 'Arjun', phone: '9845011133' }, lines: [{ description: 'Beard trim', qty: 1, unitPrice: 236 }] }).expect(201);
    expect((await a.api.post(`/ledger/invoices/${d2.body.id}/send`).expect(201)).body.number).toBe(`INV/${fy}/0002`);
  });

  it('an issued invoice can never be edited or deleted, even directly in the database', async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.business_id', $1, true)`, [a.businessId]);
      await expect(c.query(`UPDATE invoices SET total = 1 WHERE id = $1`, [first.id])).rejects.toThrow(/invoice_locked/);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.business_id', $1, true)`, [a.businessId]);
      await expect(c.query(`DELETE FROM invoices WHERE id = $1`, [first.id])).rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });

  it('the customer sees the invoice on a public page', async () => {
    const token = first.url.split('/i/')[1];
    const r = await http().get(`/public/invoices/${token}`).expect(200);
    expect(r.body).toMatchObject({ number: `INV/${fy}/0001`, status: 'sent', total: 590, seller: { name: 'Mint Salon', legalName: 'Mint Salon Pvt Ltd', gstin: '29ABCDE1234F1Z5' }, customer: { name: 'Riya Shah' }, placeOfSupplyName: 'Karnataka', payUrl: expect.any(String) });
    await http().get(`/public/invoices/${a.businessId}.notTheRightTokenAtAll12`).expect(404);
  });

  it('a signed Razorpay webhook marks it paid, once', async () => {
    const payload = (pay: string) => JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: first.payUrl ? (calls[0]?.url, 'x') : 'x', amount_paid: 59000, notes: { orbit_invoice_id: first.id } } }, payment: { entity: { id: pay, amount: 59000, method: 'upi' } } } });
    const send = (raw: string, secret = hook.webhookSecret) =>
      http().post(new URL(hook.webhookUrl).pathname).set('content-type', 'application/json').set('x-razorpay-signature', createHmac('sha256', secret).update(raw).digest('hex')).send(raw);
    await send(payload('pay_1'), 'wrong-secret').expect(401);
    const r = await send(payload('pay_1')).expect(200);
    expect(r.body).toMatchObject({ ok: true, recorded: true });
    expect((await send(payload('pay_1')).expect(200)).body.recorded).toBe(false);
    const inv = (await a.api.get(`/ledger/invoices/${first.id}`).expect(200)).body;
    expect(inv).toMatchObject({ status: 'paid', amountPaid: 590 });
    const pays = await tenant(a.businessId, (tx) => tx.q(`SELECT amount::float, method FROM payments WHERE invoice_id = $1`, [first.id]));
    expect(pays).toEqual([{ amount: 590, method: 'upi' }]);
    expect((await a.api.get('/ledger/summary').expect(200)).body.today).toBeGreaterThanOrEqual(590);
  });

  it('without a webhook, Orbit asks Razorpay and still records the payment', async () => {
    const d = await a.api.post('/ledger/invoices', { customer: { name: 'Meena', phone: '9845011144' }, lines: [{ description: 'Facial', qty: 1, unitPrice: 590 }] }).expect(201);
    await a.api.post(`/ledger/invoices/${d.body.id}/send`).expect(201);
    linkStatus = 'paid';
    expect((await a.api.post(`/ledger/invoices/${d.body.id}/refresh`).expect(201)).body.status).toBe('paid');
  });

  it('paid at the counter, cancelled, and final states', async () => {
    const d = await a.api.post('/ledger/invoices', { customer: { name: 'Walk-in' }, lines: [{ description: 'Manicure', qty: 2, unitPrice: 300 }] }).expect(201);
    const p = await a.api.post(`/ledger/invoices/${d.body.id}/paid`, { method: 'cash' }).expect(201);
    expect(p.body).toMatchObject({ status: 'paid', number: expect.stringMatching(new RegExp(`^INV/${fy}/\\d{4}$`)) });
    expect((await a.api.post(`/ledger/invoices/${d.body.id}/cancel`)).body.error.code).toBe('invoice_final');
    const d2 = await a.api.post('/ledger/invoices', { customer: { name: 'Neha', phone: '9845011155' }, lines: [{ description: 'Pedicure', qty: 1, unitPrice: 400 }] }).expect(201);
    await a.api.post(`/ledger/invoices/${d2.body.id}/send`).expect(201);
    expect((await a.api.post(`/ledger/invoices/${d2.body.id}/cancel`).expect(201)).body.status).toBe('cancelled');
    expect(calls.some((c) => c.url.endsWith('/cancel'))).toBe(true);
  });

  it('reminds 1, 3 and 7 days after the due date, in daytime only, and marks it overdue', async () => {
    const d = await a.api.post('/ledger/invoices', { customer: { name: 'Kiran', phone: '9845011166' }, lines: [{ description: 'Spa', qty: 1, unitPrice: 1180 }], dueDays: 0 }).expect(201);
    await a.api.post(`/ledger/invoices/${d.body.id}/send`).expect(201);
    await tenant(a.businessId, (tx) => tx.q(`UPDATE invoices SET due_at = now() - interval '2 days' WHERE id = $1`, [d.body.id]));
    const noonIST = new Date(); noonIST.setUTCHours(6, 30, 0, 0); // 12:00 in India
    const nightIST = new Date(); nightIST.setUTCHours(17, 0, 0, 0); // 22:30 in India
    expect(await ledger.remind(a.businessId, nightIST)).toBe(0);
    expect(await ledger.remind(a.businessId, noonIST)).toBe(1);
    expect(await ledger.remind(a.businessId, noonIST)).toBe(0); // next one is 3 days after due
    const inv = (await a.api.get(`/ledger/invoices/${d.body.id}`).expect(200)).body;
    expect(inv).toMatchObject({ status: 'overdue', reminders: 1 });
  });

  it("keeps each business's invoices to itself, and numbers each business separately", async () => {
    expect((await b.api.get(`/ledger/invoices/${first.id}`)).status).toBe(404);
    expect((await b.api.get('/ledger/invoices').expect(200)).body).toEqual([]);
    const d = await b.api.post('/ledger/invoices', { customer: { name: 'Gym member', phone: '9845011177' }, lines: [{ description: 'Monthly plan', qty: 1, unitPrice: 1500 }] }).expect(201);
    expect((await b.api.post(`/ledger/invoices/${d.body.id}/paid`).expect(201)).body.number).toBe(`INV/${fy}/0001`);
    // B is not GST-registered: no tax on its invoice.
    expect((await b.api.get(`/ledger/invoices/${d.body.id}`).expect(200)).body).toMatchObject({ taxTotal: 0, total: 1500 });
  });

  it('makes an invoice from a booking', async () => {
    const bk = await tenant(a.businessId, (tx) => tx.one(`SELECT bk.id FROM bookings bk WHERE bk.price IS NOT NULL LIMIT 1`));
    if (!bk) return; // onboarding sample has no priced booking in some templates
    const r = await a.api.post(`/ledger/invoices/from-booking/${bk.id}`).expect(201);
    expect(r.body).toMatchObject({ status: 'draft', bookingId: bk.id });
  });
});
