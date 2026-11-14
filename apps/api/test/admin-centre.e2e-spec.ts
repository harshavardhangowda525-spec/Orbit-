/**
 * Admin control centre: 2FA and roles, the live upgrade feed, approvals, provider
 * budgets, business controls, the messaging centre, reports, maintenance and the
 * append-only audit log.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { bootApp, onboard, signIn, api, adminApi, newEmail, TEST_PASSWORD } from './helpers';
import { DbService } from '../src/db/db.service';
import { AdminOpsService } from '../src/admin/admin-ops.service';
import { MessagingService, outsideQuietHours } from '../src/admin/messaging.service';
import { codeAt, stepAt } from '../src/admin/totp';

describe('Admin control centre', () => {
  let app: NestExpressApplication;
  let db: DbService;
  let ops: AdminOpsService;
  let owner: Awaited<ReturnType<typeof adminApi>>;
  let biz: Awaited<ReturnType<typeof onboard>>;
  const http = () => request(app.getHttpServer());
  const tenant = (id: string, fn: (tx: any) => Promise<any>): Promise<any> => db.withTenant(id, fn);
  const admin = (sql: string, p: unknown[] = []): Promise<any[]> => db.adminTx((tx: any) => tx.q(sql, p));

  /** Add a team member with a role and open an admin session for them. */
  const member = async (role: 'finance' | 'support' | 'viewer') => {
    const email = newEmail();
    await signIn(app, email);
    await owner.post('/admin/team', { email, role }).expect(201);
    return adminApi(app, email);
  };

  beforeAll(async () => {
    app = await bootApp();
    db = app.get(DbService);
    ops = app.get(AdminOpsService);
    owner = await adminApi(app);
    biz = await onboard(app, 'salon', 'Centre Salon');
  });
  afterAll(async () => {
    await admin(`UPDATE platform_settings SET value = '{"on":false,"message":"","blockWrites":false}' WHERE key = 'maintenance'`);
    await app.close();
  });

  it('the admin centre needs the authenticator code; codes are single-use; the admin session alone is not a sign-in', async () => {
    const who = await signIn(app, 'admin@orbit.test');
    await db.adminTx((tx: any) => tx.q(`UPDATE admin_users SET totp_secret = NULL, totp_enabled_at = NULL, last_totp_step = NULL WHERE user_id = $1`, [who.userId]));
    // Signed in, but no admin session yet.
    expect((await api(app, who.token).get('/admin/overview')).status).toBe(401);
    // Two setup screens at once (double load) must agree on one secret.
    const [s1, s2] = await Promise.all([api(app, who.token).post('/admin-auth/start').expect(201), api(app, who.token).post('/admin-auth/start').expect(201)]);
    expect(s1.body.secret).toBe(s2.body.secret);
    const start = (await api(app, who.token).post('/admin-auth/start').expect(201)).body;
    expect(start.secret).toBe(s1.body.secret);
    expect(start).toMatchObject({ setup: true, role: 'owner' });
    expect(start.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect((await api(app, who.token).post('/admin-auth/verify', { code: '000000' })).status).toBe(401);
    const code = codeAt(start.secret, stepAt());
    const ok = await api(app, who.token).post('/admin-auth/verify', { code }).expect(201);
    expect((await api(app, who.token).post('/admin-auth/verify', { code })).status).toBe(401); // replay
    const session = ok.body.token;
    expect((await http().get('/admin/overview').set('authorization', `Bearer ${who.token}`).set('x-admin-session', session)).status).toBe(200);
    expect((await api(app, session).get('/auth/me')).status).toBe(401);
    // Ordinary owners are not on the team.
    const plain = await signIn(app);
    expect((await api(app, plain.token).post('/admin-auth/start')).status).toBe(403);
    owner = await adminApi(app);
  });

  it('roles: Support cannot refund or change prices; Viewer can only look; a disabled admin loses access at once', async () => {
    const support = await member('support');
    const viewer = await member('viewer');
    const plans = (await support.get('/admin/plans').expect(200)).body;
    await support.put('/admin/plans/plus', plans[1]).expect(403);
    await support.post(`/admin/centre/businesses/${biz.businessId}/refund`, { amountInr: 100 }).expect(403);
    await support.patch(`/admin/businesses/${biz.businessId}`, { planCode: 'pro' }).expect(403);
    await support.post(`/admin/centre/businesses/${biz.businessId}/notes`, { body: 'Called the owner about WhatsApp setup.' }).expect(201);
    await viewer.get('/admin/overview').expect(200);
    await viewer.post(`/admin/centre/businesses/${biz.businessId}/notes`, { body: 'x' }).expect(403);
    await viewer.get('/admin/team').expect(403);
    await owner.patch(`/admin/team/${viewer.userId}`, { status: 'disabled' }).expect(200);
    await viewer.get('/admin/overview').expect(403);
  });

  it('an upgrade activates the moment Razorpay confirms payment, shows in the live feed, and the admin team is told', async () => {
    process.env.ORBIT_RAZORPAY_WEBHOOK_SECRET = 'centre-hook';
    const subId = `sub_centre_${Date.now()}`;
    await tenant(biz.businessId, (tx) => tx.q(`INSERT INTO subscriptions (plan_code, provider_subscription_id, status) VALUES ('pro', $1, 'created')`, [subId]));
    const raw = JSON.stringify({
      event: 'subscription.charged',
      payload: {
        subscription: { entity: { id: subId, status: 'active', current_end: Math.floor(Date.now() / 1000) + 30 * 86400, notes: { business_id: biz.businessId, plan_code: 'pro' } } },
        payment: { entity: { id: `pay_${Date.now()}`, amount: 299900, currency: 'INR', created_at: Math.floor(Date.now() / 1000) } },
      },
    });
    await http().post('/webhooks/orbit-billing').set('content-type', 'application/json').set('x-razorpay-signature', createHmac('sha256', 'centre-hook').update(raw).digest('hex')).send(raw).expect(200);
    expect((await biz.api.get('/billing').expect(200)).body.plan.code).toBe('pro');
    const feed = (await owner.get('/admin/feed').expect(200)).body;
    expect(feed[0]).toMatchObject({ kind: 'upgrade', from: 'free', to: 'pro', amount: 2999, business: 'Centre Salon' });
    const notes = (await owner.get('/admin/notifications').expect(200)).body;
    expect(notes.some((n: any) => n.type === 'upgrade' && /Centre Salon upgraded/.test(n.title))).toBe(true);
    const o = (await owner.get('/admin/overview').expect(200)).body;
    expect(o.money.revenueMonth).toBeGreaterThanOrEqual(2999);
    expect(o.money.upgrades.this_month).toBeGreaterThanOrEqual(1);
    expect(o.businesses.byPlan.find((p: any) => p.code === 'pro').businesses).toBeGreaterThanOrEqual(1);
  });

  it('approvals: only the configured cases wait; approving applies; unanswered items take the safe default', async () => {
    const finance = await member('finance');
    const balance = async () => Number((await db.one(`SELECT ai_wallet_balance FROM businesses WHERE id = $1`, [biz.businessId]))!.ai_wallet_balance);
    const before = await balance();
    const r = (await finance.post(`/admin/centre/businesses/${biz.businessId}/credit`, { amountInr: 250, note: 'Sorry for the outage' }).expect(201)).body;
    expect(r.status).toBe('pending');
    expect(await balance()).toBe(before); // nothing yet
    const queue = (await owner.get('/admin/approvals').expect(200)).body;
    expect(queue.find((x: any) => x.id === r.id)).toMatchObject({ kind: 'credit', business: 'Centre Salon' });
    const support = await member('support');
    await support.post(`/admin/approvals/${r.id}/decide`, { decision: 'approve' }).expect(403);
    await owner.post(`/admin/approvals/${r.id}/decide`, { decision: 'approve', edited: { amountInr: 200 } }).expect(201);
    expect(await balance()).toBe(before + 200); // edited and approved

    // Custom limits within the plan apply at once; above it they wait.
    expect((await support.post(`/admin/centre/businesses/${biz.businessId}/limits`, { limits: { graceMessages: 5 } }).expect(201)).body).toEqual({ applied: true });
    const above = (await support.post(`/admin/centre/businesses/${biz.businessId}/limits`, { limits: { aiConversationsPerMonth: 99999 } }).expect(201)).body;
    expect(above.status).toBe('pending');

    // With the credit rule off, a credit applies straight away.
    const rules = (await owner.get('/admin/settings').expect(200)).body['approval.rules'];
    await owner.put('/admin/settings/approval.rules', { value: { ...rules, credit: { on: false } } }).expect(200);
    expect((await finance.post(`/admin/centre/businesses/${biz.businessId}/credit`, { amountInr: 50 }).expect(201)).body).toEqual({ applied: true });
    expect(await balance()).toBe(before + 250);
    await owner.put('/admin/settings/approval.rules', { value: rules }).expect(200);

    // Not answered in time: the safe default (reject) is applied.
    await admin(`UPDATE admin_approvals SET due_at = now() - interval '1 minute' WHERE id = $1`, [above.id]);
    await ops.expireApprovals();
    const done = (await admin(`SELECT status, decision_note FROM admin_approvals WHERE id = $1`, [above.id]))[0];
    expect(done).toMatchObject({ status: 'expired', decision_note: 'No answer in time: reject' });
    expect((await db.one(`SELECT limit_overrides FROM businesses WHERE id = $1`, [biz.businessId]))!.limit_overrides).toEqual({ graceMessages: 5 });
  });

  it('abnormal AI spend pauses that business (customers go to the owner) until an admin approves', async () => {
    const b = await onboard(app, 'gym', 'Spendy Gym');
    await tenant(b.businessId, (tx) => tx.q(`INSERT INTO ai_usage (agent_key, model, cost, provider) VALUES ('aria', 'm', 10, 'groq')`)); // $10 ≈ ₹840 > ₹500
    expect(await ops.watchAiCost()).toBeGreaterThanOrEqual(1);
    expect((await db.one(`SELECT ai_paused FROM businesses WHERE id = $1`, [b.businessId]))!.ai_paused).toBe(true);
    const s = await http().post(`/public/businesses/${b.slug}/chat`).send({}).expect(201);
    const reply = await http().post(`/public/businesses/${b.slug}/chat/${s.body.conversationId}/messages`).set('x-visitor-token', s.body.visitorToken).send({ text: 'Timings?' }).expect(201);
    expect(reply.body.handledBy).toBe('human');
    const item = (await admin(`SELECT id FROM admin_approvals WHERE kind = 'ai_cost' AND business_id = $1 AND status = 'pending'`, [b.businessId]))[0];
    await owner.post(`/admin/approvals/${item.id}/decide`, { decision: 'approve' }).expect(201);
    expect((await db.one(`SELECT ai_paused FROM businesses WHERE id = $1`, [b.businessId]))!.ai_paused).toBe(false);
    expect(await ops.watchAiCost()).toBe(0); // approved for today: not paused again
  });

  it('provider budgets: alerts at 70, 90 and 100% (once each), a larger budget needs approval, and it is confirmed once set', async () => {
    const finance = await member('finance');
    await finance.post('/admin/budgets/groq/approve', { amountInr: 1000 }).expect(201);
    let groq = (await finance.get('/admin/budgets').expect(200)).body.find((p: any) => p.provider === 'groq');
    expect(groq).toMatchObject({ budget: 1000, status: 'recorded', canSetByApi: false, billingUrl: expect.stringContaining('groq') });
    const spent = groq.spend;
    // Spend to ~75% of the budget.
    const usd = (750 - spent) / 84;
    await tenant(biz.businessId, (tx) => tx.q(`INSERT INTO ai_usage (agent_key, model, cost, provider) VALUES ('orbit', 'm', $1, 'groq')`, [Math.max(0.01, usd)]));
    await ops.checkBudgets();
    await ops.checkBudgets(); // no repeat
    const alerts = await admin(`SELECT title FROM admin_notifications WHERE type = 'budget' AND title LIKE 'Groq at %'`);
    expect(alerts.map((a: any) => a.title.match(/at (\d+)%/)[1])).toEqual(['70']);
    // More than last month's budget waits for approval.
    expect((await finance.post('/admin/budgets/groq/approve', { amountInr: 5000 }).expect(201)).body.status).toBe('pending');
    await finance.post('/admin/budgets/groq/confirm', { month: new Date().toISOString().slice(0, 7) }).expect(201);
    groq = (await finance.get('/admin/budgets').expect(200)).body.find((p: any) => p.provider === 'groq');
    expect(groq.status).toBe('confirmed');
  });

  it('messaging centre: edit and preview a template; broadcast to a segment with stats; opt-outs and quiet hours respected; clicks tracked', async () => {
    const support = await member('support');
    const t = (await support.get('/admin/messaging/templates').expect(200)).body;
    expect(t.map((x: any) => x.key)).toEqual(expect.arrayContaining(['renewal_7', 'renewal_3', 'renewal_1', 'payment_failed', 'grace_reminder', 'plan_expired', 'usage_80', 'usage_100', 'trial_ending', 'welcome_upgrade']));
    const p = (await support.post('/admin/messaging/preview', { content: t.find((x: any) => x.key === 'renewal_3').content, lang: 'hi' }).expect(201)).body;
    expect(p.body).toContain('Glow Studio');
    expect(p.subject).toContain('Pro');

    const target = await onboard(app, 'clinic', 'Segment Clinic');
    const optOut = await onboard(app, 'clinic', 'Quiet Clinic');
    await admin(`INSERT INTO notification_preferences (user_id, marketing) VALUES ($1, false) ON CONFLICT (user_id) DO UPDATE SET marketing = false`, [optOut.owner.userId]);
    const segment = { businessIds: [target.businessId, optOut.businessId] };
    expect((await support.post('/admin/messaging/audience', { segment, category: 'marketing' }).expect(201)).body).toEqual({ businesses: 2, owners: 1 });
    const b = (await support.post('/admin/messaging/broadcasts', { title: 'Diwali offer', content: { en: { subject: 'Diwali offer from Orbit', body: 'Hi {{owner}}, 20% off Pro this week: {{link}}' } }, segment, channels: ['inapp', 'whatsapp'], link: '/bridge?view=plan' }).expect(201)).body;
    const sent = (await support.post(`/admin/messaging/broadcasts/${b.id}/send`).expect(201)).body;
    expect(sent.queued).toBe(2); // in-app + WhatsApp for the one owner who did not opt out
    expect(sent.stats).toMatchObject({ total: 2, sent: 1, unavailable: 1 });
    const bell = (await target.api.get('/notifications').expect(200)).body;
    expect(JSON.stringify(bell)).toContain('Diwali offer from Orbit');
    expect((await optOut.api.get('/notifications').expect(200)).body.items.some((n: any) => JSON.stringify(n).includes('Diwali'))).toBe(false);
    // Click tracking: only redirects into Orbit.
    const msg = (await admin(`SELECT id FROM owner_messages WHERE broadcast_id = $1 AND channel = 'inapp'`, [b.id]))[0];
    const click = await http().get(`/m/${msg.id}/click`).query({ to: 'https://evil.example/' }).expect(302);
    expect(click.headers.location).toMatch(/\/bridge\?view=plan$/);
    expect((await support.get('/admin/messaging/broadcasts').expect(200)).body.find((x: any) => x.id === b.id).stats).toMatchObject({ clicked: 1, read: 1 });
    // Email waits out quiet hours in the business's timezone (21:00–09:00).
    const at = outsideQuietHours(new Date('2026-11-14T17:00:00Z'), 'Asia/Kolkata'); // 22:30 IST
    expect(at.toISOString()).toBe('2026-11-15T04:00:00.000Z'); // ~09:30 IST, after quiet hours end
  });

  it('business controls: filter the list, see the detail, give a trial, pause AI, export data; reports and CSV exports', async () => {
    const list = (await owner.get(`/admin/centre/businesses?plan=pro&q=Centre`).expect(200)).body;
    expect(list[0]).toMatchObject({ name: 'Centre Salon', plan: 'pro' });
    const d = (await owner.get(`/admin/centre/businesses/${biz.businessId}`).expect(200)).body;
    expect(d.planHistory[0]).toMatchObject({ kind: 'upgrade', to: 'pro' });
    expect(d.notes[0].body).toContain('WhatsApp');
    expect(d.meters.month).toHaveProperty('used');
    const trialBiz = await onboard(app, 'gym', 'Trial Gym');
    await owner.post(`/admin/centre/businesses/${trialBiz.businessId}/trial`, { plan: 'business', days: 14 }).expect(201);
    expect((await trialBiz.api.get('/billing').expect(200)).body.plan.code).toBe('business');
    await admin(`UPDATE businesses SET trial_ends_at = now() - interval '1 minute' WHERE id = $1`, [trialBiz.businessId]);
    await ops.hourly();
    expect((await trialBiz.api.get('/billing').expect(200)).body.plan.code).toBe('free');
    await owner.post(`/admin/centre/businesses/${trialBiz.businessId}/ai`, { paused: true, reason: 'abuse check' }).expect(201);
    expect((await db.one(`SELECT ai_paused FROM businesses WHERE id = $1`, [trialBiz.businessId]))!.ai_paused).toBe(true);
    const exp = await owner.get(`/admin/centre/businesses/${trialBiz.businessId}/export`).expect(200);
    expect(JSON.parse(exp.text).business.name).toBe('Trial Gym');

    const monthly = (await owner.get('/admin/reports/monthly?months=3').expect(200)).body;
    expect(monthly.months).toHaveLength(3);
    expect((await owner.get('/admin/reports/gst').expect(200)).body.totals.gst).toBeGreaterThan(0);
    expect(Array.isArray((await owner.get('/admin/reports/cohorts').expect(200)).body)).toBe(true);
    const csv = await owner.get('/admin/export/plan_changes').expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\r\n')[0]).toContain('at,business,kind,from_plan,to_plan');

    // Deleting needs the business's address name typed back.
    await owner.delete(`/admin/centre/businesses/${trialBiz.businessId}?confirm=wrong`).expect(400);
    await owner.delete(`/admin/centre/businesses/${trialBiz.businessId}?confirm=${trialBiz.slug}`).expect(200);
    expect(await db.one(`SELECT 1 FROM businesses WHERE id = $1`, [trialBiz.businessId])).toBeFalsy();
  });

  it('maintenance mode shows a message and can pause changes, while admin keeps working', async () => {
    await owner.put('/admin/settings/maintenance', { value: { on: true, message: 'Back at 2 pm', blockWrites: true } }).expect(200);
    expect((await http().get('/status').expect(200)).body.maintenance.message).toBe('Back at 2 pm');
    const w = await biz.api.post('/notifications/read', {});
    expect(w.status).toBe(503);
    expect(w.body.error.message).toBe('Back at 2 pm');
    await biz.api.get('/billing').expect(200); // reading still works
    await owner.put('/admin/settings/maintenance', { value: { on: false, message: '', blockWrites: false } }).expect(200);
    expect((await http().get('/status').expect(200)).body.maintenance).toBeNull();
  });

  it('every admin action is in the audit log, and the log cannot be changed or deleted', async () => {
    const actions = (await admin(`SELECT DISTINCT action FROM audit_log WHERE actor_kind = 'admin'`)).map((r: any) => r.action);
    expect(actions).toEqual(expect.arrayContaining([
      'admin.2fa_enabled', 'admin.team.add', 'admin.team.update', 'admin.approval.approve', 'admin.business.credit_requested', 'admin.business.trial',
      'admin.business.ai_paused', 'admin.business.export', 'admin.business.delete', 'admin.broadcast.send', 'admin.setting.update', 'admin.export', 'admin.budget.confirmed',
    ]));
    await expect(admin(`UPDATE audit_log SET action = 'tampered' WHERE action = 'admin.business.delete'`)).rejects.toThrow(/append-only/);
    await expect(admin(`DELETE FROM audit_log WHERE action = 'admin.export'`)).rejects.toThrow(/append-only/);
    void TEST_PASSWORD;
  });
});
