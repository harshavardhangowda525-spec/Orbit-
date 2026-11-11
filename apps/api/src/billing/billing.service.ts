import { Body, Controller, Get, Headers, HttpCode, Injectable, Module, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AGENT_KEYS } from '@orbit/shared';
import { DbService } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant, Public, Roles, TenantGuard } from '../auth/guards';
import type { Tenant } from '../auth/types';
import { AppError, badRequest, notFound } from '../common/errors';
import { postFeed } from '../common/feed';
import { liveToBusiness } from '../realtime/live';
import { logger } from '../logger';
import { syncCrewToPlan } from './crew-plan';

/** Orbit's own Razorpay account (Orbit charging businesses for their plan). */
const billingKeys = () => ({ keyId: process.env.ORBIT_RAZORPAY_KEY_ID ?? '', keySecret: process.env.ORBIT_RAZORPAY_KEY_SECRET ?? '', webhookSecret: process.env.ORBIT_RAZORPAY_WEBHOOK_SECRET ?? '' });
const billingReady = () => !!(billingKeys().keyId && billingKeys().keySecret);

async function rzp(path: string, body?: unknown) {
  const k = billingKeys();
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Basic ${Buffer.from(`${k.keyId}:${k.keySecret}`).toString('base64')}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const d: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new AppError(res.status >= 500 ? 502 : 400, 'billing_failed', d?.error?.description ?? 'Payments are not available right now. Please try again.');
  return d;
}

const ACTIVE = ['authenticated', 'active', 'pending'];

/**
 * Plans and billing: what the business is on, how much it has used this month,
 * and upgrading through a Razorpay subscription (UPI AutoPay or card mandate).
 * Razorpay's webhook switches the plan on when the first charge succeeds and
 * back to Free if the subscription stops.
 */
