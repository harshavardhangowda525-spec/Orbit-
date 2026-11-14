import { Injectable, OnModuleInit } from '@nestjs/common';
import { DbService, type Tx } from '../db/db.service';
import { JobsService } from '../jobs/jobs.service';
import { AiService } from '../ai/ai.service';
import { AuditService } from '../audit/audit.service';
import { syncCrewToPlan } from '../billing/crew-plan';
import { badRequest, notFound } from '../common/errors';
import { logger } from '../logger';
import { MessagingService } from './messaging.service';

export type ApprovalKind = 'enterprise_deal' | 'custom_limits' | 'topup' | 'refund' | 'credit' | 'ai_cost' | 'budget_increase';
type PlanEventKind = 'upgrade' | 'downgrade' | 'cancel' | 'payment_failed' | 'renewal' | 'trial' | 'grace_ended';

/** Orbit's own AI/voice providers (the businesses' WhatsApp, SMS and phone accounts are billed to them directly). */
export const PROVIDERS = [
  { key: 'groq', name: 'Groq', billingUrl: 'https://console.groq.com/settings/billing', kind: 'ai' },
  { key: 'claude', name: 'Anthropic', billingUrl: 'https://console.anthropic.com/settings/limits', kind: 'ai' },
  { key: 'sarvam', name: 'Sarvam AI (speech)', billingUrl: 'https://dashboard.sarvam.ai', kind: 'speech' },
] as const;

const DEFAULT_RULE_ACTION: Record<ApprovalKind, 'approve' | 'reject'> = {
  enterprise_deal: 'reject', custom_limits: 'reject', topup: 'reject', refund: 'reject', credit: 'reject', ai_cost: 'reject', budget_increase: 'reject',
};

const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

async function setting<T = any>(tx: Tx, key: string, fallback: T): Promise<T> {
  const r = await tx.one<{ value: T }>(`SELECT value FROM platform_settings WHERE key = $1`, [key]);
  return (r?.value ?? fallback) as T;
}

/**
 * The admin control centre's engine: admin alerts, the subscriptions feed, the
 * overview, the failed-payment grace period, approvals, provider budgets and the
 * abnormal-usage watch. Money never moves here: payments are Razorpay's, provider
 * bills are paid by the card saved with each provider.
 */
@Injectable()
export class AdminOpsService implements OnModuleInit {
  constructor(
    private readonly db: DbService,
    private readonly jobs: JobsService,
    private readonly ai: AiService,
    private readonly audit: AuditService,
    private readonly messaging: MessagingService,
  ) {}

  onModuleInit() {
    this.jobs.register('admin.hourly', () => this.hourly());
    this.jobs.register('admin.watch', () => this.watchAiCost());
    this.jobs.register('admin.notify_email', (d) => this.emailAdmins(d.type, d.title, d.body));
  }

  // ------------------------------------------------------------ admin alerts

  /** In-app alert for the admin team, plus email when that type is set to email (Admin → Settings). */
  async notifyAdmins(type: string, title: string, body: string | null = null, link: string | null = null, data: Record<string, unknown> = {}) {
    const channels = await this.db.adminTx(async (tx) => {
      const cfg = await setting<Record<string, string[]>>(tx, 'admin.notify', {});
      const ch = cfg[type] ?? ['inapp'];
      if (ch.includes('inapp')) await tx.q(`INSERT INTO admin_notifications (type, title, body, link, data) VALUES ($1, $2, $3, $4, $5)`, [type, title, body, link, JSON.stringify(data)]);
      return ch;
    });
    if (channels.includes('email')) await this.jobs.enqueue('admin.notify_email', { type, title, body }, { jobId: `admin-email:${type}:${Date.now()}` }).catch(() => undefined);
  }

