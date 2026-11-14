import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { AiService } from '../ai/ai.service';
import { UsageService } from '../billing/usage.service';
import { syncCrewToPlan } from '../billing/crew-plan';
import { AdminGuard, AdminRoles, ClientIp, CurrentAdmin } from '../auth/guards';
import type { AdminSession } from '../auth/types';
import { ZodPipe } from '../common/zod.pipe';
import { badRequest, notFound } from '../common/errors';
import { AdminOpsService, PROVIDERS } from './admin-ops.service';
import { MessagingService, render, type Segment } from './messaging.service';
import { resetMaintenanceCache } from './maintenance';

const UUID = z.string().uuid();
const Lang = z.object({ subject: z.string().min(1).max(200), body: z.string().min(1).max(4000) });
const Content = z.object({ en: Lang, hi: Lang.optional(), kn: Lang.optional() });
const Channels = z.array(z.enum(['inapp', 'email', 'whatsapp', 'push'])).min(1);
const SegmentZ = z.object({
  plans: z.array(z.string()).optional(), renewalWithinDays: z.number().int().min(0).max(365).optional(), inactiveDays: z.number().int().min(1).max(3650).optional(),
  signedUpAfter: z.string().datetime().optional(), signedUpBefore: z.string().datetime().optional(), businessIds: z.array(UUID).optional(),
});
const Broadcast = z.object({
  title: z.string().min(1).max(120), content: Content, segment: SegmentZ.default({}), channels: Channels, category: z.enum(['transactional', 'marketing']).default('marketing'),
  link: z.string().startsWith('/').max(300).optional(), scheduledAt: z.string().datetime().optional(),
});
const OneOff = z.object({ businessId: UUID, content: Content, channels: Channels, link: z.string().startsWith('/').max(300).optional() });
const TemplatePut = z.object({ name: z.string().min(1).max(120).optional(), channels: Channels.optional(), timing: z.record(z.unknown()).optional(), content: Content.optional(), enabled: z.boolean().optional() });
const Decide = z.object({ decision: z.enum(['approve', 'reject']), edited: z.record(z.unknown()).optional(), note: z.string().max(500).optional() });
const Coupon = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/), kind: z.enum(['percent', 'amount']), value: z.number().positive(),
  validFrom: z.string().datetime().nullable().optional(), validTo: z.string().datetime().nullable().optional(), maxUses: z.number().int().positive().nullable().optional(),
  eligiblePlans: z.array(z.string()).default([]), active: z.boolean().default(true),
});
const SETTINGS = ['approval.rules', 'admin.notify', 'costs.units', 'billing.grace_days', 'maintenance', 'fx.usd_inr', 'ai.budget_pct', 'ai.net_revenue_factor', 'addons'] as const;

const csv = (rows: Record<string, unknown>[]) => {
  if (!rows.length) return '﻿';
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    const s = v == null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
};

