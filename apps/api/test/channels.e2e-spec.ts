/**
 * WhatsApp, Messenger and Instagram through Meta: connecting, signed webhooks,
 * messages landing in the inbox with Aria answering, delivery under Meta's 24-hour
 * rule, opt-outs, and isolation between businesses. Meta's API is mocked.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { bootApp, onboard, api } from './helpers';
import { JobsService } from '../src/jobs/jobs.service';
import { DbService } from '../src/db/db.service';
import { ChannelsService } from '../src/channels/channels.service';
import { AiService } from '../src/ai/ai.service';
import { text } from '../src/ai/fake.provider';

const SECRET = 'test-meta-app-secret';
const VERIFY = 'test-verify-token';

describe('Meta channels (WhatsApp, Messenger, Instagram)', () => {
  let app: NestExpressApplication;
  let jobs: JobsService;
  let db: DbService;
  const realFetch = global.fetch;
  let sent: { url: string; body: any }[] = [];
  let seq = 0;
  let a: Awaited<ReturnType<typeof onboard>>;
  let b: Awaited<ReturnType<typeof onboard>>;
  const http = () => request(app.getHttpServer());

  /** Posts a webhook body signed like Meta does. */
  const hook = (body: object, secret = SECRET) => {
    const raw = JSON.stringify(body);
    const sig = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
    return http().post('/webhooks/meta').set('content-type', 'application/json').set('x-hub-signature-256', sig).send(raw);
  };
  const waMessage = (phoneNumberId: string, from: string, id: string, body: string, name = 'Kavya') => ({
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId }, contacts: [{ wa_id: from, profile: { name } }], messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }] } }] }],
  });
  const tenant = (businessId: string, fn: (tx: any) => Promise<any>): Promise<any> => db.withTenant(businessId, fn);

  beforeAll(async () => {
    process.env.META_APP_SECRET = SECRET;
    process.env.META_VERIFY_TOKEN = VERIFY;
    process.env.META_APP_ID = '424242';
    process.env.META_WA_CONFIG_ID = 'cfg-wa';
    process.env.META_LOGIN_CONFIG_ID = 'cfg-pages';
    global.fetch = (async (url: string, init?: any) => {
      const u = String(url);
      if (!u.startsWith('https://graph.facebook.com/')) return realFetch(url as any, init);
      const body = init?.body ? JSON.parse(init.body) : null;
      if (init?.method === 'POST') sent.push({ url: u, body });
      const ok = (d: object) => new Response(JSON.stringify(d), { status: 200 });
      if (/\/subscribed_apps$/.test(u)) return ok({ success: true });
      if (/\/messages$/.test(u)) return ok(body?.messaging_product ? { messages: [{ id: `wamid.out${++seq}` }] } : { recipient_id: body.recipient.id, message_id: `mid.out${++seq}` });
      if (/fields=display_phone_number/.test(u)) {
        if (u.includes('/999')) return new Response(JSON.stringify({ error: { message: 'Invalid OAuth access token.' } }), { status: 401 });
        return ok({ display_phone_number: '+91 98450 00000', verified_name: 'Glow' });
      }
      if (/fields=name$/.test(u)) return ok({ name: 'Glow Page' });
      if (u.includes('/oauth/access_token')) return u.includes('code=bad-code-123') ? new Response(JSON.stringify({ error: { message: 'Invalid verification code' } }), { status: 400 }) : ok({ access_token: 'BIZ-TOKEN', token_type: 'bearer' });
      if (/\/register$/.test(u)) return ok({ success: true });
      if (u.includes('/me/accounts')) return ok({ data: [{ id: '3330003', name: 'Wave Salon Page', access_token: 'PAGE-TOKEN', instagram_business_account: { id: '4440004', username: 'wavesalon' } }] });
      if (u.includes('fields=username')) return ok({ username: 'wavesalon' });
      if (/fields=first_name/.test(u)) return ok({ first_name: 'Ravi', last_name: 'Shetty' });
      return ok({});
    }) as any;
    app = await bootApp();
    jobs = app.get(JobsService);
    db = app.get(DbService);
    a = await onboard(app, 'salon', 'Wave Salon');
    b = await onboard(app, 'gym', 'Wave Gym');
    // Messaging channels are on paid plans.
    await db.q(`UPDATE businesses SET plan_id = (SELECT id FROM plans WHERE code = 'business') WHERE id = ANY($1::uuid[])`, [[a.businessId, b.businessId]]);
  });
  afterAll(async () => {
    global.fetch = realFetch;
    delete process.env.META_APP_SECRET;
    delete process.env.META_VERIFY_TOKEN;
    delete process.env.META_APP_ID;
    delete process.env.META_WA_CONFIG_ID;
    delete process.env.META_LOGIN_CONFIG_ID;
    await app.close();
  });
  beforeEach(() => {
    sent = [];
    jobs.pending.length = 0;
  });

  it("answers Meta's webhook check only with the right verify token", async () => {
    const ok = await http().get('/webhooks/meta').query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY, 'hub.challenge': '12345' }).expect(200);
    expect(ok.text).toBe('12345');
    await http().get('/webhooks/meta').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' }).expect(403);
  });

  it('connects WhatsApp after checking the details with Meta', async () => {
    const bad = await a.api.post('/channels/whatsapp/connect', { phoneNumberId: '99900011', accessToken: 'x'.repeat(30) });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('meta_check_failed');
    const r = await a.api.post('/channels/whatsapp/connect', { phoneNumberId: '1110001', accessToken: 'EAAG'.padEnd(40, 'x') }).expect(201);
    expect(r.body.account).toBe('Glow · +91 98450 00000');
    const powers = (await a.api.get('/powers').expect(200)).body;
    expect(powers.find((p: any) => p.type === 'whatsapp')).toMatchObject({ available: true, form: 'meta', connection: { status: 'connected', account: 'Glow · +91 98450 00000' } });
    // The token is stored encrypted, never as text.
    const row = await tenant(a.businessId, (tx) => tx.one(`SELECT encode(encrypted_tokens, 'escape') AS t FROM power_connections WHERE power_type = 'whatsapp' AND status = 'connected'`));
    expect(row.t).not.toContain('EAAG');
  });

  it('a WhatsApp message lands in the inbox, Aria answers, and the reply goes out on WhatsApp', async () => {
    await hook(waMessage('1110001', '919845011111', 'wamid.in1', 'What are your timings?')).expect(200);
    const conv = await tenant(a.businessId, (tx) =>
      tx.one(`SELECT cv.id, cv.channel, cv.external_thread_id, c.name, c.phone, c.consent FROM conversations cv JOIN customers c ON c.id = cv.customer_id WHERE cv.external_thread_id = '919845011111'`),
    );
    expect(conv).toMatchObject({ channel: 'whatsapp', name: 'Kavya', phone: '+919845011111' });
    expect(conv.consent.whatsapp).toBe(true);

    await jobs.runDue(Date.now(), ['channels.reply']);
    await jobs.runDue(Date.now(), ['powers.deliver']);
    const wa = sent.filter((s) => s.url.endsWith('/1110001/messages'));
    expect(wa).toHaveLength(1);
    expect(wa[0].body).toMatchObject({ messaging_product: 'whatsapp', to: '919845011111', type: 'text' });
    const out = await tenant(a.businessId, (tx) => tx.one(`SELECT delivery_status, channel_message_id FROM messages WHERE conversation_id = $1 AND direction = 'out' ORDER BY created_at DESC LIMIT 1`, [conv.id]));
    expect(out).toMatchObject({ delivery_status: 'sent' });

    // Meta reports delivery; the same message delivered twice is stored once.
    const wamid = out.channel_message_id.replace(/^wa:/, '');
    await hook({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { metadata: { phone_number_id: '1110001' }, statuses: [{ id: wamid, status: 'delivered' }] } }] }] }).expect(200);
    expect((await tenant(a.businessId, (tx) => tx.one(`SELECT delivery_status FROM messages WHERE channel_message_id = $1`, [out.channel_message_id]))).delivery_status).toBe('delivered');
    await hook(waMessage('1110001', '919845011111', 'wamid.in1', 'What are your timings?')).expect(200);
    const n = await tenant(a.businessId, (tx) => tx.one(`SELECT count(*)::int AS n FROM messages WHERE channel_message_id = 'wa:wamid.in1'`));
    expect(n.n).toBe(1);
  });

  it('rejects webhooks without a valid signature', async () => {
    await hook(waMessage('1110001', '919845022222', 'wamid.forged', 'hi'), 'not-the-secret').expect(401);
    await http().post('/webhooks/meta').send(waMessage('1110001', '919845022222', 'wamid.forged2', 'hi')).expect(401);
    const n = await tenant(a.businessId, (tx) => tx.one(`SELECT count(*)::int AS n FROM conversations WHERE external_thread_id = '919845022222'`));
    expect(n.n).toBe(0);
  });

  it("follows WhatsApp's 24-hour rule: free text inside, approved template after, a clear reason otherwise", async () => {
    await hook(waMessage('1110001', '919845033333', 'wamid.old', 'Hello')).expect(200);
    const conv = await tenant(a.businessId, async (tx) => {
      const c = await tx.one(`SELECT id FROM conversations WHERE external_thread_id = '919845033333'`);
      await tx.q(`UPDATE messages SET created_at = now() - interval '2 days' WHERE conversation_id = $1`, [c.id]);
      return c;
    });
    const owner = api(app, a.owner.token, a.businessId);
    await owner.post(`/inbox/${conv.id}/reply`, { body: 'Hi Kavya, your appointment is tomorrow' }).expect(201);
    await jobs.runDue(Date.now(), ['powers.deliver']);
    const failed = await tenant(a.businessId, (tx) => tx.one(`SELECT delivery_status, delivery_error FROM messages WHERE conversation_id = $1 AND direction = 'out' ORDER BY created_at DESC LIMIT 1`, [conv.id]));
    expect(failed.delivery_status).toBe('failed');
    expect(failed.delivery_error).toMatch(/24 hours.*template/);

    // With an approved template set up, the message goes out as that template.
    await a.api.post('/channels/whatsapp/connect', { phoneNumberId: '1110001', accessToken: 'EAAG'.padEnd(40, 'x'), templateName: 'orbit_update', templateLanguage: 'en' }).expect(201);
    await owner.post(`/inbox/${conv.id}/reply`, { body: 'Hi Kavya, your appointment is tomorrow' }).expect(201);
    await jobs.runDue(Date.now(), ['powers.deliver']);
    const tpl = sent.find((s) => s.body?.type === 'template');
    expect(tpl?.body.template).toMatchObject({ name: 'orbit_update', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Hi Kavya, your appointment is tomorrow' }] }] });
  });

  it('STOP opts the customer out (confirmed, no Aria reply), and Orbit then never messages them there', async () => {
    await hook(waMessage('1110001', '919845044444', 'wamid.stop', 'STOP')).expect(200);
    expect(jobs.pending.filter((j) => j.name === 'channels.reply')).toHaveLength(0);
    const c = await tenant(a.businessId, (tx) => tx.one(`SELECT id, name, phone, email, consent, opted_out_at FROM customers WHERE phone = '+919845044444'`));
    expect(c.opted_out_at.whatsapp).toBeTruthy();
    const r = await tenant(a.businessId, (tx) => app.get(ChannelsService).deliver(tx, 'whatsapp', { customer: c, body: 'Offer!', agent: 'spark' }));
    expect(r.channel).not.toBe('whatsapp');
  });

  it('Orbit can start a WhatsApp conversation (reminders, the owner asking Orbit)', async () => {
    const c = await tenant(a.businessId, (tx) => tx.one(`INSERT INTO customers (name, phone, consent) VALUES ('Nisha', '+919845055555', '{"whatsapp": true}') RETURNING id, name, phone, email, consent, opted_out_at`));
    const r = await tenant(a.businessId, (tx) => app.get(ChannelsService).deliver(tx, 'whatsapp', { customer: c, body: 'See you at 4 pm today!', agent: 'nudge' }));
    expect(r).toMatchObject({ delivered: true, channel: 'whatsapp' });
    await jobs.runDue(Date.now(), ['powers.deliver']);
    // Nobody has written in 24 hours, so it goes as the approved template.
    expect(sent.find((s) => s.body?.to === '919845055555')?.body.type).toBe('template');
  });

  it('Messenger: a new person becomes a customer with their name; replies follow the 24-hour and 7-day rules', async () => {
    await a.api.post('/channels/messenger/connect', { pageId: '2220002', accessToken: 'EAAG'.padEnd(40, 'p') }).expect(201);
    expect(sent.some((s) => s.url.endsWith('/2220002/subscribed_apps'))).toBe(true);
    const msg = (id: string, t: string) => ({ object: 'page', entry: [{ id: '2220002', messaging: [{ sender: { id: 'psid-77' }, recipient: { id: '2220002' }, timestamp: Date.now(), message: { mid: id, text: t } }] }] });
    await hook(msg('m_1', 'Do you do bridal makeup?')).expect(200);
    const conv = await tenant(a.businessId, (tx) =>
      tx.one(`SELECT cv.id, c.name FROM conversations cv JOIN customers c ON c.id = cv.customer_id JOIN customer_identities i ON i.customer_id = c.id WHERE i.channel = 'messenger' AND i.external_id = 'psid-77'`),
    );
    expect(conv.name).toBe('Ravi Shetty');
    // Echoes of the page's own messages are ignored.
    await hook({ object: 'page', entry: [{ id: '2220002', messaging: [{ sender: { id: '2220002' }, recipient: { id: 'psid-77' }, message: { mid: 'm_echo', text: 'echo', is_echo: true } }] }] }).expect(200);

    const owner = api(app, a.owner.token, a.businessId);
    await owner.post(`/inbox/${conv.id}/reply`, { body: 'Yes we do!' }).expect(201);
    await jobs.runDue(Date.now(), ['powers.deliver']);
    expect(sent.find((s) => s.url.endsWith('/2220002/messages'))?.body).toMatchObject({ recipient: { id: 'psid-77' }, messaging_type: 'RESPONSE' });

    // After 24 hours only a person may reply, tagged HUMAN_AGENT.
    await tenant(a.businessId, (tx) => tx.q(`UPDATE messages SET created_at = now() - interval '3 days' WHERE conversation_id = $1 AND direction = 'in'`, [conv.id]));
    sent = [];
    await owner.post(`/inbox/${conv.id}/reply`, { body: 'Following up' }).expect(201);
    await jobs.runDue(Date.now(), ['powers.deliver']);
    expect(sent[0].body).toMatchObject({ messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' });
  });

  it("keeps businesses apart: one business's number cannot be claimed by another, and its messages never reach it", async () => {
    const r = await b.api.post('/channels/whatsapp/connect', { phoneNumberId: '1110001', accessToken: 'EAAG'.padEnd(40, 'y') });
    expect(r.status).toBe(409);
    await hook(waMessage('1110001', '919845066666', 'wamid.iso', 'hello')).expect(200);
    const inB = await tenant(b.businessId, (tx) => tx.one(`SELECT count(*)::int AS n FROM conversations WHERE external_thread_id = '919845066666'`));
    const inA = await tenant(a.businessId, (tx) => tx.one(`SELECT count(*)::int AS n FROM conversations WHERE external_thread_id = '919845066666'`));
    expect([inA.n, inB.n]).toEqual([1, 0]);
    // A number nobody connected is dropped quietly (Meta still gets a 200).
    await hook(waMessage('5550005', '919845077777', 'wamid.nobody', 'hello')).expect(200);
  });

  it('disconnecting stops routing: later messages are ignored', async () => {
    const powers = (await a.api.get('/powers').expect(200)).body;
    const id = powers.find((p: any) => p.type === 'messenger').connection.id;
    await a.api.delete(`/powers/${id}`).expect(200);
    await hook({ object: 'page', entry: [{ id: '2220002', messaging: [{ sender: { id: 'psid-88' }, recipient: { id: '2220002' }, timestamp: Date.now(), message: { mid: 'm_after', text: 'hi' } }] }] }).expect(200);
    const n = await tenant(a.businessId, (tx) => tx.one(`SELECT count(*)::int AS n FROM messages WHERE channel_message_id = 'fbm:m_after'`));
    expect(n.n).toBe(0);
  });

  it('Aria still answers on WhatsApp when the AI is scripted (sanity check of the reply job)', async () => {
    const fake = app.get(AiService).fake!;
    fake.script = () => [text('Namaste! We are open 10 to 8.')];
    try {
      await hook(waMessage('1110001', '919845088888', 'wamid.aria', 'Namaste')).expect(200);
      await jobs.runDue(Date.now(), ['channels.reply']);
      await jobs.runDue(Date.now(), ['powers.deliver']);
      expect(sent.find((s) => s.body?.to === '919845088888')?.body.text.body).toBe('Namaste! We are open 10 to 8.');
    } finally {
      fake.reset();
    }
  });

  it('one-click WhatsApp: the code from Meta\'s popup becomes a connection with no tokens typed', async () => {
    const setup = (await b.api.get('/channels/meta/setup').expect(200)).body;
    expect(setup).toMatchObject({ oneClick: { whatsapp: true, pages: true }, appId: '424242', whatsappConfigId: 'cfg-wa', loginConfigId: 'cfg-pages' });
    const bad = await b.api.post('/channels/whatsapp/signup', { code: 'bad-code-123', phoneNumberId: '7770007', wabaId: '8880008' });
    expect(bad.body.error.code).toBe('meta_check_failed');
    const r = await b.api.post('/channels/whatsapp/signup', { code: 'good-code-123', phoneNumberId: '7770007', wabaId: '8880008' }).expect(201);
    expect(r.body.account).toBe('Glow · +91 98450 00000');
    expect(sent.some((x) => x.url.endsWith('/8880008/subscribed_apps'))).toBe(true);
    const reg = sent.find((x) => x.url.endsWith('/7770007/register'));
    expect(reg?.body).toMatchObject({ messaging_product: 'whatsapp' });
    expect(reg?.body.pin).toMatch(/^\d{6}$/);
    // Messages to that number now reach business B.
    await hook(waMessage('7770007', '919845099999', 'wamid.oneclick', 'hi')).expect(200);
    const n = await tenant(b.businessId, (tx) => tx.one(`SELECT count(*)::int AS n FROM conversations WHERE external_thread_id = '919845099999'`));
    expect(n.n).toBe(1);
    // The reminder template can be set afterwards.
    await b.api.post('/channels/whatsapp/settings', { templateName: 'orbit_update', templateLanguage: 'en' }).expect(201);
  });

  it('one-click Facebook: pick a Page, connect Messenger and Instagram together', async () => {
    const login = (await b.api.post('/channels/pages/login', { code: 'good-code-456' }).expect(201)).body;
    expect(login.pages).toEqual([{ id: '3330003', name: 'Wave Salon Page', instagram: { id: '4440004', username: 'wavesalon' } }]);
    expect(JSON.stringify(login)).not.toContain('PAGE-TOKEN'); // the browser never sees Page tokens
    // Another business cannot reuse this selection.
    const stolen = await a.api.post('/channels/pages/connect', { selection: login.selection, pageId: '3330003', messenger: true, instagram: false });
    expect(stolen.body.error.code).toBe('expired');
    const r = await b.api.post('/channels/pages/connect', { selection: login.selection, pageId: '3330003', messenger: true, instagram: true }).expect(201);
    expect(r.body.connected).toEqual({ messenger: 'Wave Salon Page', instagram: '@wavesalon' });
    const ig = { object: 'instagram', entry: [{ id: '4440004', messaging: [{ sender: { id: 'igsid-1' }, recipient: { id: '4440004' }, timestamp: Date.now(), message: { mid: 'ig_1', text: 'Price for haircut?' } }] }] };
    await hook(ig).expect(200);
    const n = await tenant(b.businessId, (tx) => tx.one(`SELECT count(*)::int AS n FROM messages WHERE channel_message_id = 'ig:ig_1'`));
    expect(n.n).toBe(1);
  });
});
