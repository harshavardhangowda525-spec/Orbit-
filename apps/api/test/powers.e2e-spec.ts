/**
 * Google Calendar and Gmail Powers, with Google's APIs mocked at the fetch level.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { addDays, localParts, zonedTimeToUtc } from '@orbit/shared';
import { config, runtime } from '../src/config';
import { DbService } from '../src/db/db.service';
import { JobsService } from '../src/jobs/jobs.service';
import { PowersService } from '../src/powers/powers.service';
import { AiService } from '../src/ai/ai.service';
import { text } from '../src/ai/fake.provider';
import { open } from '../src/powers/crypto';
import { bootApp, onboard } from './helpers';

const TZ = 'Asia/Kolkata';
const realFetch = global.fetch;
const calls: { method: string; url: string; body: any }[] = [];
let busy: { start: string; end: string }[] = [];
let inbox: any[] = [];
let refreshFails = false;

function mockGoogle() {
  global.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    if (!/googleapis\.com|google\.com/.test(url)) return realFetch(input, init);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? (init.body.startsWith('{') ? JSON.parse(init.body) : init.body) : init.body ? String(init.body) : undefined;
    calls.push({ method, url, body });
    const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
    if (url.includes('oauth2.googleapis.com/token')) {
      if (String(body).includes('grant_type=refresh_token')) return refreshFails ? json({ error: 'invalid_grant' }, 400) : json({ access_token: 'access-2', expires_in: 3600 });
      const power = String(body).includes('code=cal') ? 'calendar' : 'gmail';
      const scope = power === 'calendar' ? 'openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy' : 'openid email https://www.googleapis.com/auth/gmail.modify';
      return json({ access_token: `access-${power}`, refresh_token: `refresh-${power}`, expires_in: 3600, scope });
    }
    if (url.includes('/oauth2/v3/userinfo')) return json({ email: 'owner@salon.example' });
    if (url.includes('oauth2.googleapis.com/revoke')) return json({});
    if (url.includes('/calendar/v3/freeBusy')) return json({ calendars: { primary: { busy } } });
    if (url.includes('/calendar/v3/calendars/primary/events') && method === 'POST') return json({ id: 'evt-1' });
    if (url.includes('/calendar/v3/calendars/primary/events/')) return method === 'DELETE' ? new Response(null, { status: 204 }) : json({ id: 'evt-1' });
    if (url.includes('/gmail/v1/users/me/messages?')) return json({ messages: inbox.map((m) => ({ id: m.id, threadId: m.threadId })) });
    if (/\/gmail\/v1\/users\/me\/messages\/[^/]+\?format=full/.test(url)) return json(inbox.find((m) => url.includes(`/messages/${m.id}?`)));
    if (url.includes('/modify')) return json({});
    if (url.includes('/messages/send')) return json({ id: `sent-${calls.length}`, threadId: body.threadId });
    return json({ error: 'not mocked' }, 500);
  }) as typeof fetch;
}

describe('Powers: Google Calendar and Gmail', () => {
  let app: NestExpressApplication;
  let db: DbService;
  let jobs: JobsService;
  let S: Awaited<ReturnType<typeof onboard>>;
  const http = () => request(app.getHttpServer());
  const day = (n: number) => addDays(localParts(new Date(), TZ).date, n);

  async function connect(type: string, code: string) {
    const r = await S.api.post(`/powers/${type}/connect`).expect(201);
    const state = new URL(r.body.url).searchParams.get('state')!;
    expect(new URL(r.body.url).searchParams.get('scope')).toContain(type === 'gmail' ? 'gmail.modify' : 'calendar.events');
    const cb = await http().get('/powers/oauth/callback').query({ state, code }).expect(302);
    return cb.headers.location as string;
  }

  beforeAll(async () => {
    mockGoogle();
    app = await bootApp();
    db = app.get(DbService);
    jobs = app.get(JobsService);
    S = await onboard(app, 'salon', 'Powers Salon');
  });
  afterAll(async () => {
    global.fetch = realFetch;
    await app.close();
  });

  it('explains when Google is not set up, and when the plan does not include a Power', async () => {
    expect((await S.api.post('/powers/google_calendar/connect')).body.error.code).toBe('power_not_configured');
    (config as any).googleClientId = 'test-client';
    (runtime as any).googleClientSecret = 'test-secret';
    expect((await S.api.post('/powers/google_calendar/connect')).body.error.code).toBe('upgrade_needed');
    await db.adminTx((tx) => tx.q(`UPDATE businesses SET plan_id = (SELECT id FROM plans WHERE code = 'business') WHERE id = $1`, [S.businessId]));
    expect((await S.api.post('/powers/whatsapp/connect')).body.error.code).toBe('power_coming_soon');
  });

  it('connects Google Calendar with OAuth and stores tokens encrypted', async () => {
    const back = await connect('google_calendar', 'cal-code');
    expect(back).toMatch(/\/bridge\?view=powers&power=google_calendar&result=connected$/);
    const row = await db.withTenant(S.businessId, (tx) => tx.one(`SELECT encrypted_tokens, account_label, status FROM power_connections WHERE power_type = 'google_calendar' AND status = 'connected'`));
    expect(row.account_label).toBe('owner@salon.example');
    expect(row.encrypted_tokens.toString('utf8')).not.toContain('access-calendar');
    expect(open(row.encrypted_tokens).refresh_token).toBe('refresh-calendar');
    const list = (await S.api.get('/powers').expect(200)).body;
    expect(list.find((p: any) => p.type === 'google_calendar').connection.status).toBe('connected');
    // A state can only be used once.
    const again = await http().get('/powers/oauth/callback').query({ state: 'nope', code: 'cal-code' }).expect(302);
    expect(again.headers.location).toContain('result=expired');
  });

  it('busy times on Google Calendar block slots; bookings appear on Google Calendar', async () => {
    const state = (await S.api.get('/onboarding/state').expect(200)).body;
    const haircut = state.services.find((s: any) => s.name === 'Haircut');
    busy = [{ start: zonedTimeToUtc(day(2), '11:00', TZ).toISOString(), end: zonedTimeToUtc(day(2), '12:00', TZ).toISOString() }];
    const slots = (await S.api.get(`/slots?serviceId=${haircut.id}&date=${day(2)}&days=1`).expect(200)).body.map((s: any) => localParts(new Date(s.start), TZ).hhmm);
    expect(slots).toContain('10:00');
    expect(slots).not.toContain('11:00');
    expect(slots).not.toContain('11:30');
    expect(slots).toContain('12:00');

    const r = await S.api.post('/bookings', { serviceId: haircut.id, start: zonedTimeToUtc(day(2), '15:00', TZ).toISOString(), name: 'Asha', phone: '9811133301' }).expect(201);
    await jobs.runDue(Date.now(), ['powers.calendar_sync']);
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/calendars/primary/events') && c.body.summary === 'Haircut — Asha')).toBe(true);
    const bk = await db.withTenant(S.businessId, (tx) => tx.one(`SELECT external_calendar_event_id FROM bookings WHERE id = $1`, [r.body.id]));
    expect(bk.external_calendar_event_id).toBe('evt-1');
    await S.api.patch(`/bookings/${r.body.id}`, { status: 'cancelled' }).expect(200);
    await jobs.runDue(Date.now(), ['powers.calendar_sync']);
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/events/evt-1'))).toBe(true);
  });

  it('Gmail: enquiry emails land in the inbox, Aria replies in the same thread', async () => {
    await connect('gmail', 'gmail-code');
    const fake = app.get(AiService).fake!;
    fake.reset();
    fake.script = () => [text('Yes, we are open on Sunday from 10 am to 6 pm.')];
    inbox = [
      {
        id: 'm1',
        threadId: 't1',
        snippet: 'Are you open on Sunday?',
        payload: {
          headers: [
            { name: 'From', value: 'Ravi Kumar <ravi@example.com>' },
            { name: 'Subject', value: 'Sunday timings' },
            { name: 'Message-ID', value: '<abc@mail.example.com>' },
          ],
          mimeType: 'text/plain',
          body: { data: Buffer.from('Hi, are you open on Sunday?\n\nOn Mon, someone wrote:\n> old stuff').toString('base64url') },
        },
      },
    ];
    expect(await app.get(PowersService).pollGmail(S.businessId)).toBe(1);
    expect(await app.get(PowersService).pollGmail(S.businessId)).toBe(0); // never processed twice
    expect(fake.calls[0].messages[0].content).toBe('Hi, are you open on Sunday?'); // quoted history removed
    await jobs.runDue(Date.now(), ['powers.deliver']);
    const send = calls.find((c) => c.url.includes('/messages/send'))!;
    expect(send.body.threadId).toBe('t1');
    const raw = Buffer.from(send.body.raw, 'base64url').toString('utf8');
    expect(raw).toContain('To: ravi@example.com');
    expect(raw).toContain('In-Reply-To: <abc@mail.example.com>');
    expect(raw).toContain('Yes, we are open on Sunday from 10 am to 6 pm.');
    const inboxList = (await S.api.get('/inbox').expect(200)).body;
    const conv = inboxList.find((c: any) => c.channel === 'gmail');
    expect(conv.customer).toBe('Ravi Kumar');
    // A staff reply on an email conversation is sent by email too.
    calls.length = 0;
    await S.api.post(`/inbox/${conv.id}/reply`, { body: 'See you Sunday! — Meera' }).expect(201);
    await jobs.runDue(Date.now(), ['powers.deliver']);
    expect(Buffer.from(calls.find((c) => c.url.includes('/messages/send'))!.body.raw, 'base64url').toString('utf8')).toContain('See you Sunday! — Meera');
  });

  it('an expired Google grant pauses the Power and tells the owner', async () => {
    await db.withTenant(S.businessId, async (tx) => {
      const c = await tx.one(`SELECT id, encrypted_tokens FROM power_connections WHERE power_type = 'gmail' AND status = 'connected'`);
      const t = open(c.encrypted_tokens);
      const { seal } = await import('../src/powers/crypto');
      await tx.q(`UPDATE power_connections SET encrypted_tokens = $2 WHERE id = $1`, [c.id, seal({ ...t, expires_at: Date.now() - 1000 })]);
    });
    refreshFails = true;
    await app.get(PowersService).pollGmail(S.businessId);
    refreshFails = false;
    const list = (await S.api.get('/powers').expect(200)).body;
    expect(list.find((p: any) => p.type === 'gmail').connection).toMatchObject({ status: 'error', error: 'token_expired' });
    const notes = (await S.api.get('/notifications').expect(200)).body.items;
    expect(notes.some((n: any) => n.type === 'power_disconnected')).toBe(true);
  });

  it('disconnecting revokes access and wipes the tokens', async () => {
    const list = (await S.api.get('/powers').expect(200)).body;
    const cal = list.find((p: any) => p.type === 'google_calendar').connection;
    calls.length = 0;
    await S.api.delete(`/powers/${cal.id}`).expect(200);
    expect(calls.some((c) => c.url.includes('/revoke'))).toBe(true);
    const row = await db.withTenant(S.businessId, (tx) => tx.one(`SELECT status, encrypted_tokens FROM power_connections WHERE id = $1`, [cal.id]));
    expect(row).toEqual({ status: 'disconnected', encrypted_tokens: null });
    const biz = await db.one(`SELECT calendar_mode FROM businesses WHERE id = $1`, [S.businessId]);
    expect(biz.calendar_mode).toBe('builtin');
  });
});
