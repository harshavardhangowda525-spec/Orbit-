/**
 * Phase 5 acceptance: natural booking changes (late, add-on, confirm, waitlist, no-show check-in).
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { addDays, localParts, zonedTimeToUtc } from '@orbit/shared';
import { AiService } from '../src/ai/ai.service';
import { DbService } from '../src/db/db.service';
import { BookingChangesService } from '../src/bookings/booking-changes.service';
import { BookingsService } from '../src/bookings/bookings.service';
import { text, toolUse } from '../src/ai/fake.provider';
import { bootApp, onboard, upgrade } from './helpers';

type Biz = Awaited<ReturnType<typeof onboard>>;
const TZ = 'Asia/Kolkata';

describe('Natural booking changes', () => {
  let app: NestExpressApplication;
  let db: DbService;
  let S: Biz;
  const fake = () => app.get(AiService).fake!;
  const http = () => request(app.getHttpServer());
  const tenant = (fn: (tx: any) => Promise<any>): Promise<any> => db.withTenant(S.businessId, fn);
  const changes = () => app.get(BookingChangesService);
  let svc: any;
  let addOn: any;
  const day = addDays(localParts(new Date(), TZ).date, 3);
  const customer = async (name: string, phone: string) => (await tenant((tx) => tx.one(`INSERT INTO customers (name, phone, language) VALUES ($1, $2, 'en') RETURNING id`, [name, phone]))).id as string;
  const book = (customerId: string, time: string, minutes = 30, start?: Date) =>
    tenant(async (tx) => {
      const s = start ?? zonedTimeToUtc(day, time, TZ);
      return (await tx.one(`INSERT INTO bookings (service_id, customer_id, start_at, end_at, status, price) VALUES ($1, $2, $3, $4, 'confirmed', $5) RETURNING *`, [svc.id, customerId, s, new Date(s.getTime() + minutes * 60_000), svc.price]));
    });

  beforeAll(async () => {
    app = await bootApp();
    db = app.get(DbService);
    S = await onboard(app, 'salon', 'Changes Salon');
    await upgrade(app, S.businessId, 'pro');
    [svc, addOn] = await tenant((tx) => tx.q(`SELECT id, name, price::float AS price, duration_min FROM services WHERE deleted_at IS NULL ORDER BY duration_min, name`)).then((r: any[]) => [r.find((x) => x.duration_min === 30), r.find((x) => x.duration_min === 15)]);
    const open = { open: true, ranges: [{ from: '09:00', to: '21:00' }] };
    await tenant((tx) => tx.q(`UPDATE business_profiles SET hours = $1`, [JSON.stringify(Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, open])))]));
    await tenant((tx) => tx.q(`DELETE FROM staff`).catch(() => null));
  });
  beforeEach(() => fake().reset());
  afterAll(() => app.close());

  it('running late: fits before the next booking → the team is told; too late → other times are offered', async () => {
    const rahul = await customer('Rahul', '+919800000001');
    const bk = await book(rahul, '11:00');
    const fits = await tenant((tx) => changes().runningLate(tx, rahul, bk.id, 10, 'aria', 'en'));
    expect(fits).toMatchObject({ ok: true, fits: true });
    expect((await tenant((tx) => tx.one(`SELECT late_minutes FROM bookings WHERE id = $1`, [bk.id]))).late_minutes).toBe(10);
    expect(await tenant((tx) => tx.one(`SELECT title FROM notifications WHERE type = 'booking_change' ORDER BY created_at DESC LIMIT 1`))).toMatchObject({ title: { key: 'notify.booking.late', params: { customer: 'Rahul', minutes: 10 } } });
    // Someone is right after: 40 minutes late no longer fits.
    const next = await book(await customer('Anita', '+919800000002'), '11:30');
    const late = await tenant((tx) => changes().runningLate(tx, rahul, bk.id, 40, 'aria', 'en'));
    expect(late).toMatchObject({ ok: true, fits: false });
    expect((late as any).options.length).toBeGreaterThan(0);
    // Not their booking: refused.
    expect(await tenant((tx) => changes().runningLate(tx, rahul, next.id, 5, 'aria', 'en'))).toMatchObject({ ok: false });
  });

  it('add-on: added when there is room, price and time extended; not when the next booking is right after', async () => {
    const meena = await customer('Meena', '+919800000003');
    const bk = await book(meena, '15:00');
    const r: any = await tenant((tx) => changes().addToBooking(tx, meena, bk.id, addOn.id, 'aria'));
    expect(r).toMatchObject({ ok: true, added: true, service: addOn.name });
    const after = await tenant((tx) => tx.one(`SELECT end_at, price::float AS price, add_ons FROM bookings WHERE id = $1`, [bk.id]));
    expect(new Date(after.end_at).getTime() - new Date(bk.end_at).getTime()).toBe(addOn.duration_min * 60_000);
    expect(after.price).toBe(svc.price + addOn.price);
    expect(after.add_ons).toEqual([expect.objectContaining({ serviceId: addOn.id })]);
    await book(await customer('Kiran', '+919800000004'), '15:45');
    expect(await tenant((tx) => changes().addToBooking(tx, meena, bk.id, addOn.id, 'aria'))).toMatchObject({ ok: true, added: false });
  });

  it('waitlist: when someone cancels, the first person waiting for that service and day gets the time', async () => {
    const waiting = await customer('Sana', '+919800000005');
    await tenant((tx) => changes().joinWaitlist(tx, waiting, svc.id, day, 'aria'));
    const owner = await customer('Vikram', '+919800000006');
    const bk = await book(owner, '17:00');
    await tenant((tx) => app.get(BookingsService).cancel(tx, bk.id, 'customer via chat', 'aria'));
    const w = await tenant((tx) => tx.one(`SELECT status, offered_booking_slot FROM waitlist_entries WHERE customer_id = $1`, [waiting]));
    expect(w.status).toBe('offered');
    expect(new Date(w.offered_booking_slot).getTime()).toBe(new Date(bk.start_at).getTime());
    expect(await tenant((tx) => tx.one(`SELECT sentence FROM feed_events WHERE event_type = 'waitlist_offered' ORDER BY at DESC LIMIT 1`))).toMatchObject({ sentence: { key: 'feed.aria.waitlist_offer', params: { customer: 'Sana' } } });
  });

  it('no-show: 15 minutes after the start with no arrival, one check-in message and the team is told (once)', async () => {
    const c = await customer('Arjun', '+919800000007');
    const bk = await book(c, '', 30, new Date(Date.now() - 20 * 60_000));
    expect(await changes().noShowSweep()).toBeGreaterThanOrEqual(1);
    expect((await tenant((tx) => tx.one(`SELECT noshow_checked_at FROM bookings WHERE id = $1`, [bk.id]))).noshow_checked_at).toBeTruthy();
    expect(await tenant((tx) => tx.one(`SELECT title FROM notifications WHERE type = 'booking_change' ORDER BY created_at DESC LIMIT 1`))).toMatchObject({ title: { key: 'notify.booking.not_arrived', params: { customer: 'Arjun' } } });
    const again = await changes().noShowSweep();
    expect(await tenant((tx) => tx.one(`SELECT count(*)::int AS n FROM notifications WHERE type = 'booking_change' AND title->>'key' = 'notify.booking.not_arrived'`))).toEqual({ n: 1 });
    expect(again).toBe(0);
  });

  it('in chat: "thoda late ho jaunga, 10 min" → Aria uses running_late and confirms', async () => {
    const s = await http().post(`/public/businesses/${S.slug}/chat`).send({ channel: 'website_chat' }).expect(201);
    const c = await customer('Pooja', '+919800000008');
    await tenant((tx) => tx.q(`UPDATE conversations SET customer_id = $2 WHERE id = $1`, [s.body.conversationId, c]));
    const bk = await book(c, '19:00');
    fake().script = (req, turn) => {
      if (turn === 0) {
        expect(req.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['running_late', 'add_to_booking', 'confirm_booking', 'join_waitlist']));
        return [toolUse('running_late', { booking_id: bk.id, minutes: 10 })];
      }
      return [text('No problem, I have told the team you will be 10 minutes late.')];
    };
    const r = await http().post(`/public/businesses/${S.slug}/chat/${s.body.conversationId}/messages`).set('x-visitor-token', s.body.visitorToken).send({ text: 'thoda late ho jaunga, 10 min' }).expect(201);
    expect(r.body.messages[r.body.messages.length - 1].body).toMatch(/10 minutes late/);
    expect((await tenant((tx) => tx.one(`SELECT late_minutes FROM bookings WHERE id = $1`, [bk.id]))).late_minutes).toBe(10);
  });
});