/**
 * Admin control centre (the Orbit team). Viewers can read everything here; changes
 * follow roles: Owner everything, Finance money (plans, prices, credits, refunds,
 * budgets, approvals), Support businesses and messages. Every change is audited.
 */
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminCentreController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly ops: AdminOpsService,
    private readonly messaging: MessagingService,
    private readonly ai: AiService,
    private readonly usage: UsageService,
  ) {}

  // ------------------------------------------------------------ home overview

  @Get('overview')
  overview(@Query('days') daysRaw?: string) {
    const days = Math.min(365, Math.max(1, Number(daysRaw) || 30));
    return this.db.adminTx(async (tx) => {
      const fx = Number((await tx.one(`SELECT value FROM platform_settings WHERE key = 'fx.usd_inr'`))?.value ?? 84) || 84;
      const factor = Number((await tx.one(`SELECT value FROM platform_settings WHERE key = 'ai.net_revenue_factor'`))?.value ?? 0.83) || 0.83;
      const active = (since: string) =>
        `(SELECT count(*)::int FROM businesses b WHERE b.last_active_at >= ${since} OR EXISTS (SELECT 1 FROM messages m WHERE m.business_id = b.id AND m.created_at >= ${since}))`;
      const n = await tx.one(
        `SELECT (SELECT count(*)::int FROM businesses) AS total,
                ${active(`date_trunc('day', now())`)} AS "activeToday",
                ${active(`now() - interval '7 days'`)} AS "activeWeek",
                ${active(`now() - interval '30 days'`)} AS "activeMonth",
                (SELECT count(*)::int FROM businesses WHERE created_at >= now() - make_interval(days => $1)) AS signups,
                (SELECT count(*)::int FROM businesses WHERE created_at >= now() - make_interval(days => $1 * 2) AND created_at < now() - make_interval(days => $1)) AS "signupsPrev",
                (SELECT COALESCE(sum(amount), 0)::float FROM subscription_charges WHERE charged_at >= date_trunc('month', now())) AS "revenueMonth",
                (SELECT COALESCE(sum(amount), 0)::float FROM subscription_charges WHERE charged_at >= date_trunc('month', now()) - interval '1 month' AND charged_at < date_trunc('month', now())) AS "revenuePrevMonth",
                (SELECT COALESCE(sum(COALESCE((b.price_lock->>'INR')::numeric, (p.prices->>'INR')::numeric)), 0)::float
                   FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE EXISTS (SELECT 1 FROM subscriptions s WHERE s.business_id = b.id AND s.status = 'active')) AS mrr,
                (SELECT (COALESCE(sum(cost), 0) * $2)::float FROM ai_usage WHERE created_at >= date_trunc('month', now())) AS "aiCostMonth",
                (SELECT (COALESCE(sum(cost), 0) * $2)::float FROM ai_usage WHERE created_at >= date_trunc('month', now()) - interval '1 month' AND created_at < date_trunc('month', now())) AS "aiCostPrevMonth"`,
        [days, fx],
      );
      const byPlan = await tx.q(`SELECT p.code, p.name, count(b.id)::int AS businesses FROM plans p LEFT JOIN businesses b ON b.plan_id = p.id WHERE p.active GROUP BY p.code, p.name, p.sort_order ORDER BY p.sort_order`);
      const moves = await tx.q(
        `SELECT kind, count(*) FILTER (WHERE at >= date_trunc('month', now()))::int AS this_month,
                count(*) FILTER (WHERE at >= date_trunc('month', now()) - interval '1 month' AND at < date_trunc('month', now()))::int AS last_month
         FROM plan_change_events WHERE at >= date_trunc('month', now()) - interval '1 month' GROUP BY kind`,
      );
      const now = new Date();
      const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
      const elapsed = Math.max(1, (now.getTime() - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) / 86_400_000);
      const projected = (n.aiCostMonth / elapsed) * daysInMonth;
      const net = n.revenueMonth * factor;
      const alerts = await tx.one(
        `SELECT (SELECT count(*)::int FROM admin_approvals WHERE status = 'pending') AS approvals,
                (SELECT count(*)::int FROM plan_change_events WHERE kind = 'payment_failed' AND at > now() - interval '7 days') AS "failedPayments",
                (SELECT count(*)::int FROM provider_budgets WHERE month = to_char(now(), 'YYYY-MM') AND (status = 'recorded' OR cardinality(alerts_sent) > 0)) AS "budgetWarnings",
                (SELECT count(*)::int FROM businesses WHERE ai_paused) AS "pausedAi",
                (SELECT count(*)::int FROM tasks WHERE status = 'failed' AND updated_at > now() - interval '1 day') AS "failedTasks",
                (SELECT count(*)::int FROM owner_messages WHERE status = 'failed' AND created_at > now() - interval '1 day') AS "failedMessages"`,
      );
      const trend = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 100) : null);
      const mv = (k: string) => moves.find((m) => m.kind === k) ?? { this_month: 0, last_month: 0 };
      return {
        businesses: { total: n.total, activeToday: n.activeToday, activeWeek: n.activeWeek, activeMonth: n.activeMonth, signups: n.signups, signupsTrend: trend(n.signups, n.signupsPrev), byPlan },
        money: {
          mrr: n.mrr, revenueMonth: n.revenueMonth, revenueTrend: trend(n.revenueMonth, n.revenuePrevMonth),
          upgrades: mv('upgrade'), downgrades: mv('downgrade'), cancellations: mv('cancel'), failedPayments: mv('payment_failed'),
        },
        ai: {
          costMonth: Math.round(n.aiCostMonth), projected: Math.round(projected), costTrend: trend(n.aiCostMonth, n.aiCostPrevMonth),
          grossMarginPct: net > 0 ? Math.round(((net - n.aiCostMonth) / net) * 100) : null,
        },
        alerts,
        days,
      };
    });
  }

  @Get('feed')
  feed(@Query('limit') limit?: string) {
    return this.ops.feed(Number(limit) || 50);
  }

  @Get('notifications')
  notifications(@CurrentAdmin() a: AdminSession) {
    return this.db.adminTx((tx) =>
      tx.q(
        `SELECT n.*, r.read_at IS NOT NULL AS read FROM admin_notifications n LEFT JOIN admin_notification_reads r ON r.notification_id = n.id AND r.user_id = $1
         ORDER BY n.created_at DESC LIMIT 60`,
        [a.userId],
      ),
    );
  }

  @AdminRoles('owner', 'finance', 'support', 'viewer')
  @Post('notifications/read')
  readAll(@CurrentAdmin() a: AdminSession) {
    return this.db.adminTx((tx) =>
      tx.q(`INSERT INTO admin_notification_reads (notification_id, user_id) SELECT id, $1 FROM admin_notifications ON CONFLICT DO NOTHING`, [a.userId]).then(() => ({ ok: true })),
    );
  }

  // ------------------------------------------------------------ approvals

  @Get('approvals')
  approvals(@Query('status') status = 'pending') {
    return this.db.adminTx((tx) =>
      tx.q(
        `SELECT a.*, b.name AS business, COALESCE(ru.email::text, ru.name) AS "requestedByName", COALESCE(du.email::text, du.name) AS "decidedByName"
         FROM admin_approvals a LEFT JOIN businesses b ON b.id = a.business_id LEFT JOIN users ru ON ru.id = a.requested_by LEFT JOIN users du ON du.id = a.decided_by
         WHERE ($1 = 'all' OR a.status = $1) ORDER BY a.created_at DESC LIMIT 200`,
        [status],
      ),
    );
  }

  @AdminRoles('finance')
  @Post('approvals/:id/decide')
  decide(@CurrentAdmin() a: AdminSession, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Decide)) b: z.infer<typeof Decide>) {
    return this.ops.decide(id, a.userId, b.decision, b.edited, b.note);
  }

  // ------------------------------------------------------------ provider budgets

  @Get('budgets')
  budgets() {
    return this.ops.budgets();
  }

  @AdminRoles('finance')
  @Post('budgets/:provider/approve')
  approveBudget(@CurrentAdmin() a: AdminSession, @Param('provider') provider: string, @Body(new ZodPipe(z.object({ amountInr: z.number().positive() }))) b: { amountInr: number }) {
    return this.ops.approveBudget(provider, b.amountInr, a.userId);
  }

  @AdminRoles('finance')
  @Post('budgets/:provider/confirm')
  confirmBudget(@CurrentAdmin() a: AdminSession, @Param('provider') provider: string, @Body(new ZodPipe(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }))) b: { month: string }) {
    if (!PROVIDERS.some((p) => p.key === provider)) throw badRequest('unknown_provider', 'Unknown provider.');
    return this.ops.confirmBudget(provider, b.month, a.userId);
  }

  // ------------------------------------------------------------ businesses

  @Get('centre/businesses')
  businessList(@Query() q: Record<string, string>) {
    return this.db.adminTx(async (tx) => {
      const fx = Number((await tx.one(`SELECT value FROM platform_settings WHERE key = 'fx.usd_inr'`))?.value ?? 84) || 84;
      const sort = ({ created: 'x."createdAt"', active: 'x."lastActiveAt"', cost: 'x.ai_cost', revenue: 'x.revenue', usage: 'y.usage_pct', margin: 'y.margin' } as Record<string, string>)[q.sort ?? 'created'] ?? 'x."createdAt"';
      return tx.q(
        `SELECT * FROM (
           SELECT b.id, b.name, b.slug, b.type, b.status, p.code AS plan, b.created_at AS "createdAt", b.last_active_at AS "lastActiveAt", b.ai_paused AS "aiPaused",
             COALESCE((SELECT sum(amount) FROM subscription_charges c WHERE c.business_id = b.id AND c.charged_at >= date_trunc('month', now())), 0)::float AS revenue,
             (COALESCE((SELECT sum(cost) FROM ai_usage a WHERE a.business_id = b.id AND a.created_at >= date_trunc('month', now())), 0) * $7)::float AS ai_cost,
             (SELECT count(DISTINCT conversation_id)::int FROM ai_usage a WHERE a.business_id = b.id AND a.agent_key IN ('aria', 'vox') AND a.error IS NULL AND a.conversation_id IS NOT NULL AND a.created_at >= date_trunc('month', now())) AS conversations,
             (p.limits || b.limit_overrides) AS limits
           FROM businesses b JOIN plans p ON p.id = b.plan_id
           WHERE ($1::text IS NULL OR b.name ILIKE '%' || $1 || '%' OR b.slug ILIKE '%' || $1 || '%')
             AND ($2::text IS NULL OR p.code = $2) AND ($3::text IS NULL OR b.status = $3)
             AND ($4::timestamptz IS NULL OR b.created_at >= $4) AND ($5::timestamptz IS NULL OR b.created_at < $5)
             AND ($6::int IS NULL OR b.last_active_at >= now() - make_interval(days => $6))
         ) x,
         LATERAL (SELECT CASE WHEN (x.limits->>'aiConversationsPerMonth') IS NOT NULL THEN round(100.0 * x.conversations / GREATEST(1, (x.limits->>'aiConversationsPerMonth')::int))::int END AS usage_pct,
                         round((x.revenue * 0.83 - x.ai_cost)::numeric, 2)::float AS margin) y
         ORDER BY ${sort} DESC NULLS LAST LIMIT 300`,
        [q.q?.slice(0, 60) || null, q.plan || null, q.status || null, q.from || null, q.to || null, q.activeDays ? Number(q.activeDays) : null, fx],
      );
    });
  }

  @Get('centre/businesses/:id')
  async businessDetail(@Param('id', ParseUUIDPipe) id: string) {
    const base = await this.db.adminTx(async (tx) => {
      const b = await tx.one(
        `SELECT b.*, p.code AS plan, p.name AS "planName", bp.address, bp.phone AS "businessPhone" FROM businesses b JOIN plans p ON p.id = b.plan_id
         LEFT JOIN business_profiles bp ON bp.business_id = b.id WHERE b.id = $1`,
        [id],
      );
      if (!b) throw notFound();
      return {
        business: b,
        owners: await tx.q(`SELECT u.id, u.name, u.email, u.phone, m.role, m.status FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.business_id = $1`, [id]),
        planHistory: await tx.q(`SELECT kind, from_plan AS "from", to_plan AS "to", amount::float, status, source, at FROM plan_change_events WHERE business_id = $1 ORDER BY at DESC LIMIT 50`, [id]),
        payments: await tx.q(`SELECT provider_payment_id AS "paymentId", plan_code AS plan, amount::float, currency, charged_at AS "chargedAt" FROM subscription_charges WHERE business_id = $1 ORDER BY charged_at DESC LIMIT 50`, [id]),
        subscriptions: await tx.q(`SELECT plan_code AS plan, status, current_end AS "currentEnd", cancel_at_cycle_end AS "cancelAtCycleEnd", created_at AS "createdAt" FROM subscriptions WHERE business_id = $1 ORDER BY created_at DESC`, [id]),
        powers: await tx.q(`SELECT power_type AS type, status, account_label AS account, last_sync_at AS "lastSyncAt" FROM power_connections WHERE business_id = $1 AND status <> 'disconnected'`, [id]),
        crew: await tx.q(`SELECT agent_key AS agent, display_name AS name, enabled FROM agents WHERE business_id = $1 ORDER BY created_at`, [id]),
        wallet: await tx.q(`SELECT amount::float, kind, unit, note, created_at AS at FROM wallet_transactions WHERE business_id = $1 ORDER BY created_at DESC LIMIT 30`, [id]),
        notes: await tx.q(`SELECT n.id, n.body, n.created_at AS at, COALESCE(u.email::text, u.name) AS author FROM admin_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.business_id = $1 ORDER BY n.created_at DESC`, [id]),
        messages: await tx.q(`SELECT template_key AS template, channel, subject, status, sent_at AS "sentAt", read_at AS "readAt" FROM owner_messages WHERE business_id = $1 ORDER BY created_at DESC LIMIT 30`, [id]),
      };
    });
    const meters = await this.db.withTenant(id, (tx) => this.usage.meters(tx));
    return { ...base, meters };
  }

  private async logged<T>(a: AdminSession, businessId: string | null, action: string, after: unknown, ip: string, fn: () => Promise<T>): Promise<T> {
    const r = await fn();
    await this.audit.write({ businessId, actorId: a.userId, actorKind: 'admin', action, entity: 'business', entityId: businessId, after, ip });
    return r;
  }

  @AdminRoles('finance')
  @Post('centre/businesses/:id/trial')
  trial(@CurrentAdmin() a: AdminSession, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ plan: z.string(), days: z.number().int().min(1).max(90) }))) b: { plan: string; days: number }, @ClientIp() ip: string) {
    return this.logged(a, id, 'admin.business.trial', b, ip, () =>
      this.db.withTenant(id, async (tx) => {
        const cur = await tx.one(`SELECT b.plan_id, b.trial_ends_at, b.trial_return_plan, p.code FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.id = app_current_business()`);
        const target = await tx.one(`SELECT id FROM plans WHERE code = $1`, [b.plan]);
        if (!target) throw badRequest('unknown_plan', 'That plan does not exist.');
        // Extending an existing trial keeps the plan they return to.
        const from = cur.trial_ends_at && new Date(cur.trial_ends_at) > new Date() ? new Date(cur.trial_ends_at) : new Date();
        await tx.q(
          `UPDATE businesses SET plan_id = $1, trial_ends_at = $2, trial_return_plan = COALESCE(trial_return_plan, $3) WHERE id = app_current_business()`,
          [target.id, new Date(from.getTime() + b.days * 86_400_000), cur.code],
        );
        await syncCrewToPlan(tx, id, cur.plan_id, target.id);
        await this.ops.planEvent(tx, { kind: 'trial', from: cur.code, to: b.plan, source: 'admin', actorId: a.userId });
        this.ai.invalidate(id);
        return { ok: true };
      }),
    );
  }

  @AdminRoles('finance')
  @Post('centre/businesses/:id/credit')
  credit(@CurrentAdmin() a: AdminSession, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ amountInr: z.number().positive().max(1_000_000), kind: z.enum(['credit', 'topup']).default('credit'), note: z.string().max(300).optional() }))) b: any, @ClientIp() ip: string) {
    return this.logged(a, id, 'admin.business.credit_requested', b, ip, async () => {
      const biz = await this.db.one(`SELECT name FROM businesses WHERE id = $1`, [id]);
      if (!biz) throw notFound();
      return this.ops.request(b.kind, { businessId: id, title: `${b.kind === 'topup' ? 'Top-up' : 'Credit'} of ₹${b.amountInr} for ${biz.name}`, payload: { businessId: id, amountInr: b.amountInr, note: b.note }, costImpact: b.amountInr, marginImpact: -b.amountInr, requestedBy: a.userId });
    });
  }

  @AdminRoles('finance')
  @Post('centre/businesses/:id/refund')
  refund(@CurrentAdmin() a: AdminSession, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ paymentId: z.string().max(60).optional(), amountInr: z.number().positive(), note: z.string().max(300).optional() }))) b: any, @ClientIp() ip: string) {
    return this.logged(a, id, 'admin.business.refund_requested', b, ip, async () => {
      const biz = await this.db.one(`SELECT name FROM businesses WHERE id = $1`, [id]);
      if (!biz) throw notFound();
      return this.ops.request('refund', { businessId: id, title: `Refund ₹${b.amountInr} to ${biz.name}`, payload: { businessId: id, ...b }, costImpact: b.amountInr, marginImpact: -b.amountInr, requestedBy: a.userId });
    });
  }

  /** Custom limits: within the plan's allowances apply at once; above them need approval. Support may request. */
  @AdminRoles('support', 'finance')
  @Post('centre/businesses/:id/limits')
  limits(@CurrentAdmin() a: AdminSession, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ limits: z.record(z.union([z.number().min(0), z.null()])) }))) b: { limits: Record<string, number | null> }, @ClientIp() ip: string) {
    return this.logged(a, id, 'admin.business.limits_requested', b, ip, async () => {
      const r = await this.db.one(`SELECT b.name, p.limits FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.id = $1`, [id]);
      if (!r) throw notFound();
      const above = Object.entries(b.limits).some(([k, v]) => r.limits[k] !== undefined && (v === null ? r.limits[k] !== null : r.limits[k] !== null && v > Number(r.limits[k])));
      if (!above) {
        await this.db.adminTx((tx) => tx.q(`UPDATE businesses SET limit_overrides = $2 WHERE id = $1`, [id, JSON.stringify(b.limits)]));
        this.ai.invalidate(id);
        return { applied: true };
      }
      return this.ops.request('custom_limits', { businessId: id, title: `Custom limits above the plan for ${r.name}`, context: { plan: r.limits, requested: b.limits }, payload: { businessId: id, limits: b.limits }, requestedBy: a.userId });
    });
  }

  @AdminRoles('support')
  @Post('centre/businesses/:id/ai')
  pauseAi(@CurrentAdmin() a: AdminSession, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ paused: z.boolean(), reason: z.string().max(200).optional() }))) b: { paused: boolean; reason?: string }, @ClientIp() ip: string) {
    return this.logged(a, id, b.paused ? 'admin.business.ai_paused' : 'admin.business.ai_resumed', b, ip, async () => {
      await this.db.adminTx((tx) => tx.q(`UPDATE businesses SET ai_paused = $2, ai_paused_reason = $3 WHERE id = $1`, [id, b.paused, b.paused ? `admin:${b.reason ?? ''}` : null]));
      this.ai.invalidate(id);
      if (!b.paused) await this.usage.offerResume(id).catch(() => undefined);
      return { ok: true };
    });
  }

  @AdminRoles('finance')
  @Post('centre/businesses/:id/coupon')
  applyCoupon(@CurrentAdmin() a: AdminSession, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ code: z.string().trim().toUpperCase().nullable() }))) b: { code: string | null }, @ClientIp() ip: string) {
    return this.logged(a, id, 'admin.business.coupon', b, ip, async () => {
      if (b.code && !(await this.db.adminTx((tx) => tx.one(`SELECT 1 FROM coupons WHERE code = $1 AND active`, [b.code])))) throw badRequest('unknown_coupon', 'That coupon does not exist or is switched off.');
      await this.db.adminTx((tx) => tx.q(`UPDATE businesses SET applied_coupon = $2 WHERE id = $1`, [id, b.code]));
      return { ok: true };
    });
  }

  /** Founding-customer price: keeps this price for the plan (optionally until a date). */
  @AdminRoles('finance')
  @Post('centre/businesses/:id/price-lock')
  priceLock(@CurrentAdmin() a: AdminSession, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ plan: z.string(), INR: z.number().min(0), until: z.string().datetime().nullable().optional() }).nullable())) b: any, @ClientIp() ip: string) {
    return this.logged(a, id, 'admin.business.price_lock', b, ip, async () => {
      await this.db.adminTx((tx) => tx.q(`UPDATE businesses SET price_lock = $2 WHERE id = $1`, [id, b ? JSON.stringify({ ...b, founding: true }) : null]));
      return { ok: true };
    });
  }

  @AdminRoles('finance')
  @Post('centre/businesses/:id/enterprise')
  enterprise(@CurrentAdmin() a: AdminSession, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ priceInr: z.number().min(0), until: z.string().datetime().nullable().optional() }))) b: any, @ClientIp() ip: string) {
    return this.logged(a, id, 'admin.business.enterprise_requested', b, ip, async () => {
      const biz = await this.db.one(`SELECT name FROM businesses WHERE id = $1`, [id]);
      if (!biz) throw notFound();
      return this.ops.request('enterprise_deal', { businessId: id, title: `Enterprise deal for ${biz.name} at ₹${b.priceInr}/month`, payload: { businessId: id, planCode: 'enterprise', ...b }, costImpact: null, marginImpact: b.priceInr, requestedBy: a.userId });
    });
  }

  @AdminRoles('support')
  @Post('centre/businesses/:id/notes')
  addNote(@CurrentAdmin() a: AdminSession, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ body: z.string().trim().min(1).max(2000) }))) b: { body: string }) {
    return this.db.adminTx((tx) => tx.one(`INSERT INTO admin_notes (business_id, author_id, body) VALUES ($1, $2, $3) RETURNING id`, [id, a.userId, b.body]));
  }

  /** Data export on request (DPDP / GDPR): the business's records as one JSON file. */
  @AdminRoles('owner')
  @Get('centre/businesses/:id/export')
  async exportBusiness(@CurrentAdmin() a: AdminSession, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string, @Res() res: Response) {
    const tables = ['business_profiles', 'customers', 'conversations', 'messages', 'bookings', 'services', 'staff', 'leads', 'invoices', 'payments', 'feed_events', 'calls', 'knowledge_items'];
    const data: Record<string, unknown> = {};
    await this.db.adminTx(async (tx) => {
      data.business = await tx.one(`SELECT * FROM businesses WHERE id = $1`, [id]);
      if (!data.business) throw notFound();
      for (const t of tables) data[t] = await tx.q(`SELECT * FROM ${t} WHERE business_id = $1`, [id]).catch(() => []);
    });
    await this.audit.write({ businessId: id, actorId: a.userId, actorKind: 'admin', action: 'admin.business.export', entity: 'business', entityId: id, ip });
    res.setHeader('content-type', 'application/json');
    res.setHeader('content-disposition', `attachment; filename="orbit-business-${id}.json"`);
    res.send(JSON.stringify(data, null, 1));
  }

  /** Delete on request: everything for the business goes (the audit log keeps the record that it happened). */
  @AdminRoles('owner')
  @Delete('centre/businesses/:id')
  async deleteBusiness(@CurrentAdmin() a: AdminSession, @Param('id', ParseUUIDPipe) id: string, @Query('confirm') confirm: string, @ClientIp() ip: string) {
    const b = await this.db.one(`SELECT name, slug FROM businesses WHERE id = $1`, [id]);
    if (!b) throw notFound();
    if (confirm !== b.slug) throw badRequest('confirm_needed', `To delete, confirm with the business's address name (${b.slug}).`);
    await this.audit.write({ businessId: null, actorId: a.userId, actorKind: 'admin', action: 'admin.business.delete', entity: 'business', entityId: id, before: { name: b.name, slug: b.slug }, ip });
    await this.db.adminTx((tx) => tx.q(`DELETE FROM businesses WHERE id = $1`, [id]));
    return { ok: true };
  }

  // ------------------------------------------------------------ coupons and plan price changes

  @Get('coupons')
  coupons() {
    return this.db.adminTx((tx) => tx.q(`SELECT c.*, (SELECT count(*)::int FROM coupon_redemptions r WHERE r.coupon_code = c.code) AS redemptions FROM coupons c ORDER BY created_at DESC`));
  }

  @AdminRoles('finance')
  @Post('coupons')
  async saveCoupon(@CurrentAdmin() a: AdminSession, @Body(new ZodPipe(Coupon)) b: z.infer<typeof Coupon>, @ClientIp() ip: string) {
    if (b.kind === 'percent' && b.value > 100) throw badRequest('invalid_value', 'A percentage cannot be above 100.');
    return this.db.adminTx(async (tx) => {
      const r = await tx.one(
        `INSERT INTO coupons (code, kind, value, valid_from, valid_to, max_uses, eligible_plans, active, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (code) DO UPDATE SET kind = EXCLUDED.kind, value = EXCLUDED.value, valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to, max_uses = EXCLUDED.max_uses, eligible_plans = EXCLUDED.eligible_plans, active = EXCLUDED.active
         RETURNING *`,
        [b.code, b.kind, b.value, b.validFrom ?? null, b.validTo ?? null, b.maxUses ?? null, b.eligiblePlans, b.active, a.userId],
      );
      await this.audit.write({ actorId: a.userId, actorKind: 'admin', action: 'admin.coupon.save', entity: 'coupon', after: r, ip }, tx);
      return r;
    });
  }

  /**
   * After a plan's price changes (Plans tab): new subscribers always get the new price;
   * existing ones keep their terms, move at their next renewal, or move now.
   */
  @AdminRoles('finance')
  @Post('plans/:code/apply-price')
  async applyPrice(@CurrentAdmin() a: AdminSession, @Param('code') code: string, @Body(new ZodPipe(z.object({ mode: z.enum(['keep', 'renewal', 'now']) }))) b: { mode: 'keep' | 'renewal' | 'now' }, @ClientIp() ip: string) {
    const subs = await this.db.adminTx((tx) =>
      tx.q(`SELECT s.id, s.business_id, s.provider_subscription_id FROM subscriptions s JOIN businesses b ON b.id = s.business_id WHERE s.plan_code = $1 AND s.status = 'active' AND (b.price_lock IS NULL OR b.price_lock->>'plan' <> $1)`, [code]),
    );
    let moved = 0;
    const failed: string[] = [];
    if (b.mode !== 'keep') {
      const keyId = process.env.ORBIT_RAZORPAY_KEY_ID;
      const secret = process.env.ORBIT_RAZORPAY_KEY_SECRET;
      if (!keyId || !secret) throw badRequest('billing_not_configured', "Orbit's Razorpay keys are not set, so existing subscriptions cannot be changed.");
      const plan = await this.db.one(`SELECT name, prices, provider_refs FROM plans WHERE code = $1`, [code]);
      const inr = Number(plan.prices?.INR ?? 0);
      const auth = `Basic ${Buffer.from(`${keyId}:${secret}`).toString('base64')}`;
      let planId = plan.provider_refs?.[`razorpay:INR:${inr}`];
      if (!planId) {
        const r = await fetch('https://api.razorpay.com/v1/plans', { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ period: 'monthly', interval: 1, item: { name: `Orbit ${plan.name}`, amount: Math.round(inr * 100), currency: 'INR' } }) });
        const d: any = await r.json();
        if (!r.ok) throw badRequest('razorpay_failed', d?.error?.description ?? 'Razorpay could not create the plan.');
        planId = d.id;
        await this.db.adminTx((tx) => tx.q(`UPDATE plans SET provider_refs = provider_refs || jsonb_build_object($2::text, $3::text) WHERE code = $1`, [code, `razorpay:INR:${inr}`, planId]));
      }
      for (const s of subs) {
        const r = await fetch(`https://api.razorpay.com/v1/subscriptions/${encodeURIComponent(s.provider_subscription_id)}`, {
          method: 'PATCH', headers: { authorization: auth, 'content-type': 'application/json' },
          body: JSON.stringify({ plan_id: planId, schedule_change_at: b.mode === 'now' ? 'now' : 'cycle_end' }),
        });
        if (r.ok) moved++;
        else failed.push(s.provider_subscription_id);
      }
    }
    await this.audit.write({ actorId: a.userId, actorKind: 'admin', action: 'admin.plan.apply_price', entity: 'plan', after: { code, mode: b.mode, existing: subs.length, moved, failed }, ip });
    return { existing: subs.length, moved, failed, mode: b.mode };
  }

  // ------------------------------------------------------------ messaging centre

  @Get('messaging/templates')
  async templates() {
    const rows = await this.db.adminTx((tx) => tx.q(`SELECT * FROM message_templates ORDER BY key`));
    return Promise.all(rows.map(async (t) => ({ ...t, stats: await this.messaging.stats({ templateKey: t.key }) })));
  }

  @AdminRoles('support')
  @Put('messaging/templates/:key')
  async putTemplate(@CurrentAdmin() a: AdminSession, @Param('key') key: string, @Body(new ZodPipe(TemplatePut)) b: z.infer<typeof TemplatePut>, @ClientIp() ip: string) {
    return this.db.adminTx(async (tx) => {
      const before = await tx.one(`SELECT * FROM message_templates WHERE key = $1`, [key]);
      if (!before) throw notFound();
      const r = await tx.one(
        `UPDATE message_templates SET name = COALESCE($2, name), channels = COALESCE($3, channels), timing = COALESCE($4, timing), content = COALESCE($5, content), enabled = COALESCE($6, enabled), updated_by = $7, updated_at = now() WHERE key = $1 RETURNING *`,
        [key, b.name ?? null, b.channels ?? null, b.timing ? JSON.stringify(b.timing) : null, b.content ? JSON.stringify(b.content) : null, b.enabled ?? null, a.userId],
      );
      await this.audit.write({ actorId: a.userId, actorKind: 'admin', action: 'admin.message_template.update', entity: 'message_template', before, after: r, ip }, tx);
      return r;
    });
  }

  /** Live preview with sample values. */
  @AdminRoles('owner', 'finance', 'support', 'viewer')
  @Post('messaging/preview')
  preview(@Body(new ZodPipe(z.object({ content: Content, lang: z.enum(['en', 'hi', 'kn']).default('en'), params: z.record(z.unknown()).default({}) }))) b: any) {
    const sample = { owner: 'Meera', business: 'Glow Studio', plan: 'Pro', date: '20 Nov', amount: '₹2,999', graceDays: 7, daysLeft: 5, used: 16, cap: 20, period: 'today', count: 3, lost: 'Nudge, Ledger', new: 'Vox, Spark', link: 'https://orbit.app/bridge', ...b.params };
    const t = b.content[b.lang] ?? b.content.en;
    return { subject: render(t.subject, sample), body: render(t.body, sample) };
  }

  @Get('messaging/broadcasts')
  async broadcasts() {
    const rows = await this.db.adminTx((tx) => tx.q(`SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 100`));
    return Promise.all(rows.map(async (b) => ({ ...b, stats: await this.messaging.stats({ broadcastId: b.id }) })));
  }

  @AdminRoles('owner', 'finance', 'support', 'viewer')
  @Post('messaging/audience')
  audience(@Body(new ZodPipe(z.object({ segment: SegmentZ, category: z.enum(['transactional', 'marketing']).default('marketing') }))) b: { segment: Segment; category: 'transactional' | 'marketing' }) {
    return this.messaging.previewAudience(b.segment, b.category);
  }

  @AdminRoles('support')
  @Post('messaging/broadcasts')
  async createBroadcast(@CurrentAdmin() a: AdminSession, @Body(new ZodPipe(Broadcast)) b: z.infer<typeof Broadcast>, @ClientIp() ip: string) {
    const r = await this.db.adminTx((tx) =>
      tx.one(
        `INSERT INTO broadcasts (title, content, segment, channels, category, link, scheduled_at, status, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [b.title, JSON.stringify(b.content), JSON.stringify(b.segment), b.channels, b.category, b.link ?? null, b.scheduledAt ?? null, b.scheduledAt ? 'scheduled' : 'draft', a.userId],
      ),
    );
    await this.audit.write({ actorId: a.userId, actorKind: 'admin', action: 'admin.broadcast.create', entity: 'broadcast', entityId: r.id, after: { title: b.title, segment: b.segment, scheduledAt: b.scheduledAt ?? null }, ip });
    return r;
  }

  @AdminRoles('support')
  @Post('messaging/broadcasts/:id/send')
  async sendBroadcast(@CurrentAdmin() a: AdminSession, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string) {
    const queued = await this.messaging.sendBroadcast(id);
    await this.audit.write({ actorId: a.userId, actorKind: 'admin', action: 'admin.broadcast.send', entity: 'broadcast', entityId: id, after: { queued }, ip });
    return { queued, stats: await this.messaging.stats({ broadcastId: id }) };
  }

  @AdminRoles('support')
  @Post('messaging/broadcasts/:id/cancel')
  cancelBroadcast(@Param('id', ParseUUIDPipe) id: string) {
    return this.db.adminTx((tx) => tx.one(`UPDATE broadcasts SET status = 'cancelled' WHERE id = $1 AND status IN ('draft', 'scheduled') RETURNING id, status`, [id]));
  }

  /** A one-off message to one business's owners (sent now). */
  @AdminRoles('support')
  @Post('messaging/one-off')
  async oneOff(@CurrentAdmin() a: AdminSession, @Body(new ZodPipe(OneOff)) b: z.infer<typeof OneOff>, @ClientIp() ip: string) {
    const r = await this.createBroadcast(a, { title: `One-off: ${b.content.en.subject}`, content: b.content, segment: { businessIds: [b.businessId] }, channels: b.channels, category: 'transactional', link: b.link }, ip);
    return this.sendBroadcast(a, r.id, ip);
  }

  // ------------------------------------------------------------ reports and exports

  @Get('reports/monthly')
  monthly(@Query('months') monthsRaw?: string) {
    const months = Math.min(24, Math.max(1, Number(monthsRaw) || 12));
    return this.db.adminTx(async (tx) => {
      const fx = Number((await tx.one(`SELECT value FROM platform_settings WHERE key = 'fx.usd_inr'`))?.value ?? 84) || 84;
      const factor = Number((await tx.one(`SELECT value FROM platform_settings WHERE key = 'ai.net_revenue_factor'`))?.value ?? 0.83) || 0.83;
      const rows = await tx.q(
        `WITH m AS (SELECT to_char(d, 'YYYY-MM') AS month, d AS s, d + interval '1 month' AS e FROM generate_series(date_trunc('month', now()) - make_interval(months => $1 - 1), date_trunc('month', now()), interval '1 month') d)
         SELECT m.month,
           COALESCE((SELECT sum(amount) FROM subscription_charges c WHERE c.charged_at >= m.s AND c.charged_at < m.e), 0)::float AS gross,
           (COALESCE((SELECT sum(cost) FROM ai_usage a WHERE a.created_at >= m.s AND a.created_at < m.e), 0) * $2)::float AS ai_cost,
           (SELECT count(*)::int FROM plan_change_events p WHERE p.kind = 'upgrade' AND p.at >= m.s AND p.at < m.e) AS upgrades,
           (SELECT count(*)::int FROM plan_change_events p WHERE p.kind IN ('downgrade', 'cancel', 'grace_ended') AND p.at >= m.s AND p.at < m.e) AS churned,
           (SELECT count(*)::int FROM businesses b WHERE b.created_at >= m.s AND b.created_at < m.e) AS signups,
           (SELECT count(DISTINCT business_id)::int FROM subscription_charges c WHERE c.charged_at >= m.s AND c.charged_at < m.e) AS paying
         FROM m ORDER BY m.month`,
        [months, fx],
      );
      const byPlan = await tx.q(
        `SELECT to_char(charged_at, 'YYYY-MM') AS month, plan_code AS plan, sum(amount)::float AS gross FROM subscription_charges WHERE charged_at >= date_trunc('month', now()) - make_interval(months => $1 - 1) GROUP BY 1, 2 ORDER BY 1, 2`,
        [months],
      );
      const byProvider = await tx.q(
        `SELECT to_char(created_at, 'YYYY-MM') AS month, COALESCE(provider, 'unknown') AS provider, (sum(cost) * $2)::float AS inr FROM ai_usage WHERE created_at >= date_trunc('month', now()) - make_interval(months => $1 - 1) GROUP BY 1, 2 ORDER BY 1, 2`,
        [months, fx],
      );
      return {
        months: rows.map((r, i) => {
          const net = r.gross * factor;
          const prevPaying = i > 0 ? rows[i - 1].paying : 0;
          return { ...r, net: Math.round(net), margin: Math.round(net - r.ai_cost), upgradeRate: r.signups ? Math.round((r.upgrades / r.signups) * 100) : null, churnRate: prevPaying ? Math.round((r.churned / prevPaying) * 100) : null };
        }),
        byPlan,
        byProvider,
      };
    });
  }

  /** Retention by signup month: still active in the last 30 days, and paying now. */
  @Get('reports/cohorts')
  cohorts() {
    return this.db.adminTx((tx) =>
      tx.q(
        `SELECT to_char(b.created_at, 'YYYY-MM') AS cohort, count(*)::int AS businesses,
                count(*) FILTER (WHERE b.last_active_at >= now() - interval '30 days')::int AS active,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM subscriptions s WHERE s.business_id = b.id AND s.status = 'active'))::int AS paying,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM plan_change_events e WHERE e.business_id = b.id AND e.kind = 'upgrade'))::int AS "everUpgraded"
         FROM businesses b GROUP BY 1 ORDER BY 1 DESC LIMIT 24`,
      ),
    );
  }

  /** GST summary of plan payments for the accountant (prices include 18% GST). */
  @Get('reports/gst')
  gst(@Query('month') month?: string) {
    const m = month && /^\d{4}-\d{2}$/.test(month) ? month : new Date().toISOString().slice(0, 7);
    return this.db.adminTx(async (tx) => {
      const rows = await tx.q(
        `SELECT c.charged_at AS "date", b.name AS business, c.plan_code AS plan, c.provider_payment_id AS "paymentId", c.amount::float AS gross,
                round(c.amount / 1.18, 2)::float AS taxable, round(c.amount - c.amount / 1.18, 2)::float AS gst
         FROM subscription_charges c JOIN businesses b ON b.id = c.business_id
         WHERE c.currency = 'INR' AND c.charged_at >= to_date($1, 'YYYY-MM') AND c.charged_at < to_date($1, 'YYYY-MM') + interval '1 month' ORDER BY c.charged_at`,
        [m],
      );
      const sum = (k: string) => Math.round(rows.reduce((s, r) => s + Number(r[k]), 0) * 100) / 100;
      return { month: m, rate: 18, rows, totals: { gross: sum('gross'), taxable: sum('taxable'), gst: sum('gst') }, note: 'Prices include 18% GST. Split into CGST+SGST or IGST by the customer state when filing.' };
    });
  }

  @Get('export/:dataset')
  async export(@CurrentAdmin() a: AdminSession, @Param('dataset') dataset: string, @Query('month') month: string | undefined, @ClientIp() ip: string, @Res() res: Response) {
    const m = month && /^\d{4}-\d{2}$/.test(month) ? month : null;
    const queries: Record<string, string> = {
      businesses: `SELECT b.id, b.name, b.slug, b.type, b.status, p.code AS plan, b.created_at, b.last_active_at, b.ai_wallet_balance FROM businesses b JOIN plans p ON p.id = b.plan_id ORDER BY b.created_at`,
      payments: `SELECT c.charged_at, b.name AS business, c.plan_code, c.provider_payment_id, c.amount, c.currency FROM subscription_charges c JOIN businesses b ON b.id = c.business_id WHERE ($1::text IS NULL OR to_char(c.charged_at, 'YYYY-MM') = $1) ORDER BY c.charged_at`,
      plan_changes: `SELECT e.at, b.name AS business, e.kind, e.from_plan, e.to_plan, e.amount, e.source FROM plan_change_events e JOIN businesses b ON b.id = e.business_id WHERE ($1::text IS NULL OR to_char(e.at, 'YYYY-MM') = $1) ORDER BY e.at`,
      ai_costs: `SELECT to_char(a.created_at, 'YYYY-MM') AS month, b.name AS business, a.provider, a.model, a.tier, a.task_type, count(*) AS calls, sum(a.input_tokens) AS input_tokens, sum(a.output_tokens) AS output_tokens, round(sum(a.cost)::numeric, 4) AS cost_usd
                 FROM ai_usage a JOIN businesses b ON b.id = a.business_id WHERE ($1::text IS NULL OR to_char(a.created_at, 'YYYY-MM') = $1) GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 1, 2`,
      approvals: `SELECT a.created_at, a.kind, a.title, a.status, a.cost_impact, a.decided_at, a.decision_note FROM admin_approvals a WHERE ($1::text IS NULL OR to_char(a.created_at, 'YYYY-MM') = $1) ORDER BY a.created_at`,
      audit: `SELECT a.at, a.action, a.actor_kind, COALESCE(u.email::text, u.name) AS actor, a.entity, a.entity_id, a.business_id FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE ($1::text IS NULL OR to_char(a.at, 'YYYY-MM') = $1) ORDER BY a.at`,
      owner_messages: `SELECT om.created_at, b.name AS business, om.template_key, om.channel, om.subject, om.status, om.sent_at, om.read_at, om.clicked_at FROM owner_messages om JOIN businesses b ON b.id = om.business_id WHERE ($1::text IS NULL OR to_char(om.created_at, 'YYYY-MM') = $1) ORDER BY om.created_at`,
    };
    const sql = queries[dataset];
    if (!sql) throw notFound('Unknown export.');
    const rows = await this.db.adminTx((tx) => tx.q(sql, sql.includes('$1') ? [m] : []));
    await this.audit.write({ actorId: a.userId, actorKind: 'admin', action: 'admin.export', entity: 'export', after: { dataset, month: m, rows: rows.length }, ip });
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="orbit-${dataset}${m ? `-${m}` : ''}.csv"`);
    res.send(csv(rows));
  }

  // ------------------------------------------------------------ platform settings and feature switches

  @Get('settings')
  settings() {
    return this.db.adminTx(async (tx) => {
      const rows = await tx.q(`SELECT key, value, updated_at AS "updatedAt" FROM platform_settings WHERE key = ANY($1)`, [SETTINGS as unknown as string[]]);
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    });
  }

  @Put('settings/:key')
  async putSetting(@CurrentAdmin() a: AdminSession, @Param('key') key: string, @Body() body: { value: unknown }, @ClientIp() ip: string) {
    if (!(SETTINGS as readonly string[]).includes(key)) throw badRequest('unknown_setting', 'That setting cannot be changed here.');
    if (body?.value === undefined) throw badRequest('invalid_input', 'A value is required.');
    return this.db.adminTx(async (tx) => {
      const before = await tx.one(`SELECT value FROM platform_settings WHERE key = $1`, [key]);
      await tx.q(
        `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, JSON.stringify(body.value), a.userId],
      );
      await this.audit.write({ actorId: a.userId, actorKind: 'admin', action: 'admin.setting.update', entity: 'platform_settings', before: { key, value: before?.value }, after: { key, value: body.value }, ip }, tx);
      if (key === 'maintenance') resetMaintenanceCache();
      return { ok: true };
    });
  }

  @Get('features')
  features() {
    return this.db.adminTx((tx) => tx.q(`SELECT * FROM feature_flags ORDER BY key`));
  }

  @Put('features/:key')
  async putFeature(@CurrentAdmin() a: AdminSession, @Param('key') key: string, @Body(new ZodPipe(z.object({ description: z.string().max(200).optional(), enabled: z.boolean(), allow: z.array(UUID).default([]), deny: z.array(UUID).default([]) }))) b: any, @ClientIp() ip: string) {
    if (!/^[a-z0-9_.-]{2,60}$/.test(key)) throw badRequest('invalid_key', 'Use lowercase letters, numbers, dots and dashes.');
    return this.db.adminTx(async (tx) => {
      const r = await tx.one(
        `INSERT INTO feature_flags (key, description, enabled, allow, deny, updated_by) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (key) DO UPDATE SET description = COALESCE(EXCLUDED.description, feature_flags.description), enabled = EXCLUDED.enabled, allow = EXCLUDED.allow, deny = EXCLUDED.deny, updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING *`,
        [key, b.description ?? null, b.enabled, b.allow, b.deny, a.userId],
      );
      await this.audit.write({ actorId: a.userId, actorKind: 'admin', action: 'admin.feature.update', entity: 'feature_flag', after: r, ip }, tx);
      return r;
    });
  }
}
