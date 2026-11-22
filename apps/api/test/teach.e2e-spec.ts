/**
 * Phase 5 acceptance: Teach Orbit by talking.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { addDays, localParts, translate, weekdayOf, zonedTimeToUtc } from '@orbit/shared';
import { AiService } from '../src/ai/ai.service';
import { DbService } from '../src/db/db.service';
import { TeachService } from '../src/teach/teach.service';
import { text } from '../src/ai/fake.provider';
import { api, bootApp, onboard, signIn, upgrade } from './helpers';

type Biz = Awaited<ReturnType<typeof onboard>>;
const TZ = 'Asia/Kolkata';
const today = () => localParts(new Date(), TZ).date;
const nextMonday = () => addDays(today(), 7 - ((new Date(`${today()}T12:00:00Z`).getUTCDay() + 6) % 7));

describe('Teach Orbit by talking', () => {
  let app: NestExpressApplication;
  let db: DbService;
  let S: Biz;
  const fake = () => app.get(AiService).fake!;
  const http = () => request(app.getHttpServer());
  const tenant = (fn: (tx: any) => Promise<any>, biz = S): Promise<any> => db.withTenant(biz.businessId, fn);
  /** The AI's reading of the instruction (the real model gets the same prompt). */
  const reads = (out: unknown) => {
    fake().script = (req) => (req.system.startsWith('KIND: teach') ? [text(JSON.stringify(out))] : [text('ok')]);
  };
  let service: { id: string; name: string; price: number };
  let customerId: string;

  const book = async (day: string, time = '11:00', staffId: string | null = null) =>
    tenant(async (tx) => {
      const start = zonedTimeToUtc(day, time, TZ);
      const r = await tx.one(
        `INSERT INTO bookings (service_id, customer_id, staff_id, start_at, end_at, status, price) VALUES ($1, $2, $3, $4, $5, 'confirmed', $6) RETURNING id`,
        [service.id, customerId, staffId, start, new Date(start.getTime() + 30 * 60_000), service.price],
      );
      return r.id as string;
    });

  beforeAll(async () => {
    app = await bootApp();
    db = app.get(DbService);
    S = await onboard(app, 'salon', 'Teach Salon');
    await upgrade(app, S.businessId, 'pro');
    service = await tenant((tx) => tx.one(`SELECT id, name, price::float AS price FROM services WHERE deleted_at IS NULL ORDER BY sort_order LIMIT 1`));
    customerId = (await tenant((tx) => tx.one(`INSERT INTO customers (name, phone, language) VALUES ('Rahul Verma', '+919812345678', 'en') RETURNING id`))).id;
    // Open every day 10–20 so the test does not depend on the template's hours.
    const open = { open: true, ranges: [{ from: '10:00', to: '20:00' }] };
    await tenant((tx) => tx.q(`UPDATE business_profiles SET hours = $1`, [JSON.stringify(Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, open])))]));
  });
  beforeEach(() => fake().reset());
  afterAll(() => app.close());

  it('"Closed on Tuesdays from next week": exact dates, affected bookings, nothing saved until Save; then booking stops; Undo puts it back', async () => {
    const tue = addDays(nextMonday(), 1);
    expect(weekdayOf(tue)).toBe('tue');
    const bookingId = await book(tue);
    reads({ kind: 'teach', question: null, changes: [{ type: 'update_hours', days: ['tue'], ranges: [], from: nextMonday() }] });

    const p = (await S.api.post('/teach', { text: 'Closed on Tuesdays from next week' }).expect(201)).body;
    expect(fake().calls[0].system).toContain(`TODAY: ${today()}`);
    expect(p.status).toBe('preview');
    expect(p.lines).toEqual([
      { type: 'update_hours', before: { key: 'teach.line.hours', params: { day: '@teach.day.tue', hours: '10:00–20:00' } }, after: { key: 'teach.line.hours', params: { day: '@teach.day.tue', hours: '@teach.closed' } }, from: nextMonday(), to: null },
    ]);
    expect(p.affected).toEqual([expect.objectContaining({ bookingId, customer: 'Rahul', reason: 'closed' })]);
    // Not saved yet: that Tuesday still has times.
    const slots = async () => (await S.api.get(`/slots?serviceId=${service.id}&date=${tue}&days=1`).expect(200)).body;
    const before = await slots();
    expect((before.slots ?? before).length).toBeGreaterThan(0);

    const c = (await S.api.post(`/teach/${p.id}/confirm`, { choices: { [bookingId]: 'message' } }).expect(201)).body;
    expect(c).toMatchObject({ status: 'applied', messaged: 1 });
    const prof = await tenant((tx) => tx.one(`SELECT hours, hours_changes FROM business_profiles`));
    expect(prof.hours.tue.open).toBe(true); // this week is unchanged
    expect(prof.hours_changes).toEqual([{ from: nextMonday(), hours: expect.objectContaining({ tue: { open: false, ranges: [] } }) }]);
    const after = await slots();
    expect((after.slots ?? after).length).toBe(0);
    // Rahul's message waits in the Undo window, in his language.
    const held = await tenant((tx) => tx.one(`SELECT payload FROM held_actions ORDER BY created_at DESC LIMIT 1`));
    expect(held.payload).toMatchObject({ kind: 'message', customerId });
    expect(held.payload.text).toMatch(/^Hi Rahul, Teach Salon will be closed on Tuesday/);
    // The feed says what Orbit learned, with Why?
    const feed = await tenant((tx) => tx.one(`SELECT sentence, trace_id FROM feed_events WHERE event_type = 'teach_applied' ORDER BY at DESC LIMIT 1`));
    expect(feed.sentence).toEqual({ key: 'feed.orbit.teach', params: { count: 1 } });
    expect(feed.trace_id).toBeTruthy();

    await S.api.post(`/teach/${p.id}/undo`).expect(201);
    expect((await tenant((tx) => tx.one(`SELECT hours_changes FROM business_profiles`))).hours_changes).toEqual([]);
    expect(((await slots()).slots ?? (await slots())).length).toBeGreaterThan(0);
    await tenant((tx) => tx.q(`DELETE FROM bookings WHERE id = $1`, [bookingId]));
  });

  it('when hours that start later are due, they become the regular hours', async () => {
    const tomorrow = addDays(today(), 1);
    const hours = (await tenant((tx) => tx.one(`SELECT hours FROM business_profiles`))).hours;
    await tenant((tx) => tx.q(`UPDATE business_profiles SET hours_changes = $1`, [JSON.stringify([{ from: tomorrow, hours: { ...hours, sun: { open: false, ranges: [] } } }])]));
    await app.get(TeachService).applyDueHours(new Date());
    expect((await tenant((tx) => tx.one(`SELECT hours_changes FROM business_profiles`))).hours_changes).toHaveLength(1);
    await app.get(TeachService).applyDueHours(new Date(Date.now() + 2 * 86_400_000));
    const p = await tenant((tx) => tx.one(`SELECT hours, hours_changes FROM business_profiles`));
    expect(p.hours_changes).toEqual([]);
    expect(p.hours.sun).toEqual({ open: false, ranges: [] });
    await tenant((tx) => tx.q(`UPDATE business_profiles SET hours = $1`, [JSON.stringify(hours)]));
  });

  it('works offline too: the demo reader understands plain sentences', async () => {
    const p = (await S.api.post('/teach', { text: 'We are closed on Tuesdays from next week' }).expect(201)).body;
    expect(p.changes).toEqual([{ type: 'update_hours', days: ['tue'], ranges: [], from: nextMonday() }]);
    await S.api.post(`/teach/${p.id}/cancel`).expect(201);
  });

  it('something unclear gets one question back, and nothing changes', async () => {
    reads({ kind: 'question', question: 'Which day, and what are the new times?', changes: [] });
    const p = (await S.api.post('/teach', { text: 'change the timings' }).expect(201)).body;
    expect(p).toMatchObject({ status: 'question', question: 'Which day, and what are the new times?', changes: [] });
    expect((await S.api.post(`/teach/${p.id}/confirm`, {})).status).toBe(400);
  });

  it('a service the business does not have is flagged, not guessed', async () => {
    reads({ kind: 'teach', changes: [{ type: 'update_service', service: 'Pedicure deluxe', price: 900 }] });
    const p = (await S.api.post('/teach', { text: 'Pedicure deluxe is now 900' }).expect(201)).body;
    expect(p.status).toBe('question');
    expect(p.conflicts).toEqual([{ key: 'teach.conflict.no_service', params: { service: 'Pedicure deluxe' } }]);
  });

  it('a price change, FAQ and leave in one go; each part can be undone', async () => {
    const staff = (await tenant((tx) => tx.one(`INSERT INTO staff (name) VALUES ('Priya Nair') RETURNING id`))).id;
    const day = addDays(today(), 10);
    const onLeave = await book(day, '12:00', staff);
    reads({
      kind: 'teach',
      changes: [
        { type: 'update_service', service: service.name.toLowerCase(), price: 375 },
        { type: 'add_faq', question: 'Is there parking?', answer: 'Yes, free parking in the basement.' },
        { type: 'staff_leave', staff: 'priya', from: day, to: addDays(day, 2) },
      ],
    });
    const p = (await S.api.post('/teach', { text: 'haircut 375 now, parking in basement, priya on leave' }).expect(201)).body;
    expect(p.changes[0]).toMatchObject({ service: service.name, serviceId: service.id });
    expect(p.changes[2]).toMatchObject({ staff: 'Priya Nair', staffId: staff });
    expect(p.affected).toEqual([expect.objectContaining({ bookingId: onLeave, reason: 'leave', staff: 'Priya Nair' })]);
    const heldBefore = (await tenant((tx) => tx.one(`SELECT count(*)::int AS n FROM held_actions`))).n;
    await S.api.post(`/teach/${p.id}/confirm`, {}).expect(201); // default: keep the booking, no message
    expect((await tenant((tx) => tx.one(`SELECT price::float AS p FROM services WHERE id = $1`, [service.id]))).p).toBe(375);
    expect((await tenant((tx) => tx.one(`SELECT leave FROM staff WHERE id = $1`, [staff]))).leave).toEqual([{ from: day, to: addDays(day, 2) }]);
    const faq = await tenant((tx) => tx.one(`SELECT id, source FROM knowledge_items WHERE title = 'Is there parking?' AND deleted_at IS NULL`));
    expect(faq.source).toBe('teach');
    expect((await tenant((tx) => tx.one(`SELECT count(*)::int AS n FROM held_actions`))).n).toBe(heldBefore);
    // Each change is in Recent changes (Teach), and Undo on the teach reverts them all.
    const changes = (await S.api.get('/trust/changes').expect(200)).body.filter((c: any) => c.source === 'teach');
    expect(changes.map((c: any) => c.label.key)).toEqual(expect.arrayContaining(['change.teach_service', 'change.teach_knowledge', 'change.teach_leave']));
    await S.api.post(`/teach/${p.id}/undo`).expect(201);
    expect((await tenant((tx) => tx.one(`SELECT price::float AS p FROM services WHERE id = $1`, [service.id]))).p).toBe(service.price);
    expect((await tenant((tx) => tx.one(`SELECT leave FROM staff WHERE id = $1`, [staff]))).leave).toEqual([]);
    expect(await tenant((tx) => tx.one(`SELECT 1 FROM knowledge_items WHERE id = $1 AND deleted_at IS NULL`, [faq.id]))).toBeFalsy();
  });

  it('staff can teach, but a price change waits for the owner on Needs You', async () => {
    const st = await signIn(app);
    await db.adminTx((tx: any) => tx.q(`INSERT INTO memberships (user_id, business_id, role) VALUES ($1, $2, 'staff')`, [st.userId, S.businessId]));
    const staffApi = api(app, st.token, S.businessId);
    reads({ kind: 'teach', changes: [{ type: 'update_service', service: service.name, price: 400 }] });
    const p = (await staffApi.post('/teach', { text: `${service.name} is now 400` }).expect(201)).body;
    expect(p.needsOwner).toBe(true);
    const r = (await staffApi.post(`/teach/${p.id}/confirm`, {}).expect(201)).body;
    expect(r.status).toBe('needs_owner');
    expect((await tenant((tx) => tx.one(`SELECT price::float AS p FROM services WHERE id = $1`, [service.id]))).p).toBe(service.price);
    const card = (await S.api.get('/bridge').expect(200)).body.needsYou.find((c: any) => c.type === 'teach_approval');
    expect(card.title).toMatchObject({ key: 'card.teach_approval' });
    await S.api.post(`/bridge/cards/${card.id}/decide`, { option: 'approve' }).expect(201);
    expect((await tenant((tx) => tx.one(`SELECT price::float AS p FROM services WHERE id = $1`, [service.id]))).p).toBe(400);
    expect((await S.api.get(`/teach/${p.id}`).expect(200)).body.status).toBe('applied');
    await tenant((tx) => tx.q(`UPDATE services SET price = $2 WHERE id = $1`, [service.id, service.price]));
  });

  it('"Never more than 10% off": Aria may offer 10%, a 15% offer is blocked and goes to the owner', async () => {
    reads({ kind: 'teach', changes: [{ type: 'set_rule', maxDiscountPct: 10 }] });
    const p = (await S.api.post('/teach', { text: 'Never give more than 10% discount' }).expect(201)).body;
    await S.api.post(`/teach/${p.id}/confirm`, {}).expect(201);
    expect((await tenant((tx) => tx.one(`SELECT guardrails FROM business_profiles`))).guardrails).toEqual({ maxDiscountPct: 10 });

    const chat = async (reply: string) => {
      const s = await http().post(`/public/businesses/${S.slug}/chat`).send({ channel: 'website_chat' }).expect(201);
      fake().script = () => [text(reply)];
      const r = await http().post(`/public/businesses/${S.slug}/chat/${s.body.conversationId}/messages`).set('x-visitor-token', s.body.visitorToken).send({ text: 'Any discount for students?' }).expect(201);
      const conv = await tenant((tx) => tx.one(`SELECT handled_by FROM conversations WHERE id = $1`, [s.body.conversationId]));
      return { text: r.body.messages[r.body.messages.length - 1].body, handledBy: conv.handled_by, system: fake().calls.find((c: any) => !c.system.startsWith('KIND'))!.system as string };
    };
    const ok = await chat('Yes! Students get 10% off.');
    expect(ok.system).toContain('at most 10%');
    expect(ok).toMatchObject({ text: 'Yes! Students get 10% off.', handledBy: 'aria' });
    const blocked = await chat('Sure, I can give you 15% off today!');
    expect(blocked.text).toBe(translate('en', 'aria.auto.discount_check'));
    expect(blocked.handledBy).not.toBe('aria');
  });

  it('not a change: says so; another business cannot read it', async () => {
    reads({ kind: 'not_teach', changes: [] });
    const p = (await S.api.post('/teach', { text: 'how many bookings today?' }).expect(201)).body;
    expect(p.status).toBe('not_teach');
    const other = await onboard(app, 'gym', 'Other Gym Teach');
    expect((await other.api.get(`/teach/${p.id}`)).status).toBe(404);
    expect((await other.api.post(`/teach/${p.id}/confirm`, {})).status).toBe(404);
  });

  it('Ask Orbit: "closed on 25 Dec" shows a Teach card in the Command Bar', async () => {
    const r = await app.get(TeachService).teach(S.businessId, S.owner.userId, 'owner', { text: 'We are closed on 25 Dec' });
    expect(r.changes[0]).toMatchObject({ type: 'add_closure', from: expect.stringMatching(/-12-25$/) });
  });
});