@Injectable()
export class BillingService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  async overview(t: Tenant) {
    return this.db.withTenant(t.businessId, async (tx) => {
      const cur = await tx.one(`SELECT p.code, p.name, p.prices, p.limits, p.features FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.id = app_current_business()`);
      const plans = await tx.q(`SELECT code, name, prices, limits, features FROM plans WHERE active ORDER BY sort_order`);
      const usage = await tx.one(
        `SELECT (SELECT count(DISTINCT conversation_id)::int FROM ai_usage WHERE agent_key = 'aria' AND conversation_id IS NOT NULL AND created_at >= date_trunc('month', now())) AS "aiConversations",
                (SELECT count(*)::int FROM staff WHERE active AND deleted_at IS NULL) AS staff,
                (SELECT count(*)::int FROM tasks WHERE created_at >= date_trunc('month', now())) AS tasks`,
      );
      // The subscription that is actually running wins over a newer, unfinished upgrade attempt.
      const sub = await tx.one(
        `SELECT plan_code AS "planCode", status, short_url AS url, current_end AS "currentEnd", cancel_at_cycle_end AS "cancelAtCycleEnd" FROM subscriptions
         ORDER BY (status = ANY($1)) DESC, created_at DESC LIMIT 1`,
        [ACTIVE],
      );
      return { plan: cur, plans, usage, subscription: sub ?? null, billing: billingReady() };
    });
  }

  /** Ensures a Razorpay plan exists for this Orbit plan's current INR price. */
  private async providerPlan(code: string) {
    const p = await this.db.one(`SELECT id, code, name, prices, provider_refs FROM plans WHERE code = $1 AND active`, [code]);
    if (!p) throw notFound('That plan does not exist.');
    const inr = Number(p.prices?.INR ?? 0);
    if (inr <= 0) throw badRequest('free_plan', 'The Free plan needs no payment.');
    const key = `razorpay:INR:${inr}`;
    if (p.provider_refs?.[key]) return { plan: p, providerPlanId: p.provider_refs[key] as string };
    const made = await rzp('/plans', { period: 'monthly', interval: 1, item: { name: `Orbit ${p.name}`, amount: Math.round(inr * 100), currency: 'INR', description: `Orbit ${p.name} plan, monthly` } });
    await this.db.q(`UPDATE plans SET provider_refs = provider_refs || jsonb_build_object($2::text, $3::text) WHERE id = $1`, [p.id, key, made.id]);
    return { plan: p, providerPlanId: made.id as string };
  }

  async upgrade(t: Tenant, raw: unknown) {
    const b = z.object({ plan: z.string().min(1).max(40) }).safeParse(raw);
    if (!b.success) throw badRequest('invalid_input', 'Please choose a plan.');
    if (!billingReady()) throw badRequest('billing_not_configured', 'Online payment for plans is not set up yet. Please ask the Orbit team to change your plan.');
    const { plan, providerPlanId } = await this.providerPlan(b.data.plan);
    const s = await rzp('/subscriptions', { plan_id: providerPlanId, total_count: 120, quantity: 1, customer_notify: 1, notes: { business_id: t.businessId, plan_code: plan.code } });
    await this.db.withTenant(t.businessId, (tx) =>
      tx.q(`INSERT INTO subscriptions (plan_code, provider_subscription_id, status, short_url, created_by) VALUES ($1, $2, $3, $4, $5)`, [plan.code, s.id, s.status ?? 'created', s.short_url, t.userId]),
    t.userId);
    await this.audit.write({ businessId: t.businessId, actorId: t.userId, action: 'billing.subscribe', entity: 'subscription', after: { plan: plan.code, subscription: s.id } });
    return { url: s.short_url as string, subscriptionId: s.id as string };
  }

  /** Stops at the end of the paid month; the plan drops to Free when Razorpay says it ended. */
  async cancel(t: Tenant) {
    const sub = await this.db.withTenant(t.businessId, (tx) => tx.one(`SELECT * FROM subscriptions WHERE status = ANY($1) ORDER BY created_at DESC LIMIT 1`, [ACTIVE]));
    if (!sub) throw notFound('There is no paid plan to cancel.');
    await rzp(`/subscriptions/${encodeURIComponent(sub.provider_subscription_id)}/cancel`, { cancel_at_cycle_end: 1 });
    await this.db.withTenant(t.businessId, (tx) => tx.q(`UPDATE subscriptions SET cancel_at_cycle_end = true WHERE id = $1`, [sub.id]), t.userId);
    await this.audit.write({ businessId: t.businessId, actorId: t.userId, action: 'billing.cancel', entity: 'subscription', entityId: sub.id });
    return { ok: true, until: sub.current_end };
  }

  async webhook(raw: Buffer | undefined, signature: string | undefined, body: any) {
    const secret = billingKeys().webhookSecret;
    const expected = raw && secret ? createHmac('sha256', secret).update(raw).digest() : null;
    const got = Buffer.from(signature ?? '', 'hex');
    if (!expected || got.length !== expected.length || !timingSafeEqual(got, expected)) throw new AppError(401, 'bad_signature', 'Invalid signature.');
    const ent = body?.payload?.subscription?.entity;
    const businessId = ent?.notes?.business_id;
    if (!ent?.id || !businessId || !/^[0-9a-f-]{36}$/.test(businessId)) return { ignored: true };
    return this.db.withTenant(businessId, async (tx) => {
      const sub = await tx.one(`SELECT * FROM subscriptions WHERE provider_subscription_id = $1`, [ent.id]);
      if (!sub) return { ignored: 'unknown_subscription' };
      const status = String(ent.status ?? sub.status);
      const currentEnd = ent.current_end ? new Date(Number(ent.current_end) * 1000) : sub.current_end;
      await tx.q(`UPDATE subscriptions SET status = $2, current_end = $3 WHERE id = $1`, [sub.id, status, currentEnd]);
      const event = String(body.event ?? '');
      if (['subscription.activated', 'subscription.charged', 'subscription.resumed'].includes(event) && status === 'active') {
        const before = await tx.one(`SELECT plan_id FROM businesses WHERE id = app_current_business()`);
        const changed = await tx.one(`UPDATE businesses SET plan_id = (SELECT id FROM plans WHERE code = $1) WHERE id = app_current_business() AND plan_id <> (SELECT id FROM plans WHERE code = $1) RETURNING id, plan_id`, [sub.plan_code]);
        if (changed) await syncCrewToPlan(tx, businessId, before?.plan_id ?? null, changed.plan_id);
        // Moving between paid plans: the older subscription stops now.
        const older = await tx.q(`SELECT provider_subscription_id FROM subscriptions WHERE id <> $1 AND status = ANY($2)`, [sub.id, ACTIVE]);
        for (const o of older) {
          await rzp(`/subscriptions/${encodeURIComponent(o.provider_subscription_id)}/cancel`, { cancel_at_cycle_end: 0 }).catch((e) => logger.warn(`cancel old subscription: ${(e as Error).message}`, 'Billing'));
          await tx.q(`UPDATE subscriptions SET status = 'cancelled' WHERE provider_subscription_id = $1`, [o.provider_subscription_id]);
        }
        if (changed) await postFeed(tx, 'orbit', 'plan_changed', { key: 'feed.orbit.plan_changed', params: { plan: sub.plan_code } });
      }
      if (['subscription.halted', 'subscription.cancelled', 'subscription.completed'].includes(event)) {
        const otherActive = await tx.one(`SELECT 1 FROM subscriptions WHERE id <> $1 AND status = 'active'`, [sub.id]);
        if (!otherActive) {
          const before = await tx.one(`SELECT plan_id FROM businesses WHERE id = app_current_business()`);
          const free = await tx.one(`UPDATE businesses SET plan_id = (SELECT id FROM plans WHERE code = 'free') WHERE id = app_current_business() RETURNING plan_id`);
          await syncCrewToPlan(tx, businessId, before?.plan_id ?? null, free.plan_id);
          await tx.q(`INSERT INTO notifications (user_id, type, title, link) VALUES (NULL, 'plan_ended', $1, '/bridge?view=plan')`, [JSON.stringify({ key: event === 'subscription.halted' ? 'notify.plan_payment_failed' : 'notify.plan_ended' })]);
          liveToBusiness(tx, { type: 'notification.new' });
        }
      }
      return { ok: true };
    });
  }
}

