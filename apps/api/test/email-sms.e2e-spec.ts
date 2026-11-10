/**
 * Outlook email and SMS (MSG91 / DLT). Microsoft Graph and MSG91 are mocked.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { bootApp, onboard } from './helpers';
import { JobsService } from '../src/jobs/jobs.service';
import { DbService } from '../src/db/db.service';
import { ChannelsService } from '../src/channels/channels.service';
import { EmailSmsService, smsVariables } from '../src/channels/email-sms.service';
import { AiService } from '../src/ai/ai.service';
import { text } from '../src/ai/fake.provider';

describe('Outlook and SMS', () => {
  let app: NestExpressApplication;
  let jobs: JobsService;
  let db: DbService;
  let svc: EmailSmsService;
  const realFetch = global.fetch;
  let calls: { url: string; method: string; body: any; headers: any }[] = [];
  let inbox: any[] = [];
  let a: Awaited<ReturnType<typeof onboard>>;
  const tenant = (id: string, fn: (tx: any) => Promise<any>): Promise<any> => db.withTenant(id, fn);

  beforeAll(async () => {
    process.env.MICROSOFT_CLIENT_ID = 'ms-client';
    process.env.MICROSOFT_CLIENT_SECRET = 'ms-secret';
    global.fetch = (async (url: string, init?: any) => {
      const u = String(url);
      const ok = (d: object, status = 200) => new Response(JSON.stringify(d), { status });
      if (!/microsoft|msg91/.test(u)) return realFetch(url as any, init);
      const body = init?.body ? (typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : String(init.body)) : null;
      calls.push({ url: u, method: init?.method ?? 'GET', body, headers: init?.headers });
      if (u.endsWith('/oauth2/v2.0/token')) return ok({ access_token: 'MS-ACCESS', refresh_token: 'MS-REFRESH', expires_in: 3600 });
      if (u.includes('/me?$select=mail')) return ok({ mail: 'Hello@WaveSpa.in' });
      if (u.includes('/mailFolders/inbox/messages')) return ok({ value: inbox });
      if (/\/me\/messages\/[^/]+$/.test(u)) return ok({});
      if (u.endsWith('/reply') || u.endsWith('/sendMail')) return new Response(null, { status: 202 });
      if (u.includes('msg91')) return init.headers.authkey === 'bad-key-0000' ? ok({ type: 'error', message: 'Authentication failure' }, 401) : ok({ type: 'success', request_id: 'req-123' });
      return ok({});
    }) as any;
    app = await bootApp();
    jobs = app.get(JobsService);
    db = app.get(DbService);
    svc = app.get(EmailSmsService);
    a = await onboard(app, 'spa', 'Wave Spa');
    await db.q(`UPDATE businesses SET plan_id = (SELECT id FROM plans WHERE code = 'business') WHERE id = $1`, [a.businessId]);
  });
  afterAll(async () => {
    global.fetch = realFetch;
    delete process.env.MICROSOFT_CLIENT_ID;
    delete process.env.MICROSOFT_CLIENT_SECRET;
    await app.close();
  });
  beforeEach(() => {
    calls = [];
    jobs.pending.length = 0;
  });

  it('splits an SMS into DLT variables of at most 30 characters', () => {
    const v = smsVariables('Hi Kavya, see you at 4:00 pm today for your facial at Wave Spa, Indiranagar. Reply to reschedule or cancel.', 3);
    expect(Object.keys(v)).toEqual(['var1', 'var2', 'var3']);
    for (const x of Object.values(v)) expect(x.length).toBeLessThanOrEqual(30);
    expect(v.var3.endsWith('…')).toBe(true);
  });

  it('connects SMS and sends reminders on the DLT template', async () => {
    const bad = await a.api.post('/channels/sms/connect', { authKey: 'k'.repeat(20), templateId: 'tmpl-1', senderId: 'WAVE' });
    expect(bad.body.error.message).toMatch(/6 letters/);
    await a.api.post('/channels/sms/connect', { authKey: 'good-key-1234', templateId: '64f0a1b2c3', senderId: 'wavesp', variables: 2 }).expect(201);
    const powers = (await a.api.get('/powers').expect(200)).body;
    expect(powers.find((p: any) => p.type === 'sms')).toMatchObject({ available: true, form: 'sms', connection: { status: 'connected', account: 'WAVESP · MSG91' } });

    const c = await tenant(a.businessId, (tx) => tx.one(`INSERT INTO customers (name, phone, consent) VALUES ('Kavya', '+919845012345', '{"sms": true, "whatsapp": false}') RETURNING id, name, phone, email, consent, opted_out_at`));
    const r = await tenant(a.businessId, (tx) => app.get(ChannelsService).deliver(tx, 'sms', { customer: c, body: 'Hi Kavya, see you at 4 pm today!', agent: 'nudge' }));
    expect(r).toMatchObject({ delivered: true, channel: 'sms' });
    await jobs.runDue(Date.now(), ['powers.deliver']);
    const sms = calls.find((x) => x.url.includes('msg91'));
    expect(sms?.headers.authkey).toBe('good-key-1234');
    expect(sms?.body).toMatchObject({ template_id: '64f0a1b2c3', recipients: [{ mobiles: '919845012345', var1: 'Hi Kavya, see you at 4 pm toda', var2: 'y!' }] });
    const m = await tenant(a.businessId, (tx) => tx.one(`SELECT delivery_status, channel_message_id FROM messages WHERE channel_message_id = 'sms:req-123'`));
    expect(m.delivery_status).toBe('sent');
  });

  it('a rejected SMS is marked not delivered with the reason', async () => {
    await a.api.post('/channels/sms/connect', { authKey: 'bad-key-0000', templateId: '64f0a1b2c3', senderId: 'WAVESP' }).expect(201);
    const c = await tenant(a.businessId, (tx) => tx.one(`SELECT id, name, phone, email, consent, opted_out_at FROM customers WHERE phone = '+919845012345'`));
    await tenant(a.businessId, (tx) => app.get(ChannelsService).deliver(tx, 'sms', { customer: c, body: 'Second reminder', agent: 'nudge' }));
    await jobs.runDue(Date.now(), ['powers.deliver']);
    const m = await tenant(a.businessId, (tx) => tx.one(`SELECT delivery_status, delivery_error FROM messages WHERE body = 'Second reminder'`));
    expect(m).toMatchObject({ delivery_status: 'failed', delivery_error: 'Authentication failure' });
  });

  it('connects Outlook with Microsoft sign-in', async () => {
    const start = await a.api.post('/channels/outlook/connect').expect(201);
    const url = new URL(start.body.url);
    expect(url.host).toBe('login.microsoftonline.com');
    expect(url.searchParams.get('scope')).toContain('Mail.Send');
    const state = url.searchParams.get('state')!;
    const cb = await request(app.getHttpServer()).get('/powers/oauth/microsoft/callback').query({ state, code: 'ms-code' }).expect(302);
    expect(cb.headers.location).toContain('result=connected');
    const powers = (await a.api.get('/powers').expect(200)).body;
    expect(powers.find((p: any) => p.type === 'outlook').connection).toMatchObject({ status: 'connected', account: 'hello@wavespa.in' });
    // A used or unknown state does nothing.
    const again = await request(app.getHttpServer()).get('/powers/oauth/microsoft/callback').query({ state, code: 'ms-code' }).expect(302);
    expect(again.headers.location).toContain('result=expired');
  });

  it('new Outlook enquiries reach the inbox, Aria replies in the same thread, and auto-replies are skipped', async () => {
    const fake = app.get(AiService).fake!;
    fake.script = () => [text('Yes, we have a facial slot at 5 pm.')];
    inbox = [
      { id: 'AAMk1', conversationId: 'conv-1', subject: 'Facial today?', from: { emailAddress: { address: 'Riya@Example.com', name: 'Riya' } }, uniqueBody: { content: 'Any facial slot today?' } },
      { id: 'AAMk2', conversationId: 'conv-2', subject: 'Automatic reply: away', from: { emailAddress: { address: 'bot@example.com' } }, uniqueBody: { content: 'I am away' } },
    ];
    try {
      expect(await svc.poll(a.businessId)).toBe(1);
      await jobs.runDue(Date.now(), ['powers.deliver']);
    } finally {
      fake.reset();
    }
    const conv = await tenant(a.businessId, (tx) => tx.one(`SELECT cv.id, c.email, c.name FROM conversations cv JOIN customers c ON c.id = cv.customer_id WHERE cv.channel = 'outlook' AND cv.external_thread_id = 'conv-1'`));
    expect(conv).toMatchObject({ email: 'riya@example.com', name: 'Riya' });
    const reply = calls.find((x) => x.url.endsWith('/me/messages/AAMk1/reply'));
    expect(reply?.body).toEqual({ comment: 'Yes, we have a facial slot at 5 pm.' });
    expect(calls.filter((x) => x.method === 'PATCH').length).toBe(2); // both marked read
    // Seen messages are not processed twice.
    expect(await svc.poll(a.businessId)).toBe(0);
  });

  it('Orbit can email a customer through Outlook when no other channel reaches them', async () => {
    const c = await tenant(a.businessId, (tx) => tx.one(`INSERT INTO customers (name, email, consent) VALUES ('Anu', 'anu@example.com', '{"email": true}') RETURNING id, name, phone, email, consent, opted_out_at`));
    const r = await tenant(a.businessId, (tx) => app.get(ChannelsService).deliver(tx, 'whatsapp', { customer: c, body: 'Your appointment is confirmed.', agent: 'nudge' }));
    expect(r.channel).toBe('outlook');
    await jobs.runDue(Date.now(), ['powers.deliver']);
    const sent = calls.find((x) => x.url.endsWith('/sendMail'));
    expect(sent?.body.message).toMatchObject({ subject: 'A message from Wave Spa', toRecipients: [{ emailAddress: { address: 'anu@example.com' } }] });
  });
});
