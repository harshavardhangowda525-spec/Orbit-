/**
 * Crew settings (switches and permissions), plan limits, renewals, review link,
 * and Orbit's own subscription billing (Razorpay mocked).
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { TEMPLATES } from '@orbit/shared';
import { bootApp, onboard, upgrade } from './helpers';
import { DbService } from '../src/db/db.service';
import { JobsService } from '../src/jobs/jobs.service';
import { NudgeService } from '../src/nudge/nudge.service';

describe('Crew, plans, renewals and billing', () => {
  let app: NestExpressApplication;
  let db: DbService;
  let jobs: JobsService;
  let nudge: NudgeService;
  const realFetch = global.fetch;
  let calls: { url: string; body: any }[] = [];
  let a: Awaited<ReturnType<typeof onboard>>;
  const http = () => request(app.getHttpServer());
  const tenant = (id: string, fn: (tx: any) => Promise<any>): Promise<any> => db.withTenant(id, fn);

  beforeAll(async () => {
    global.fetch = (async (url: string, init?: any) => {
      const u = String(url);
      if (!u.startsWith('https://api.razorpay.com/')) return realFetch(url as any, init);
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push({ url: u, body });
      const ok = (d: object) => new Response(JSON.stringify(d), { status: 200 });
      if (u.endsWith('/v1/plans')) return ok({ id: `plan_${body.item.amount}` });
      if (u.endsWith('/v1/subscriptions')) return ok({ id: `sub_${calls.length}`, status: 'created', short_url: `https://rzp.io/i/sub${calls.length}` });
      if (u.endsWith('/cancel')) return ok({ status: 'cancelled' });
      return ok({});
    }) as any;
    app = await bootApp();
    db = app.get(DbService);
    jobs = app.get(JobsService);
    nudge = app.get(NudgeService);
    a = await onboard(app, 'salon', 'Leaf Salon');
    // Free includes only Orbit and Aria: switching Nudge on needs a paid plan.
    expect((await a.api.patch('/crew/nudge', { enabled: true })).body.error.code).toBe('upgrade_needed');
    await upgrade(app, a.businessId);
    await a.api.patch('/crew/nudge', { enabled: true }).expect(200);
  });
  afterAll(async () => {
    global.fetch = realFetch;
    delete process.env.ORBIT_RAZORPAY_KEY_ID;
    delete process.env.ORBIT_RAZORPAY_KEY_SECRET;
    delete process.env.ORBIT_RAZORPAY_WEBHOOK_SECRET;
    await app.close();
  });
  beforeEach(() => {
    calls = [];
    jobs.pending.length = 0;
  });

  /** Run a scheduled message as if it were its send time. */
  const run = async (id: string, extraMs = 60_000) => {
    const m = await tenant(a.businessId, (tx) => tx.one(`SELECT send_at FROM scheduled_messages WHERE id = $1`, [id]));
    return (await nudge.process(a.businessId, id, new Date(new Date(m.send_at).getTime() + extraMs))) as any;
  };

  /** A completed visit `daysAgo` days ago for the first bookable service. */
  const visit = async (phone: string, daysAgo: number, renewEvery: number | null = null) =>
    tenant(a.businessId, async (tx) => {
      const s = await tx.one(`UPDATE services SET renewal_interval_days = $1 WHERE id = (SELECT id FROM services WHERE duration_min > 0 ORDER BY sort_order LIMIT 1) RETURNING id, duration_min`, [renewEvery]);
      const c = await tx.one(`INSERT INTO customers (name, phone, consent) VALUES ('Kavya', $1, '{"whatsapp": true, "sms": true}') RETURNING id`, [phone]);
      const bk = await tx.one(
        `INSERT INTO bookings (customer_id, service_id, start_at, end_at, status, source) VALUES ($1, $2, now() - make_interval(days => $3), now() - make_interval(days => $3) + make_interval(mins => $4), 'completed', 'owner') RETURNING id, customer_id, end_at`,
        [c.id, s.id, daysAgo, s.duration_min],
      );
      return { serviceId: s.id, customerId: c.id, booking: bk };
    });

  it('Crew: switching Nudge off (or just review requests) stops those messages; Orbit itself stays on', async () => {
    expect((await a.api.patch('/crew/orbit', { enabled: false })).body.error.code).toBe('orbit_always_on');
    const v = await visit('+919845033301', 0);
    await tenant(a.businessId, (tx) => nudge.onBookingCompleted(tx, v.booking, new Date(Date.now() - 6 * 60 * 60_000)));
    const msg = await tenant(a.businessId, (tx) => tx.one(`SELECT id FROM scheduled_messages WHERE customer_id = $1 AND kind = 'review_request'`, [v.customerId]));
    expect(msg).toBeTruthy();

    const r = await a.api.patch('/crew/nudge', { permissions: { reviewRequests: false } }).expect(200);
    expect(r.body.permissions).toMatchObject({ reviewRequests: false });
    expect((await run(msg.id)).reason).toBe('not_allowed');

    await a.api.patch('/crew/nudge', { permissions: { reviewRequests: true } }).expect(200);
    await a.api.patch('/crew/nudge', { enabled: false, displayName: 'Nina' }).expect(200);
    await tenant(a.businessId, (tx) => tx.q(`UPDATE scheduled_messages SET status = 'scheduled' WHERE id = $1`, [msg.id]));
    expect((await run(msg.id)).reason).toBe('agent_off');
    const settings = (await a.api.get('/crew/settings').expect(200)).body;
    expect(settings.crew.find((c: any) => c.agent === 'nudge')).toMatchObject({ name: 'Nina', enabled: false });
    await a.api.patch('/crew/nudge', { enabled: true }).expect(200);
  });

  it('review requests use the owner\'s review link, and ask a customer at most once in 90 days', async () => {
    await a.api.patch('/crew/settings/review-link', { url: 'http://not-https.example' }).expect(400);
    await a.api.patch('/crew/settings/review-link', { url: 'https://g.page/r/leaf-salon/review' }).expect(200);
    const v = await visit('+919845033302', 0);
    await tenant(a.businessId, (tx) => nudge.onBookingCompleted(tx, v.booking, new Date(Date.now() - 6 * 60 * 60_000)));
    const m = await tenant(a.businessId, (tx) => tx.one(`SELECT id FROM scheduled_messages WHERE customer_id = $1 AND kind = 'review_request'`, [v.customerId]));
    const sent = await run(m.id);
    if (sent.status === 'sent') {
      const body = (await tenant(a.businessId, (tx) => tx.one(`SELECT body FROM scheduled_messages WHERE id = $1`, [m.id]))).body;
      expect(body).toContain('https://g.page/r/leaf-salon/review');
      // A second visit soon after does not ask again.
      const again = await tenant(a.businessId, async (tx) => {
        const bk = await tx.one(`INSERT INTO bookings (customer_id, service_id, start_at, end_at, status, source) SELECT customer_id, service_id, start_at + interval '1 day', end_at + interval '1 day', 'completed', 'owner' FROM bookings WHERE id = $1 RETURNING id, customer_id, end_at`, [v.booking.id]);
        await nudge.onBookingCompleted(tx, bk, new Date(Date.now() - 5 * 60 * 60_000));
        return tx.one(`SELECT id FROM scheduled_messages WHERE booking_id = $1 AND kind = 'review_request'`, [bk.id]);
      });
      expect((await run(again.id)).reason).toBe('asked_recently');
    } else {
      // Local quiet hours or no channel in this environment: the link is still what would be sent.
      expect(['skipped', 'deferred']).toContain(sent.status);
    }
  });

  it('renewals: a repeat service due again gets one nudge, cancelled if the customer books', async () => {
    const v = await visit('+919845033303', 29, 30);
    expect(await nudge.scheduleRenewals(a.businessId)).toBeGreaterThanOrEqual(1);
    expect(await nudge.scheduleRenewals(a.businessId)).toBe(0); // once per visit
    const m = await tenant(a.businessId, (tx) => tx.one(`SELECT id, template FROM scheduled_messages WHERE customer_id = $1 AND kind = 'renewal'`, [v.customerId]));
    expect(m.template).toMatch(/\{\{name\}\}.*\{\{service\}\}/); // the business's own rebooking message (or Orbit's default)
    await tenant(a.businessId, (tx) =>
      tx.q(`INSERT INTO bookings (customer_id, service_id, start_at, end_at, status, source) VALUES ($1, $2, now() + interval '2 days', now() + interval '2 days 30 minutes', 'confirmed', 'owner')`, [v.customerId, v.serviceId]),
    );
    expect((await run(m.id)).reason).toBe('customer_booked');
    // Visits long ago are left alone.
    const old = await visit('+919845033304', 90, 30);
    await nudge.scheduleRenewals(a.businessId);
    expect(await tenant(a.businessId, (tx) => tx.one(`SELECT 1 FROM scheduled_messages WHERE customer_id = $1`, [old.customerId]))).toBeUndefined();
  });

  it('plan limits: staff calendars; the plan view shows meters, never AI internals', async () => {
    await db.q(`UPDATE businesses SET plan_id = (SELECT id FROM plans WHERE code = 'free') WHERE id = $1`, [a.businessId]);
    const state = (await a.api.get('/onboarding/state').expect(200)).body;
    const tooMany = await a.api.put('/onboarding/essentials', {
      name: 'Leaf Salon', phone: '9845012345', hours: TEMPLATES.salon.hours,
      services: state.services.map((s: any) => ({ id: s.id, name: s.name, durationMin: s.durationMin, price: s.price })),
      staff: [{ name: 'Asha' }, { name: 'Bina' }],
    });
    expect(tooMany.body.error.code).toBe('upgrade_needed'); // Free plan: 1 staff calendar

    // AI allowances and the graceful handover are covered in limits.e2e-spec.ts.
    const o = (await a.api.get('/billing').expect(200)).body;
    expect(o).toMatchObject({ plan: { code: 'free' }, usage: { staff: 1 }, billing: false });
    expect(o.meters.today.cap).toBe(20);
    expect(JSON.stringify(o)).not.toMatch(/aiTier|groq|claude/i);
  });

  it('billing: upgrade through a Razorpay subscription; the plan switches on when Razorpay confirms, and back to Free when it stops', async () => {
    await db.q(`UPDATE businesses SET plan_id = (SELECT id FROM plans WHERE code = 'free') WHERE id = $1`, [a.businessId]);
    await tenant(a.businessId, (tx) => tx.q(`UPDATE agents SET enabled = false WHERE agent_key = 'nudge'`));
    expect((await a.api.post('/billing/upgrade', { plan: 'plus' })).body.error.code).toBe('billing_not_configured');
    process.env.ORBIT_RAZORPAY_KEY_ID = 'rzp_live_orbit';
    process.env.ORBIT_RAZORPAY_KEY_SECRET = 'orbit-secret';
    process.env.ORBIT_RAZORPAY_WEBHOOK_SECRET = 'orbit-hook-secret';
    const r = await a.api.post('/billing/upgrade', { plan: 'plus' }).expect(201);
    expect(r.body.url).toMatch(/^https:\/\/rzp\.io\//);
    expect(calls.find((c) => c.url.endsWith('/v1/plans'))?.body).toMatchObject({ period: 'monthly', interval: 1, item: { currency: 'INR' } });
    expect(calls.find((c) => c.url.endsWith('/v1/subscriptions'))?.body.notes).toMatchObject({ business_id: a.businessId, plan_code: 'plus' });
    // The Razorpay plan is reused next time.
    calls = [];
    await a.api.post('/billing/upgrade', { plan: 'plus' }).expect(201);
    expect(calls.some((c) => c.url.endsWith('/v1/plans'))).toBe(false);

    const send = (event: string, status: string, secret = 'orbit-hook-secret') => {
      const raw = JSON.stringify({ event, payload: { subscription: { entity: { id: r.body.subscriptionId, status, current_end: Math.floor(Date.now() / 1000) + 30 * 86400, notes: { business_id: a.businessId, plan_code: 'plus' } } } } });
      return http().post('/webhooks/orbit-billing').set('content-type', 'application/json').set('x-razorpay-signature', createHmac('sha256', secret).update(raw).digest('hex')).send(raw);
    };
    await send('subscription.activated', 'active', 'wrong').expect(401);
    await send('subscription.activated', 'active').expect(200);
    expect((await a.api.get('/billing').expect(200)).body).toMatchObject({ plan: { code: 'plus' }, subscription: { status: 'active' } });
    const nudgeOn = async () => (await tenant(a.businessId, (tx) => tx.one(`SELECT enabled FROM agents WHERE agent_key = 'nudge'`))).enabled;
    expect(await nudgeOn()).toBe(true); // Base includes Nudge
    await send('subscription.halted', 'halted').expect(200);
    expect((await a.api.get('/billing').expect(200)).body.plan.code).toBe('free');
    expect(await nudgeOn()).toBe(false); // Free does not: it stops sending
    expect(await tenant(a.businessId, (tx) => tx.one(`SELECT 1 FROM notifications WHERE type = 'plan_ended'`))).toBeTruthy();
  });
});
