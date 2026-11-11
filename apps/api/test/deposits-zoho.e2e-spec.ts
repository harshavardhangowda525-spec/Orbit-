/**
 * Booking deposits (pay to confirm, slot freed when unpaid) and Zoho Books sync.
 * Razorpay and Zoho are mocked.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { bootApp, onboard } from './helpers';
import { DbService } from '../src/db/db.service';
import { JobsService } from '../src/jobs/jobs.service';
import { LedgerService } from '../src/ledger/ledger.service';

describe('Deposits and Zoho Books', () => {
  let app: NestExpressApplication;
  let db: DbService;
  let jobs: JobsService;
  let ledger: LedgerService;
  const realFetch = global.fetch;
  let calls: { url: string; method: string; body: any }[] = [];
  let seq = 0;
  let a: Awaited<ReturnType<typeof onboard>>;
  let hook: { webhookUrl: string; webhookSecret: string };
  let serviceId: string;
  const http = () => request(app.getHttpServer());
  const tenant = (id: string, fn: (tx: any) => Promise<any>): Promise<any> => db.withTenant(id, fn);

  const freeSlot = async (n = 0) => {
    const r = await http().get(`/public/businesses/${a.slug}/slots`).query({ serviceId, days: 7 }).expect(200);
    return r.body[n].start as string;
  };
  const book = async (start: string, phone: string) =>
    http().post(`/public/businesses/${a.slug}/bookings`).send({ serviceId, start, name: 'Deepa', phone }).expect(201);

  beforeAll(async () => {
    process.env.ZOHO_CLIENT_ID = 'zoho-client';
    process.env.ZOHO_CLIENT_SECRET = 'zoho-secret';
    global.fetch = (async (url: string, init?: any) => {
      const u = String(url);
      const ok = (d: object) => new Response(JSON.stringify(d), { status: 200 });
      if (!/razorpay|zoho/.test(u)) return realFetch(url as any, init);
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push({ url: u, method: init?.method ?? 'GET', body });
      if (u.includes('/payment_links?count=1')) return ok({});
      if (u.endsWith('/payment_links') && init.method === 'POST') return ok({ id: `plink_d${++seq}`, short_url: `https://rzp.io/i/d${seq}` });
      if (/\/payment_links\/[\w]+\/cancel$/.test(u)) return ok({});
      if (/\/payment_links\/[\w]+$/.test(u)) return ok({ status: 'issued' });
      if (u.includes('/oauth/v2/token')) return ok({ access_token: 'ZOHO-AT', refresh_token: 'ZOHO-RT', expires_in: 3600, api_domain: 'https://www.zohoapis.in' });
      if (u.includes('/books/v3/organizations')) return ok({ code: 0, organizations: [{ organization_id: '6000123', name: 'Wave Books', is_default_org: true }] });
      if (u.includes('/books/v3/settings/taxes')) return ok({ code: 0, taxes: [{ tax_id: 'T18G', tax_percentage: 18, tax_type: 'tax_group' }, { tax_id: 'T18I', tax_percentage: 18, tax_type: 'tax', tax_specific_type: 'igst' }] });
      if (u.includes('/books/v3/contacts')) return ok({ code: 0, contact: { contact_id: 'C1' } });
      if (/\/books\/v3\/invoices\/\w+\/status\//.test(u)) return ok({ code: 0 });
      if (u.includes('/books/v3/invoices')) return ok({ code: 0, invoice: { invoice_id: `ZI${++seq}` } });
      if (u.includes('/books/v3/customerpayments')) return ok({ code: 0, payment: { payment_id: 'ZP1' } });
      return ok({});
    }) as any;
    app = await bootApp();
    db = app.get(DbService);
    jobs = app.get(JobsService);
    ledger = app.get(LedgerService);
    a = await onboard(app, 'salon', 'Dew Salon');
    await db.q(`UPDATE businesses SET plan_id = (SELECT id FROM plans WHERE code = 'business') WHERE id = $1`, [a.businessId]);
    serviceId = (await tenant(a.businessId, (tx) => tx.one(`UPDATE services SET deposit_required = true, deposit_amount = 200, price = 1000 WHERE id = (SELECT id FROM services WHERE duration_min > 0 ORDER BY sort_order LIMIT 1) RETURNING id`))).id;
    hook = (await a.api.post('/ledger/razorpay/connect', { keyId: 'rzp_test_dew123456', keySecret: 'secretsecret123' }).expect(201)).body;
  });
  afterAll(async () => {
    global.fetch = realFetch;
    delete process.env.ZOHO_CLIENT_ID;
    delete process.env.ZOHO_CLIENT_SECRET;
    await app.close();
  });
  beforeEach(() => {
    calls = [];
    jobs.pending.length = 0;
  });

  it('a service with a deposit holds the slot until the deposit is paid, then confirms it', async () => {
    const r = await book(await freeSlot(0), '9845022201');
    expect(r.body).toMatchObject({ status: 'pending', deposit: { amount: 200, url: expect.stringMatching(/^https:\/\/rzp\.io\//) } });
    const inv = await tenant(a.businessId, (tx) => tx.one(`SELECT id, kind, status, number, total::float FROM invoices WHERE booking_id = $1`, [r.body.id]));
    expect(inv).toMatchObject({ kind: 'deposit', status: 'sent', total: 200, number: expect.stringMatching(/^INV\//) });

    const raw = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'none', amount_paid: 20000, notes: { orbit_invoice_id: inv.id } } }, payment: { entity: { id: 'pay_dep1', amount: 20000, method: 'upi' } } } });
    await http().post(new URL(hook.webhookUrl).pathname).set('content-type', 'application/json')
      .set('x-razorpay-signature', createHmac('sha256', hook.webhookSecret).update(raw).digest('hex')).send(raw).expect(200);
    const bk = await tenant(a.businessId, (tx) => tx.one(`SELECT status, deposit_payment_id FROM bookings WHERE id = $1`, [r.body.id]));
    expect(bk.status).toBe('confirmed');
    expect(bk.deposit_payment_id).toBeTruthy();
  });

  it('an unpaid deposit expires: the booking is cancelled and the slot is free again', async () => {
    const start = await freeSlot(0);
    const r = await book(start, '9845022202');
    expect(r.body.status).toBe('pending');
    // The held slot is not offered to anyone else.
    const held = await http().get(`/public/businesses/${a.slug}/slots`).query({ serviceId, days: 7 }).expect(200);
    expect(held.body.map((s: any) => s.start)).not.toContain(start);
    await tenant(a.businessId, (tx) => tx.q(`UPDATE invoices SET due_at = now() - interval '1 minute' WHERE booking_id = $1`, [r.body.id]));
    expect(await ledger.expireDeposits(a.businessId)).toBe(1);
    const bk = await tenant(a.businessId, (tx) => tx.one(`SELECT status FROM bookings WHERE id = $1`, [r.body.id]));
    expect(bk.status).toBe('cancelled');
    expect(calls.some((c) => c.url.endsWith('/cancel'))).toBe(true);
    const free = await http().get(`/public/businesses/${a.slug}/slots`).query({ serviceId, days: 7 }).expect(200);
    expect(free.body.map((s: any) => s.start)).toContain(start);
  });

  it('connects Zoho Books and copies issued invoices and payments into it', async () => {
    const start = await a.api.post('/ledger/zoho/connect').expect(201);
    const url = new URL(start.body.url);
    expect(url.host).toBe('accounts.zoho.in');
    expect(url.searchParams.get('scope')).toContain('ZohoBooks.invoices.CREATE');
    const cb = await http().get('/powers/oauth/zoho/callback').query({ state: url.searchParams.get('state'), code: 'zcode', 'accounts-server': 'https://accounts.zoho.in' }).expect(302);
    expect(cb.headers.location).toContain('result=connected');
    const powers = (await a.api.get('/powers').expect(200)).body;
    expect(powers.find((p: any) => p.type === 'zoho_books').connection).toMatchObject({ status: 'connected', account: 'Wave Books' });

    await a.api.patch('/ledger/profile', { gstin: '29ABCDE1234F1Z5' }).expect(200);
    const d = await a.api.post('/ledger/invoices', { customer: { name: 'Lata', phone: '9845022203' }, lines: [{ description: 'Hair colour', qty: 1, unitPrice: 2360 }] }).expect(201);
    const paid = await a.api.post(`/ledger/invoices/${d.body.id}/paid`, { method: 'upi' }).expect(201);
    await jobs.runDue(Date.now(), ['zoho.invoice', 'zoho.payment']);
    const zi = calls.find((c) => c.url.includes('/books/v3/invoices?') && c.method === 'POST');
    expect(zi?.url).toContain('organization_id=6000123');
    expect(zi?.url).toContain('ignore_auto_number_generation=true');
    expect(zi?.body).toMatchObject({ customer_id: 'C1', invoice_number: paid.body.number, is_inclusive_tax: true, line_items: [{ name: 'Hair colour', rate: 2360, quantity: 1, tax_id: 'T18G' }] });
    const zp = calls.find((c) => c.url.includes('/customerpayments'));
    expect(zp?.body).toMatchObject({ customer_id: 'C1', payment_mode: 'banktransfer', amount: 2360, invoices: [{ amount_applied: 2360 }] });
    // Never pushed twice.
    calls = [];
    await tenant(a.businessId, (tx) => app.get(require('../src/ledger/zoho.service').ZohoService).pushInvoice(tx, d.body.id));
    expect(calls.filter((c) => c.url.includes('/books/v3/invoices?'))).toHaveLength(0);
  });
});