const Permissions = z.object({
  reviewRequests: z.boolean().optional(),
  renewals: z.boolean().optional(),
  followUps: z.boolean().optional(),
  invoiceReminders: z.boolean().optional(),
}).strict();
const CrewPatch = z.object({
  enabled: z.boolean().optional(),
  displayName: z.string().trim().min(1).max(40).optional(),
  personality: z.enum(['formal', 'friendly', 'energetic']).optional(),
  permissions: Permissions.optional(),
});

@UseGuards(TenantGuard)
@Controller()
export class BillingController {
  constructor(private readonly billing: BillingService, private readonly db: DbService, private readonly audit: AuditService) {}

  @Get('billing')
  overview(@CurrentTenant() t: Tenant) {
    return this.billing.overview(t);
  }

  @Roles('owner')
  @Post('billing/upgrade')
  upgrade(@CurrentTenant() t: Tenant, @Body() body: unknown) {
    return this.billing.upgrade(t, body);
  }

  @Roles('owner')
  @Post('billing/cancel')
  cancel(@CurrentTenant() t: Tenant) {
    return this.billing.cancel(t);
  }

  /** Crew settings: switch an agent on/off, rename it, its tone, and what it may do without asking. */
  @Roles('owner', 'manager')
  @Patch('crew/:agent')
  async crew(@CurrentTenant() t: Tenant, @Param('agent') agent: string, @Body() raw: unknown) {
    if (!(AGENT_KEYS as readonly string[]).includes(agent)) throw notFound();
    const b = CrewPatch.safeParse(raw);
    if (!b.success) throw badRequest('invalid_input', b.error.issues[0]?.message ?? 'Please check the settings.');
    if (agent === 'orbit' && b.data.enabled === false) throw badRequest('orbit_always_on', 'Orbit itself cannot be switched off.');
    if (b.data.enabled === true) {
      const plan = await this.db.one<{ agents: string[] }>(`SELECT p.features->'agents' AS agents FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.id = $1`, [t.businessId]);
      if (plan && !(plan.agents ?? []).includes(agent)) throw badRequest('upgrade_needed', 'This Crew member is not on your plan. Upgrade to switch it on.');
    }
    const row = await this.db.withTenant(t.businessId, async (tx) => {
      const r = await tx.one(
        `UPDATE agents SET enabled = COALESCE($2, enabled), display_name = COALESCE($3, display_name), personality = COALESCE($4, personality),
           auto_approval_rules = CASE WHEN jsonb_typeof(auto_approval_rules) = 'object' THEN auto_approval_rules ELSE '{}' END || COALESCE($5::jsonb, '{}')
         WHERE agent_key = $1 RETURNING agent_key AS agent, display_name AS name, personality, enabled, auto_approval_rules AS permissions`,
        [agent, b.data.enabled ?? null, b.data.displayName ?? null, b.data.personality ?? null, b.data.permissions ? JSON.stringify(b.data.permissions) : null],
      );
      if (r && b.data.enabled !== undefined) {
        await postFeed(tx, 'orbit', b.data.enabled ? 'agent_on' : 'agent_off', { key: b.data.enabled ? 'feed.orbit.agent_on' : 'feed.orbit.agent_off', params: { agent: r.name } });
      }
      liveToBusiness(tx, { type: 'stats.changed' });
      return r;
    }, t.userId);
    if (!row) throw notFound();
    await this.audit.write({ businessId: t.businessId, actorId: t.userId, action: 'crew.update', entity: 'agent', after: { agent, ...b.data } });
    return row;
  }

