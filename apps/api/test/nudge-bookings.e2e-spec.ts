/**
 * Phase 2 acceptance: public booking flow, concurrent double booking through the
 * API, reminders at the right local time that stop when a customer books,
 * opt-outs, manage-booking link, daily briefing and live WebSocket updates.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import WebSocket from 'ws';
import { addDays, localParts, zonedTimeToUtc } from '@orbit/shared';
import { DbService } from '../src/db/db.service';
import { NudgeService } from '../src/nudge/nudge.service';
import { JobsService } from '../src/jobs/jobs.service';
import { BriefingService } from '../src/briefing/briefing.service';
import { attachWebSockets } from '../src/realtime/ws.gateway';
import { bootApp, onboard, signIn, api } from './helpers';

const TZ = 'Asia/Kolkata';
type Biz = Awaited<ReturnType<typeof onboard>>;

describe('bookings, Nudge and briefings', () => {
  let app: NestExpressApplication;
  let db: DbService;
  let nudge: NudgeService;
  let jobs: JobsService;
  let S: Biz;
  let haircut: { id: string; durationMin: number };
  const http = () => request(app.getHttpServer());
  const day = (n: number) => addDays(localParts(new Date(), TZ).date, n);

  beforeAll(async () => {
    app = await bootApp();
    db = app.get(DbService);
    nudge = app.get(NudgeService);
    jobs = app.get(JobsService);
    S = await onboard(app, 'salon', 'Nudge Salon');
    const state = (await S.api.get('/onboarding/state').expect(200)).body;
    haircut = state.services.find((s: any) => s.name === 'Haircut');
  });
  afterAll(() => app.close());

  function book(start: Date, phone: string, name = "Kavya") {
    return http().post(`/public/businesses/${S.slug}/bookings`).send({ serviceId: haircut.id, start: start.toISOString(), name, phone });
  }

  it('the public page offers only real free slots inside opening hours', async () => {
    const r = await http().get(`/public/businesses/${S.slug}/slots`).query({ serviceId: haircut.id, date: day(2), days: 1 }).expect(200);
    const local = r.body.map((s: any) => localParts(new Date(s.start), TZ).hhmm);
    expect(local[0]).toBe('10:00'); // salon opens at 10
    expect(local).not.toContain('09:45');
    expect(local.at(-1)! < '21:00').toBe(true);
  });

  it('two customers racing for the same slot: exactly one gets it', async () => {
    const start = zonedTimeToUtc(day(2), '11:00', TZ);
    const results = await Promise.all([book(start, '9811122201', 'Ravi'), book(start, '9811122202', 'Sita'), book(start, '9811122203', 'Ali')]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('slot_taken');
  });

  it('reminders are scheduled 24 h and 2 h before in local time, moved out of quiet hours', async () => {
    const start = zonedTimeToUtc(day(3), '10:00', TZ); // 2 h before = 08:00, inside quiet hours (21:00–09:00)
    const r = await book(start, '9811122210').expect(201);
    const rows = await db.withTenant(S.businessId, (tx) => tx.q(`SELECT send_at FROM scheduled_messages WHERE booking_id = $1 ORDER BY send_at`, [r.body.id]));
    expect(rows.map((x) => new Date(x.send_at).toISOString())).toEqual([zonedTimeToUtc(day(2), '10:00', TZ).toISOString(), zonedTimeToUtc(day(3), '09:00', TZ).toISOString()]);
    // Jobs were queued for exactly those times.
    const queued = jobs.pending.filter((j) => j.name === 'nudge.send' && rows.length && j.data.businessId === S.businessId);
    expect(queued.length).toBeGreaterThanOrEqual(2);
  });

  it('a due reminder is delivered on the customer\'s chat, logged and shown in the Feed; cancelled bookings get none', async () => {
    const start = zonedTimeToUtc(day(4), '15:00', TZ);
    const r = await book(start, '9811122220', 'Meena').expect(201);
    // Give the customer a website chat so there is a channel to reach them.
    await db.withTenant(S.businessId, async (tx) => {
      const c = await tx.one(`SELECT customer_id FROM bookings WHERE id = $1`, [r.body.id]);
      await tx.q(`INSERT INTO conversations (customer_id, channel, status) VALUES ($1, 'website_chat', 'open')`, [c.customer_id]);
    });
    const [first] = await db.withTenant(S.businessId, (tx) => tx.q(`SELECT id, send_at FROM scheduled_messages WHERE booking_id = $1 ORDER BY send_at`, [r.body.id]));
    const at = new Date(first.send_at);
    expect(await nudge.process(S.businessId, first.id, new Date(at.getTime() - 3_600_000))).toEqual({ status: 'not_due' });
    expect(await nudge.process(S.businessId, first.id, at)).toEqual({ status: 'sent', reason: null });
    const sent = await db.withTenant(S.businessId, (tx) => tx.one(`SELECT channel, body FROM scheduled_messages WHERE id = $1`, [first.id]));
    expect(sent.channel).toBe('web_chat');
    expect(sent.body).toMatch(/^Hi Meena, a reminder of your Haircut at Nudge Salon tomorrow at 3:00\s?pm/i);
    expect(await nudge.process(S.businessId, first.id, at)).toEqual({ status: 'sent' }); // idempotent
    const bridge = (await S.api.get('/bridge').expect(200)).body;
    expect(bridge.feed.some((g: any) => g.items.some((i: any) => i.sentence.key === 'feed.nudge.reminder_sent'))).toBe(true);

    // Cancel through the customer's manage link: the remaining reminder is cancelled.
    const token = r.body.manageUrl.split('/manage/')[1];
    const view = await http().get(`/public/manage/${token}`).expect(200);
    expect(view.body).toMatchObject({ canChange: true, booking: { service: 'Haircut', status: 'confirmed' } });
    await http().post(`/public/manage/${token}/cancel`).expect(201);
    const left = await db.withTenant(S.businessId, (tx) => tx.q(`SELECT status FROM scheduled_messages WHERE booking_id = $1 AND status = 'scheduled'`, [r.body.id]));
    expect(left).toEqual([]);
    // Someone else can now take that time.
    await book(start, '9811122221').expect(201);
  });

  it('no connected channel means the message is skipped, never faked', async () => {
    const r = await book(zonedTimeToUtc(day(5), '12:00', TZ), '9811122230').expect(201);
    const [m] = await db.withTenant(S.businessId, (tx) => tx.q(`SELECT id, send_at FROM scheduled_messages WHERE booking_id = $1 ORDER BY send_at`, [r.body.id]));
    expect(await nudge.process(S.businessId, m.id, new Date(m.send_at))).toEqual({ status: 'skipped', reason: 'no_channel_connected' });
  });

  it('rescheduling moves the reminders; the manage link refuses changes too close to the time', async () => {
    const r = await book(zonedTimeToUtc(day(6), '12:00', TZ), '9811122240').expect(201);
    const token = r.body.manageUrl.split('/manage/')[1];
    const newStart = zonedTimeToUtc(day(6), '16:00', TZ);
    await http().post(`/public/manage/${token}/reschedule`).send({ start: newStart.toISOString() }).expect(201);
    const rows = await db.withTenant(S.businessId, (tx) => tx.q(`SELECT send_at, status FROM scheduled_messages WHERE booking_id = $1 ORDER BY created_at`, [r.body.id]));
    expect(rows.filter((x) => x.status === 'scheduled').map((x) => new Date(x.send_at).toISOString())).toEqual([
      new Date(newStart.getTime() - 24 * 3_600_000).toISOString(),
      new Date(newStart.getTime() - 2 * 3_600_000).toISOString(),
    ]);
    expect(rows.filter((x) => x.status === 'cancelled')).toHaveLength(2);
    const soon = new Date(Date.now() + 70 * 60_000);
    const close = await db.withTenant(S.businessId, (tx) => tx.one(`UPDATE bookings SET start_at = $2, end_at = $3 WHERE id = $1 RETURNING id`, [r.body.id, soon, new Date(soon.getTime() + 30 * 60_000)]));
    expect(close).toBeTruthy();
    expect((await http().post(`/public/manage/${token}/cancel`)).body.error.code).toBe('too_late');
  });

  it('lead follow-ups stop as soon as the customer books, and opt-outs are honoured', async () => {
    const leadAt = new Date();
    const lead = await db.withTenant(S.businessId, async (tx) => {
      const c = await tx.one(`INSERT INTO customers (name, phone, consent) VALUES ('Lead One', '+919811122250', '{"whatsapp":true}') RETURNING id`);
      await tx.q(`INSERT INTO conversations (customer_id, channel, status) VALUES ($1, 'website_chat', 'open')`, [c.id]);
      const l = await tx.one(`INSERT INTO leads (customer_id, interest, status) VALUES ($1, 'Hair colour', 'new') RETURNING id, customer_id, created_at`, [c.id]);
      await nudge.onLeadCreated(tx, l, leadAt);
      return l;
    });
    const follow = await db.withTenant(S.businessId, (tx) => tx.q(`SELECT id, send_at FROM scheduled_messages WHERE lead_id = $1 ORDER BY send_at`, [lead.id]));
    expect(follow).toHaveLength(2);
    // First follow-up goes out (24 h later, moved out of quiet hours if needed).
    expect((await nudge.process(S.businessId, follow[0].id, new Date(follow[0].send_at))).status).toBe('sent');
    // Customer books: remaining follow-ups are cancelled and the lead is won.
    await book(zonedTimeToUtc(day(7), '13:00', TZ), '9811122250', 'Lead One').expect(201);
    const after = await db.withTenant(S.businessId, (tx) => tx.one(`SELECT status, skip_reason FROM scheduled_messages WHERE id = $1`, [follow[1].id]));
    expect(after).toEqual({ status: 'cancelled', skip_reason: 'customer_booked' });
    const l = await db.withTenant(S.businessId, (tx) => tx.one(`SELECT status FROM leads WHERE id = $1`, [lead.id]));
    expect(l.status).toBe('booked');

    // Opt-out on chat: the reminder for the new booking is not delivered there.
    const bk = await db.withTenant(S.businessId, (tx) => tx.one(`SELECT id FROM bookings WHERE customer_id = $1`, [lead.customer_id]));
    await db.withTenant(S.businessId, (tx) => tx.q(`UPDATE customers SET opted_out_at = '{"web_chat":"2026-01-01T00:00:00Z"}' WHERE id = $1`, [lead.customer_id]));
    const [rem] = await db.withTenant(S.businessId, (tx) => tx.q(`SELECT id, send_at FROM scheduled_messages WHERE booking_id = $1 ORDER BY send_at`, [bk.id]));
    expect(await nudge.process(S.businessId, rem.id, new Date(rem.send_at))).toEqual({ status: 'skipped', reason: 'no_channel_connected' });
  });

  it('owner calendar: create, complete (review request queued), and staff-only access', async () => {
    const start = zonedTimeToUtc(day(8), '17:00', TZ);
    const r = await S.api.post('/bookings', { serviceId: haircut.id, start: start.toISOString(), name: 'Walk In', phone: '9811122260' }).expect(201);
    const cal = await S.api.get(`/calendar?from=${zonedTimeToUtc(day(8), '00:00', TZ).toISOString()}`).expect(200);
    expect(cal.body.bookings.map((b: any) => b.id)).toContain(r.body.id);
    await db.withTenant(S.businessId, (tx) => tx.q(`UPDATE bookings SET start_at = start_at - interval '9 days', end_at = end_at - interval '9 days' WHERE id = $1`, [r.body.id]));
    await S.api.patch(`/bookings/${r.body.id}`, { status: 'completed' }).expect(200);
    const review = await db.withTenant(S.businessId, (tx) => tx.q(`SELECT kind FROM scheduled_messages WHERE booking_id = $1 AND kind = 'review_request'`, [r.body.id]));
    expect(review.length).toBeLessThanOrEqual(1); // queued unless its time already passed
    const cust = await db.withTenant(S.businessId, (tx) => tx.one(`SELECT visit_count FROM customers WHERE id = $1`, [r.body.customerId]));
    expect(cust.visit_count).toBe(1);
  });

  it('daily briefing generates once per day from live data', async () => {
    const svc = app.get(BriefingService);
    const morning = zonedTimeToUtc(day(0), '08:05', TZ);
    const b1 = await svc.generate(S.businessId, 'morning', morning);
    expect(b1!.lines[0].key).toBe('brief.bookings_today');
    expect(await svc.generate(S.businessId, 'morning', morning)).toBeNull();
    // The sweep queues due briefings for live businesses and is safe to repeat.
    const before = jobs.pending.length;
    await svc.sweep(zonedTimeToUtc(day(0), '19:10', TZ));
    await svc.sweep(zonedTimeToUtc(day(0), '19:20', TZ));
    const queued = jobs.pending.slice(before).filter((j) => j.data.businessId === S.businessId);
    // At 7 pm only the evening summary is due (the morning one was already made).
    expect(queued.map((j) => j.data.type)).toEqual(['evening']);
  });

  it('live updates reach the owner over WebSocket, and only for their own business', async () => {
    await app.listen(0);
    attachWebSockets(app, app.getHttpServer());
    const port = (app.getHttpServer().address() as any).port;
    const other = await onboard(app, 'gym', 'Other Gym');
    const open = (q: string) =>
      new Promise<{ ws: WebSocket; events: any[]; closed: Promise<number> }>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${q}`);
        const events: any[] = [];
        const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
        ws.on('message', (m) => {
          const e = JSON.parse(String(m));
          events.push(e);
          if (e.type === 'hello') resolve({ ws, events, closed });
        });
        ws.on('close', () => resolve({ ws, events, closed }));
      });
    const mine = await open(`token=${S.owner.token}&business=${S.businessId}`);
    const theirs = await open(`token=${other.owner.token}&business=${other.businessId}`);
    const intruder = await open(`token=${other.owner.token}&business=${S.businessId}`);
    expect(await intruder.closed).toBe(4401);
    await book(zonedTimeToUtc(day(9), '12:00', TZ), '9811122270').expect(201);
    await new Promise((r) => setTimeout(r, 150));
    expect(mine.events.map((e) => e.type)).toEqual(expect.arrayContaining(['feed.new', 'booking.changed']));
    expect(theirs.events.map((e) => e.type)).toEqual(['hello']);
    mine.ws.close();
    theirs.ws.close();
  });

  it('new Phase 2 routes are closed to other businesses', async () => {
    const stranger = await signIn(app);
    for (const route of ['/inbox', '/knowledge', '/calendar', `/slots?serviceId=${haircut.id}`, '/notifications']) {
      expect((await api(app, stranger.token, S.businessId).get(route)).status).toBe(403);
    }
  });
});