  private async emailAdmins(type: string, title: string, body: string | null) {
    const key = process.env.EMAIL_API_KEY;
    if (!key) return 0;
    const to = await this.db.adminTx((tx) => tx.q(`SELECT u.email FROM admin_users a JOIN users u ON u.id = a.user_id WHERE a.status = 'active' AND u.email IS NOT NULL AND a.role IN ('owner', 'finance', 'support')`));
    if (!to.length) return 0;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM || 'Orbit <onboarding@resend.dev>', to: to.map((r) => r.email), subject: `[Orbit admin] ${title}`, text: `${title}\n\n${body ?? ''}\n\n(${type})` }),
      signal: AbortSignal.timeout(15_000),
    }).catch((e) => logger.warn(`admin email failed: ${e.message}`, 'Admin'));
    return to.length;
  }

  // ------------------------------------------------------------ subscriptions feed

  /** Record a plan change for the feed and the reports, and tell the admin team. Call inside the business's transaction. */
  async planEvent(tx: Tx, e: { kind: PlanEventKind; from?: string | null; to?: string | null; amount?: number | null; status?: string | null; source?: string; actorId?: string | null }) {
    await tx.q(
      `INSERT INTO plan_change_events (kind, from_plan, to_plan, amount, status, source, actor_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [e.kind, e.from ?? null, e.to ?? null, e.amount ?? null, e.status ?? null, e.source ?? 'razorpay', e.actorId ?? null],
    );
    const biz = await tx.one(`SELECT id, name FROM businesses WHERE id = app_current_business()`);
    if (e.kind === 'renewal' || e.kind === 'trial') return;
    const label = { upgrade: 'upgraded', downgrade: 'downgraded', cancel: 'cancelled', payment_failed: 'payment failed', grace_ended: 'moved to Free after the grace period' }[e.kind];
    const title = `${biz.name} ${label}${e.from || e.to ? ` · ${e.from ?? '—'} → ${e.to ?? '—'}` : ''}${e.amount ? ` · ${inr(e.amount)}` : ''}`;
    const type = e.kind === 'grace_ended' ? 'downgrade' : e.kind;
    tx.afterCommit(() => this.notifyAdmins(type, title, null, `/admin?tab=businesses&id=${biz.id}`, { businessId: biz.id }).catch(() => undefined));
  }

  async feed(limit = 50) {
    return this.db.adminTx((tx) =>
      tx.q(
        `SELECT e.id, e.kind, e.from_plan AS "from", e.to_plan AS "to", e.amount::float AS amount, e.status, e.source, e.at, b.id AS "businessId", b.name AS business
         FROM plan_change_events e JOIN businesses b ON b.id = e.business_id ORDER BY e.at DESC LIMIT $1`,
        [Math.min(200, limit)],
      ),
    );
  }

  // ------------------------------------------------------------ failed payments: grace, then Free

  /** A payment failed: tell the owner, start the grace period (once), record it. Inside the business's transaction. */
  async paymentFailed(tx: Tx, businessId: string, planCode: string) {
    const days = Number(await setting(tx, 'billing.grace_days', 7)) || 7;
    const g = await tx.one(`UPDATE businesses SET grace_until = COALESCE(grace_until, now() + make_interval(days => $1)) WHERE id = app_current_business() RETURNING grace_until`, [days]);
    await this.planEvent(tx, { kind: 'payment_failed', from: planCode, to: planCode, status: 'failed' });
    const plan = await tx.one(`SELECT name FROM plans WHERE code = $1`, [planCode]);
    tx.afterCommit(() => {
      this.messaging.sendTemplate(businessId, 'payment_failed', { plan: plan?.name ?? planCode, graceDays: days }, { dedupe: `payment_failed:${businessId}:${new Date(g.grace_until).toISOString().slice(0, 10)}` }).catch(() => undefined);
    });
  }

  /** Payment back to normal: end any grace period. */
  async paymentRecovered(tx: Tx) {
    await tx.q(`UPDATE businesses SET grace_until = NULL WHERE id = app_current_business() AND grace_until IS NOT NULL`);
  }

  /** Move a business to Free (grace over, cancelled, or trial ended): Crew follows, owner told what changed. */
  async moveToFree(businessId: string, kind: 'grace_ended' | 'cancel' | 'downgrade', templateKey: string | null = 'plan_expired') {
    const r = await this.db.withTenant(businessId, async (tx) => {
      const before = await tx.one(`SELECT b.plan_id, p.code, p.name, p.features FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.id = app_current_business()`);
      if (!before || before.code === 'free') return null;
      const free = await tx.one(`UPDATE businesses SET plan_id = (SELECT id FROM plans WHERE code = 'free'), grace_until = NULL, trial_ends_at = NULL WHERE id = app_current_business() RETURNING plan_id`);
      await syncCrewToPlan(tx, businessId, before.plan_id, free.plan_id);
      await this.planEvent(tx, { kind, from: before.code, to: 'free', source: kind === 'grace_ended' ? 'grace' : 'razorpay' });
      const freeAgents = (await tx.one(`SELECT features FROM plans WHERE code = 'free'`))?.features?.agents ?? [];
      const lost = (before.features?.agents ?? []).filter((a: string) => !freeAgents.includes(a) && a !== 'orbit').map((a: string) => a[0].toUpperCase() + a.slice(1));
      return { plan: before.name, lost: [...lost, 'higher AI allowance'].join(', ') };
    });
    if (!r) return false;
    this.ai.invalidate(businessId);
    if (templateKey) await this.messaging.sendTemplate(businessId, templateKey, r, { dedupe: `${templateKey}:${businessId}:${new Date().toISOString().slice(0, 10)}` });
    return true;
  }

  // ------------------------------------------------------------ hourly: reminders, grace, trials, approvals timeout, budgets

  async hourly(now = new Date()) {
    const out = { renewals: 0, grace: 0, downgraded: 0, trials: 0, approvals: 0, budgets: 0 };
    // Renewal reminders 7, 3 and 1 days before (one per subscription period).
    const subs = await this.db.adminTx((tx) =>
      tx.q(
        `SELECT s.id, s.business_id, s.plan_code, s.current_end, p.name, p.prices, b.price_lock
         FROM subscriptions s JOIN businesses b ON b.id = s.business_id JOIN plans p ON p.code = s.plan_code
         WHERE s.status = 'active' AND NOT s.cancel_at_cycle_end AND s.current_end > $1 AND s.current_end <= $1::timestamptz + interval '8 days'`,
        [now.toISOString()],
      ),
    );
    for (const s of subs) {
      const daysLeft = Math.ceil((new Date(s.current_end).getTime() - now.getTime()) / 86_400_000);
      const d = [7, 3, 1].find((x) => daysLeft <= x && daysLeft > (x === 7 ? 3 : x === 3 ? 1 : 0));
      if (!d) continue;
      const price = s.price_lock?.plan === s.plan_code && s.price_lock?.INR != null ? s.price_lock.INR : s.prices?.INR;
      out.renewals += await this.messaging.sendTemplate(s.business_id, `renewal_${d}`, { plan: s.name, date: new Date(s.current_end).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }), amount: inr(Number(price ?? 0)) }, { dedupe: `renewal_${d}:${s.id}:${new Date(s.current_end).toISOString().slice(0, 10)}` });
    }
    // Grace period: reminders every two days, then Free when it is over and no payment arrived.
    const grace = await this.db.adminTx((tx) =>
      tx.q(`SELECT b.id, b.grace_until, p.name, p.code, EXISTS (SELECT 1 FROM subscriptions s WHERE s.business_id = b.id AND s.status = 'active') AS paid FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.grace_until IS NOT NULL`),
    );
    for (const g of grace) {
      if (g.paid) {
        await this.db.withTenant(g.id, (tx) => this.paymentRecovered(tx));
        continue;
      }
      const left = Math.ceil((new Date(g.grace_until).getTime() - now.getTime()) / 86_400_000);
      if (left <= 0) {
        if (await this.moveToFree(g.id, 'grace_ended')) out.downgraded++;
      } else if (left % 2 === 1 || left <= 1) {
        out.grace += await this.messaging.sendTemplate(g.id, 'grace_reminder', { plan: g.name, daysLeft: left }, { dedupe: `grace:${g.id}:${left}` });
      }
    }
    // Trials: a heads-up 3 days before, then back to the plan they came from.
    const trials = await this.db.adminTx((tx) => tx.q(`SELECT b.id, b.trial_ends_at, b.trial_return_plan, p.name FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.trial_ends_at IS NOT NULL`));
    for (const t of trials) {
      const left = (new Date(t.trial_ends_at).getTime() - now.getTime()) / 86_400_000;
      if (left <= 0) {
        await this.endTrial(t.id, t.trial_return_plan ?? 'free');
        out.trials++;
      } else if (left <= 3) {
        out.trials += await this.messaging.sendTemplate(t.id, 'trial_ending', { plan: t.name, date: new Date(t.trial_ends_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) }, { dedupe: `trial_ending:${t.id}:${new Date(t.trial_ends_at).toISOString().slice(0, 10)}` });
      }
    }
    out.approvals = await this.expireApprovals(now);
    out.budgets = await this.checkBudgets(now);
    // AI paused for the day by the cost watch: back on the next day.
    await this.db.adminTx((tx) => tx.q(`UPDATE businesses SET ai_paused = false, ai_paused_reason = NULL WHERE ai_paused AND ai_paused_reason LIKE 'ai_cost:%' AND split_part(ai_paused_reason, ':', 2) < $1`, [now.toISOString().slice(0, 10)]));
    return out;
  }

  async endTrial(businessId: string, returnPlan: string) {
    await this.db.withTenant(businessId, async (tx) => {
      const before = await tx.one(`SELECT b.plan_id, p.code FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.id = app_current_business()`);
      const to = await tx.one(`UPDATE businesses SET plan_id = (SELECT id FROM plans WHERE code = $1), trial_ends_at = NULL, trial_return_plan = NULL WHERE id = app_current_business() RETURNING plan_id`, [returnPlan]);
      await syncCrewToPlan(tx, businessId, before.plan_id, to.plan_id);
      await this.planEvent(tx, { kind: 'downgrade', from: before.code, to: returnPlan, source: 'trial' });
    });
    this.ai.invalidate(businessId);
  }

  // ------------------------------------------------------------ approvals

  /**
   * Ask for approval, or apply straight away when the rule for this kind is off.
   * Returns the approval (pending) or { applied: true }.
   */
  async request(kind: ApprovalKind, o: { businessId?: string | null; title: string; context?: Record<string, unknown>; payload: Record<string, unknown>; costImpact?: number | null; marginImpact?: number | null; requestedBy?: string | null }) {
    const rules = await this.db.adminTx((tx) => setting<Record<string, any>>(tx, 'approval.rules', {}));
    const rule = rules[kind] ?? { on: true };
    const needed = rule.on !== false && (kind !== 'topup' || Number(o.payload.amountInr ?? 0) > Number(rule.aboveInr ?? 0));
    if (!needed) {
      await this.apply(kind, o.payload, o.requestedBy ?? null);
      return { applied: true };
    }
    const hours = Number(rules.timeoutHours ?? 48);
    const a = await this.db.adminTx((tx) =>
      tx.one(
        `INSERT INTO admin_approvals (kind, business_id, title, context, payload, cost_impact, margin_impact, requested_by, due_at, default_action)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(hours => $9), $10) RETURNING *`,
        [kind, o.businessId ?? null, o.title, JSON.stringify(o.context ?? {}), JSON.stringify(o.payload), o.costImpact ?? null, o.marginImpact ?? null, o.requestedBy ?? null, hours, rule.default ?? DEFAULT_RULE_ACTION[kind]],
      ),
    );
    await this.notifyAdmins('approval', `Approval needed: ${o.title}`, null, `/admin?tab=approvals`, { approvalId: a.id });
    return a;
  }

  async decide(id: string, adminId: string, decision: 'approve' | 'reject', edited?: Record<string, unknown>, note?: string) {
    const a = await this.db.adminTx((tx) => tx.one(`SELECT * FROM admin_approvals WHERE id = $1 FOR UPDATE`, [id]));
    if (!a) throw notFound();
    if (a.status !== 'pending') throw badRequest('already_decided', 'This was already decided.');
    const payload = edited ? { ...a.payload, ...edited } : a.payload;
    if (decision === 'approve') await this.apply(a.kind, payload, adminId);
    else await this.reject(a.kind, payload);
    const after = await this.db.adminTx(async (tx) => {
      const r = await tx.one(
        `UPDATE admin_approvals SET status = $2, decided_by = $3, decided_at = now(), payload = $4, decision_note = $5, applied_at = CASE WHEN $2 = 'approved' THEN now() END WHERE id = $1 RETURNING *`,
        [id, decision === 'approve' ? 'approved' : 'rejected', adminId, JSON.stringify(payload), note ?? (edited ? 'edited and approved' : null)],
      );
      await this.audit.write({ businessId: a.business_id, actorId: adminId, actorKind: 'admin', action: `admin.approval.${decision}`, entity: 'admin_approval', entityId: id, before: { payload: a.payload }, after: { payload, status: r.status } }, tx);
      return r;
    });
    return after;
  }

  /** Items not answered in time follow their safe default. */
  async expireApprovals(now = new Date()) {
    const due = await this.db.adminTx((tx) => tx.q(`SELECT * FROM admin_approvals WHERE status = 'pending' AND due_at < $1`, [now.toISOString()]));
    for (const a of due) {
      if (a.default_action === 'approve') await this.apply(a.kind, a.payload, null);
      else await this.reject(a.kind, a.payload);
      await this.db.adminTx((tx) => tx.q(`UPDATE admin_approvals SET status = 'expired', decided_at = now(), decision_note = $2, applied_at = CASE WHEN $3 THEN now() END WHERE id = $1`, [a.id, `No answer in time: ${a.default_action}`, a.default_action === 'approve']));
    }
    return due.length;
  }

  private async apply(kind: ApprovalKind, p: any, actorId: string | null) {
    switch (kind) {
      case 'custom_limits':
        await this.db.adminTx((tx) => tx.q(`UPDATE businesses SET limit_overrides = $2 WHERE id = $1`, [p.businessId, JSON.stringify(p.limits ?? {})]));
        this.ai.invalidate(p.businessId);
        return;
      case 'topup':
      case 'credit':
        await this.db.withTenant(p.businessId, async (tx) => {
          await tx.q(`UPDATE businesses SET ai_wallet_balance = ai_wallet_balance + $1 WHERE id = app_current_business()`, [Number(p.amountInr)]);
          await tx.q(`INSERT INTO wallet_transactions (amount, kind, note, created_by) VALUES ($1, $2, $3, $4)`, [Number(p.amountInr), kind, p.note ?? null, actorId]);
        });
        return this.jobs.enqueue('usage.resume', { businessId: p.businessId }, { jobId: `resume-credit:${p.businessId}:${Date.now()}` }).catch(() => undefined);
      case 'refund':
        return this.refund(p, actorId);
      case 'enterprise_deal':
        await this.db.withTenant(p.businessId, async (tx) => {
          const before = await tx.one(`SELECT b.plan_id, p.code FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.id = app_current_business()`);
          const after = await tx.one(
            `UPDATE businesses SET plan_id = (SELECT id FROM plans WHERE code = $1), price_lock = $2 WHERE id = app_current_business() RETURNING plan_id`,
            [p.planCode ?? 'enterprise', JSON.stringify({ plan: p.planCode ?? 'enterprise', INR: Number(p.priceInr ?? 0), until: p.until ?? null, deal: true })],
          );
          await syncCrewToPlan(tx, p.businessId, before.plan_id, after.plan_id);
          await this.planEvent(tx, { kind: 'upgrade', from: before.code, to: p.planCode ?? 'enterprise', amount: Number(p.priceInr ?? 0), source: 'admin', actorId });
        });
        this.ai.invalidate(p.businessId);
        return;
      case 'ai_cost':
        await this.db.adminTx((tx) => tx.q(`UPDATE businesses SET ai_paused = false, ai_paused_reason = $2 WHERE id = $1`, [p.businessId, `ai_cost_approved:${p.date}`]));
        return this.jobs.enqueue('usage.resume', { businessId: p.businessId }, { jobId: `resume-cost:${p.businessId}:${Date.now()}` }).catch(() => undefined);
      case 'budget_increase':
        await this.recordBudget(p.provider, p.month, Number(p.amountInr), Number(p.recommendedInr ?? p.amountInr), actorId);
        return;
    }
  }

  private async reject(kind: ApprovalKind, _p: any) {
    // Rejections leave things as they were (AI stays paused for the day; no credit, no refund, no change).
    if (kind === 'ai_cost') return;
  }

  /** Refund through Razorpay when Orbit's keys are set; always recorded. */
  private async refund(p: any, actorId: string | null) {
    const keyId = process.env.ORBIT_RAZORPAY_KEY_ID;
    const secret = process.env.ORBIT_RAZORPAY_KEY_SECRET;
    let providerRef: string | null = null;
    if (keyId && secret && p.paymentId) {
      const res = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(p.paymentId)}/refund`, {
        method: 'POST',
        headers: { authorization: `Basic ${Buffer.from(`${keyId}:${secret}`).toString('base64')}`, 'content-type': 'application/json' },
        body: JSON.stringify({ amount: Math.round(Number(p.amountInr) * 100), notes: { reason: p.note ?? 'Orbit refund' } }),
        signal: AbortSignal.timeout(15_000),
      });
      const d: any = await res.json().catch(() => ({}));
      if (!res.ok) throw badRequest('refund_failed', d?.error?.description ?? `Razorpay refused the refund (${res.status}).`);
      providerRef = d.id ?? null;
    }
    await this.db.withTenant(p.businessId, (tx) =>
      tx.q(`INSERT INTO wallet_transactions (amount, kind, note, created_by) VALUES ($1, 'refund', $2, $3)`, [-Math.abs(Number(p.amountInr)), `${p.note ?? 'Refund'}${providerRef ? ` (${providerRef})` : ' (record only: refund it in Razorpay)'}`, actorId]),
    );
  }

  // ------------------------------------------------------------ abnormal AI cost

  /** Every 15 minutes: a business whose AI cost today passes the threshold is paused (owner handover) until an admin decides. */
  async watchAiCost(now = new Date()) {
    const { rules, fx } = await this.db.adminTx(async (tx) => ({ rules: await setting<any>(tx, 'approval.rules', {}), fx: Number(await setting(tx, 'fx.usd_inr', 84)) || 84 }));
    const rule = rules.ai_cost ?? {};
    if (rule.on === false) return 0;
    const limit = Number(rule.dailyInr ?? 500);
    const day = now.toISOString().slice(0, 10);
    const rows = await this.db.adminTx((tx) =>
      tx.q(
        `SELECT b.id, b.name, (sum(a.cost) * $2)::float AS cost_inr
         FROM ai_usage a JOIN businesses b ON b.id = a.business_id
         WHERE a.created_at >= date_trunc('day', $1::timestamptz) AND NOT b.ai_paused
         GROUP BY b.id, b.name HAVING sum(a.cost) * $2 > $3`,
        [now.toISOString(), fx, limit],
      ),
    );
    let paused = 0;
    for (const r of rows) {
      const approvedToday = await this.db.adminTx((tx) => tx.one(`SELECT 1 FROM businesses WHERE id = $1 AND ai_paused_reason = $2`, [r.id, `ai_cost_approved:${day}`]));
      if (approvedToday) continue;
      await this.db.adminTx((tx) => tx.q(`UPDATE businesses SET ai_paused = true, ai_paused_reason = $2 WHERE id = $1`, [r.id, `ai_cost:${day}`]));
      this.ai.invalidate(r.id);
      await this.request('ai_cost', {
        businessId: r.id, title: `${r.name}: AI cost today ${inr(r.cost_inr)} (limit ${inr(limit)})`,
        context: { costInr: r.cost_inr, limitInr: limit, date: day }, payload: { businessId: r.id, date: day }, costImpact: r.cost_inr,
      });
      await this.notifyAdmins('abnormal_usage', `${r.name}: AI paused at ${inr(r.cost_inr)} today`, 'Customers are being handed to the owner until you approve or the day ends.', '/admin?tab=approvals', { businessId: r.id });
      paused++;
    }
    return paused;
  }

  // ------------------------------------------------------------ provider budgets

  async spend(month = monthKey()) {
    return this.db.adminTx(async (tx) => {
      const fx = Number(await setting(tx, 'fx.usd_inr', 84)) || 84;
      const units = await setting<any>(tx, 'costs.units', {});
      const range = `created_at >= to_date($1, 'YYYY-MM') AND created_at < to_date($1, 'YYYY-MM') + interval '1 month'`;
      const ai = await tx.q(`SELECT provider, (sum(cost) * $2)::float AS inr FROM ai_usage WHERE ${range} AND provider IN ('groq', 'claude') GROUP BY provider`, [month, fx]);
      const minutes = await tx.one(
        `SELECT COALESCE(sum(duration_sec), 0)::float / 60 AS m FROM calls WHERE started_at >= to_date($1, 'YYYY-MM') AND started_at < to_date($1, 'YYYY-MM') + interval '1 month' AND COALESCE(call_sid, '') NOT LIKE 'sarvam:%'`,
        [month],
      );
      const out: Record<string, number> = { groq: 0, claude: 0, sarvam: 0 };
      for (const r of ai) out[r.provider] = Math.round(r.inr * 100) / 100;
      out.sarvam = Math.round(Number(minutes?.m ?? 0) * Number(units.sarvamPerMinuteInr ?? 1.5) * 100) / 100;
      return out;
    });
  }

  /** Spend, projection, last 3 months, recommended cap, approved budget and breakdowns, per provider. */
  async budgets(now = new Date()) {
    const month = monthKey(now);
    const prev = [1, 2, 3].map((i) => monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
    const cur = await this.spend(month);
    const history = await Promise.all(prev.map(async (m) => ({ month: m, spend: await this.spend(m) })));
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const elapsed = Math.max(1, (now.getTime() - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) / 86_400_000);
    return this.db.adminTx(async (tx) => {
      const units = await setting<any>(tx, 'costs.units', {});
      const fx = Number(await setting(tx, 'fx.usd_inr', 84)) || 84;
      const margin = Number(units.budgetMarginPct ?? 20);
      const approved = await tx.q(`SELECT * FROM provider_budgets WHERE month = $1`, [month]);
      const byPlan = await tx.q(
        `SELECT a.provider, p.code AS plan, (sum(a.cost) * $2)::float AS inr FROM ai_usage a JOIN businesses b ON b.id = a.business_id JOIN plans p ON p.id = b.plan_id
         WHERE a.created_at >= to_date($1, 'YYYY-MM') GROUP BY 1, 2 ORDER BY 3 DESC`,
        [month, fx],
      );
      const top = await tx.q(
        `SELECT a.provider, b.id, b.name, (sum(a.cost) * $2)::float AS inr FROM ai_usage a JOIN businesses b ON b.id = a.business_id
         WHERE a.created_at >= to_date($1, 'YYYY-MM') GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 30`,
        [month, fx],
      );
      return PROVIDERS.map((p) => {
        const spend = cur[p.key] ?? 0;
        const projected = Math.round((spend / elapsed) * daysInMonth * 100) / 100;
        const recommended = Math.ceil(Math.max(projected, Math.max(...history.map((h) => h.spend[p.key] ?? 0))) * (1 + margin / 100));
        const b = approved.find((x) => x.provider === p.key);
        const budget = b ? Number(b.amount_inr) : null;
        return {
          provider: p.key, name: p.name, billingUrl: p.billingUrl, month, spend, projected, recommended,
          history: history.map((h) => ({ month: h.month, spend: h.spend[p.key] ?? 0 })),
          budget, status: b?.status ?? null, usedPct: budget ? Math.round((spend / budget) * 100) : null,
          byPlan: byPlan.filter((r) => r.provider === p.key).map((r) => ({ plan: r.plan, inr: Math.round(r.inr * 100) / 100 })),
          topBusinesses: top.filter((r) => r.provider === p.key).slice(0, 10).map((r) => ({ id: r.id, name: r.name, inr: Math.round(r.inr * 100) / 100 })),
          // No provider offers an API to set a spend cap, so the approved budget is recorded and the admin sets it in the provider's billing page.
          canSetByApi: false,
        };
      });
    });
  }

  /** Approve a monthly budget: more than last month's needs approval (when that rule is on). */
  async approveBudget(provider: string, amountInr: number, adminId: string, now = new Date()) {
    if (!PROVIDERS.some((p) => p.key === provider)) throw badRequest('unknown_provider', 'Unknown provider.');
    const month = monthKey(now);
    const prevMonth = monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
    const prev = await this.db.adminTx((tx) => tx.one(`SELECT amount_inr::float AS a FROM provider_budgets WHERE provider = $1 AND month IN ($2, $3) ORDER BY month DESC LIMIT 1`, [provider, month, prevMonth]));
    const rec = (await this.budgets(now)).find((b) => b.provider === provider)!.recommended;
    if (prev && amountInr > prev.a) {
      return this.request('budget_increase', {
        title: `${PROVIDERS.find((p) => p.key === provider)!.name} budget ${inr(prev.a)} → ${inr(amountInr)} for ${month}`,
        context: { provider, month, previousInr: prev.a, recommendedInr: rec }, payload: { provider, month, amountInr, recommendedInr: rec }, costImpact: amountInr - prev.a, requestedBy: adminId,
      });
    }
    await this.recordBudget(provider, month, amountInr, rec, adminId);
    return { applied: true };
  }

  private async recordBudget(provider: string, month: string, amountInr: number, recommendedInr: number, adminId: string | null) {
    await this.db.adminTx((tx) =>
      tx.q(
        `INSERT INTO provider_budgets (provider, month, amount_inr, recommended_inr, approved_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (provider, month) DO UPDATE SET amount_inr = EXCLUDED.amount_inr, recommended_inr = EXCLUDED.recommended_inr, approved_by = EXCLUDED.approved_by, approved_at = now(), status = 'recorded', confirmed_at = NULL, alerts_sent = '{}'`,
        [provider, month, amountInr, recommendedInr, adminId],
      ),
    );
    const p = PROVIDERS.find((x) => x.key === provider);
    await this.notifyAdmins('budget', `Set the ${p?.name ?? provider} limit to ${inr(amountInr)} for ${month}`, `Open ${p?.billingUrl ?? 'the provider billing page'}, set the spend limit, then mark it done in Admin → Budgets.`, '/admin?tab=budgets');
  }

  async confirmBudget(provider: string, month: string, adminId: string) {
    const r = await this.db.adminTx((tx) => tx.one(`UPDATE provider_budgets SET status = 'confirmed', confirmed_at = now() WHERE provider = $1 AND month = $2 RETURNING *`, [provider, month]));
    if (!r) throw notFound();
    await this.audit.write({ actorId: adminId, actorKind: 'admin', action: 'admin.budget.confirmed', entity: 'provider_budget', after: { provider, month } });
    return r;
  }

  /** Alerts at 70, 90 and 100% of each approved budget (once each), and daily reminders until a budget is confirmed as set. */
  async checkBudgets(now = new Date()) {
    const month = monthKey(now);
    const spend = await this.spend(month);
    const rows = await this.db.adminTx((tx) => tx.q(`SELECT * FROM provider_budgets WHERE month = $1`, [month]));
    let sent = 0;
    for (const b of rows) {
      const used = Number(b.amount_inr) > 0 ? ((spend[b.provider] ?? 0) / Number(b.amount_inr)) * 100 : 0;
      const name = PROVIDERS.find((p) => p.key === b.provider)?.name ?? b.provider;
      for (const t of [70, 90, 100]) {
        if (used >= t && !(b.alerts_sent ?? []).includes(t)) {
          await this.db.adminTx((tx) => tx.q(`UPDATE provider_budgets SET alerts_sent = array_append(alerts_sent, $2) WHERE id = $1`, [b.id, t]));
          await this.notifyAdmins('budget', `${name} at ${t}% of its ${month} budget (${inr(spend[b.provider] ?? 0)} of ${inr(Number(b.amount_inr))})`, null, '/admin?tab=budgets', { provider: b.provider, threshold: t });
          sent++;
        }
      }
      if (b.status === 'recorded' && (!b.last_reminded_at || now.getTime() - new Date(b.last_reminded_at).getTime() > 24 * 3600_000)) {
        await this.db.adminTx((tx) => tx.q(`UPDATE provider_budgets SET last_reminded_at = now() WHERE id = $1`, [b.id]));
        if (b.last_reminded_at) {
          await this.notifyAdmins('budget', `Reminder: set the ${name} limit to ${inr(Number(b.amount_inr))}`, 'Mark it done in Admin → Budgets once it is set in the provider billing page.', '/admin?tab=budgets');
          sent++;
        }
      }
    }
    return sent;
  }
}