  /** Where review requests send customers (e.g. the Google review link). */
  @Roles('owner', 'manager')
  @Patch('crew/settings/review-link')
  async reviewLink(@CurrentTenant() t: Tenant, @Body() raw: unknown) {
    const b = z.object({ url: z.string().trim().url().max(500).or(z.literal('')) }).safeParse(raw);
    if (!b.success || (b.data.url && !/^https:\/\//.test(b.data.url))) throw badRequest('invalid_url', 'Please paste a full https:// link, like your Google review link.');
    await this.db.withTenant(t.businessId, (tx) => tx.q(`UPDATE business_profiles SET review_url = NULLIF($1, '') WHERE business_id = app_current_business()`, [b.data.url]), t.userId);
    return { ok: true, url: b.data.url || null };
  }

  @Get('crew/settings')
  settings(@CurrentTenant() t: Tenant) {
    return this.db.withTenant(t.businessId, async (tx) => ({
      reviewUrl: (await tx.one(`SELECT review_url FROM business_profiles WHERE business_id = app_current_business()`))?.review_url ?? null,
      crew: await tx.q(`SELECT agent_key AS agent, display_name AS name, personality, enabled, CASE WHEN jsonb_typeof(auto_approval_rules) = 'object' THEN auto_approval_rules ELSE '{}' END AS permissions FROM agents ORDER BY created_at`),
    }));
  }
}

@Controller('webhooks/orbit-billing')
export class BillingWebhookController {
  constructor(private readonly billing: BillingService) {}

  @Public()
  @SkipThrottle()
  @Post()
  @HttpCode(200)
  receive(@Req() req: Request, @Headers('x-razorpay-signature') sig: string | undefined) {
    return this.billing.webhook((req as any).rawBody, sig, req.body);
  }
}

@Module({ controllers: [BillingController, BillingWebhookController], providers: [BillingService] })
export class BillingModule {}
