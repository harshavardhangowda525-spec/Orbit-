import { Injectable, OnModuleInit } from '@nestjs/common';
import { dailyAiCap, translate, type PlanLimits } from '@orbit/shared';
import { DbService, type Tx } from '../db/db.service';
import { JobsService } from '../jobs/jobs.service';
import { ConversationsService } from '../inbox/conversations.service';
import { liveToBusiness } from '../realtime/live';
import { logger } from '../logger';

/** Agents whose customer conversations count towards the AI allowance. */
const COUNTED = `agent_key IN ('aria', 'vox') AND conversation_id IS NOT NULL AND error IS NULL`;

export interface Allowance {
  allowed: boolean;
  /** Which limit stopped it (day = daily allowance/cap, month = monthly allowance). */
  scope?: 'day' | 'month';
  /** Allowed past a limit because the conversation was already under way. */
  graced?: boolean;
  /** Allowed past a limit on Pay As You Go credit. */
  wallet?: boolean;
}

interface Window {
  tz: string;
  dayStart: string;
  monthStart: string;
  dayKey: string;
  monthKey: string;
  nextDay: string;
  nextMonth: string;
}

/**
 * AI allowances. Free has a daily allowance of conversations (resetting at
 * midnight in the business's timezone); paid plans have a monthly allowance
 * plus a generous daily cap. A conversation counts once per period. When a
 * limit is reached, conversations already under way may continue for a few
 * more replies (grace); new ones get one polite acknowledgement and wait for
 * the team, the owner is told, and when the allowance comes back Orbit offers
 * to reply to everyone still waiting. Customers never see limits or plans.
 */
@Injectable()
export class UsageService implements OnModuleInit {
  constructor(
    private readonly db: DbService,
    private readonly jobs: JobsService,
    private readonly conversations: ConversationsService,
  ) {}

  onModuleInit() {
    this.jobs.register('usage.resume', (d) => (d?.businessId ? this.offerResume(d.businessId) : this.resumeSweep()));
  }

  private async plan(tx: Tx) {
    return tx.one<{ limits: PlanLimits; timezone: string; name: string; wallet: string }>(
      `SELECT p.limits, b.timezone, b.name, b.ai_wallet_balance AS wallet FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.id = app_current_business()`,
    );
  }

  private async window(tx: Tx, tz: string, now: Date): Promise<Window> {
    return (await tx.one(
      `WITH l AS (SELECT ($1::timestamptz AT TIME ZONE $2) AS t)
       SELECT (date_trunc('day', l.t) AT TIME ZONE $2) AS "dayStart", (date_trunc('month', l.t) AT TIME ZONE $2) AS "monthStart",
              to_char(l.t, 'YYYY-MM-DD') AS "dayKey", to_char(l.t, 'YYYY-MM') AS "monthKey",
              ((date_trunc('day', l.t) + interval '1 day') AT TIME ZONE $2) AS "nextDay", ((date_trunc('month', l.t) + interval '1 month') AT TIME ZONE $2) AS "nextMonth"
       FROM l`,
      [now.toISOString(), tz],
    )) as Window;
  }

  private async counts(tx: Tx, w: Window, conversationId: string | null) {
    return tx.one<{ day: number; month: number; in_day: boolean; in_month: boolean }>(
      `SELECT (SELECT count(DISTINCT conversation_id)::int FROM ai_usage WHERE ${COUNTED} AND created_at >= $1) AS day,
              (SELECT count(DISTINCT conversation_id)::int FROM ai_usage WHERE ${COUNTED} AND created_at >= $2) AS month,
              EXISTS (SELECT 1 FROM ai_usage WHERE ${COUNTED} AND conversation_id = $3 AND created_at >= $1) AS in_day,
              EXISTS (SELECT 1 FROM ai_usage WHERE ${COUNTED} AND conversation_id = $3 AND created_at >= $2) AS in_month`,
      [w.dayStart, w.monthStart, conversationId],
    ) as any;
  }

  private async event(tx: Tx, scope: 'day' | 'month', period: string, cap: number) {
    return tx.one(
      `INSERT INTO usage_limit_events (scope, period, cap) VALUES ($1, $2, $3)
       ON CONFLICT (business_id, scope, period) DO UPDATE SET cap = CASE WHEN EXCLUDED.cap > 0 THEN EXCLUDED.cap ELSE usage_limit_events.cap END RETURNING *`,
      [scope, period, cap],
    );
  }

  /**
   * May Aria/Vox answer this conversation now? Call before the AI runs. Records
   * the 80% heads-up and the moment a limit is reached; does not count usage
   * (the AI call itself does, in ai_usage).
   */
  async check(tx: Tx, conversationId: string, now = new Date()): Promise<Allowance> {
    const p = await this.plan(tx);
    if (!p) return { allowed: true };
    const w = await this.window(tx, p.timezone, now);
    const c = await this.counts(tx, w, conversationId);
    const dayCap = dailyAiCap(p.limits);
    const monthCap = p.limits.aiConversationsPerMonth ?? null;
    const scopes: { scope: 'day' | 'month'; cap: number; used: number; counted: boolean; period: string }[] = [];
    if (dayCap != null) scopes.push({ scope: 'day', cap: dayCap, used: c.day, counted: c.in_day, period: w.dayKey });
    if (monthCap != null) scopes.push({ scope: 'month', cap: monthCap, used: c.month, counted: c.in_month, period: w.monthKey });

    let graced = false;
    for (const s of scopes) {
      if (s.counted) {
        // Already being answered in this period: fine until the limit is reached, then a few more replies.
        if (s.used < s.cap) continue;
        const ev = await this.event(tx, s.scope, s.period, s.cap);
        const since = ev.hit_at ?? now;
        if (!ev.hit_at) await tx.q(`UPDATE usage_limit_events SET hit_at = $2 WHERE id = $1`, [ev.id, since]);
        // Grace counts replies the customer received, not internal AI steps.
        const after = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND direction = 'out' AND sender IN ('aria', 'vox') AND created_at >= $2`, [conversationId, since]);
        if ((after?.n ?? 0) < (p.limits.graceMessages ?? 10)) {
          graced = true;
          continue;
        }
        return this.overage(tx, p, s, conversationId, w);
      }
      if (s.used >= s.cap) return this.overage(tx, p, s, conversationId, w);
    }
    // A new conversation within the allowance: heads-up at 80%; mark the moment the allowance is used up.
    for (const s of scopes) {
      if (s.counted) continue;
      const after = s.used + 1;
      if (after >= Math.ceil(s.cap * 0.8)) {
        const ev = await this.event(tx, s.scope, s.period, s.cap);
        if (!ev.warned_at && after < s.cap) {
          await tx.q(`UPDATE usage_limit_events SET warned_at = now() WHERE id = $1`, [ev.id]);
          await this.notify(tx, s.scope === 'day' ? 'notify.ai_80_day' : 'notify.ai_80_month', { used: after, cap: s.cap }, '/bridge?view=plan', 'ai_limit_warning');
        }
        if (after >= s.cap && !ev.hit_at) await tx.q(`UPDATE usage_limit_events SET hit_at = now() WHERE id = $1`, [ev.id]);
      }
    }
    return { allowed: true, graced };
  }

  /** Past the limit: Pay As You Go credit if the plan allows and there is enough; otherwise pause. */
  private async overage(tx: Tx, p: NonNullable<Awaited<ReturnType<UsageService['plan']>>>, s: { scope: 'day' | 'month'; cap: number; period: string }, conversationId: string, w: Window): Promise<Allowance> {
    const ev = await this.event(tx, s.scope, s.period, s.cap);
    if (!ev.hit_at) await tx.q(`UPDATE usage_limit_events SET hit_at = now() WHERE id = $1`, [ev.id]);
    // The daily cap on paid plans stops runaway use; only the monthly allowance can be extended with credit.
    if (s.scope === 'month' && (p.limits.overage === 'wallet' || p.limits.overage === 'charge')) {
      const paid = await tx.one(`SELECT 1 FROM wallet_transactions WHERE conversation_id = $1 AND kind = 'usage' AND created_at >= $2`, [conversationId, w.monthStart]);
      if (paid) return { allowed: true, wallet: true };
      const price = Number(p.limits.overagePrices?.aiConversation?.INR ?? 0);
      if (price > 0) {
        const took = await tx.one(`UPDATE businesses SET ai_wallet_balance = ai_wallet_balance - $1 WHERE id = app_current_business() AND ai_wallet_balance >= $1 RETURNING ai_wallet_balance`, [price]);
        if (took) {
          await tx.q(`INSERT INTO wallet_transactions (amount, kind, unit, conversation_id, note) VALUES ($1, 'usage', 'aiConversation', $2, 'Conversation past the monthly allowance')`, [-price, conversationId]);
          return { allowed: true, wallet: true };
        }
      }
    }
    return { allowed: false, scope: s.scope };
  }

  /**
   * Orbit is paused: the customer gets one polite, business-branded note (never
   * about limits), the conversation waits for the team, one Needs You card lists
   * everyone waiting, and the owner is told once per period.
   */
  async park(tx: Tx, conversationId: string, scope: 'day' | 'month', language: string, now = new Date()) {
    const p = await this.plan(tx);
    const conv = await tx.one(`SELECT id, channel, limit_ack_at, customer_id FROM conversations WHERE id = $1`, [conversationId]);
    if (!p || !conv) return;
    if (!conv.limit_ack_at && conv.channel !== 'phone') {
      const lang = ['en', 'hi', 'kn'].includes(language) ? language : 'en';
      await this.conversations.addMessage(tx, conversationId, { direction: 'out', sender: 'aria', body: translate(lang as any, 'aria.auto.limit_ack', { business: p.name }), language: lang });
    }
    await tx.q(
      `UPDATE conversations SET limit_ack_at = COALESCE(limit_ack_at, now()), parked_for_limit_at = COALESCE(parked_for_limit_at, now()),
         handled_by = CASE WHEN handled_by = 'aria' THEN 'human' ELSE handled_by END, status = 'waiting_staff' WHERE id = $1`,
      [conversationId],
    );
    const waiting = await tx.q(`SELECT id FROM conversations WHERE parked_for_limit_at IS NOT NULL AND status = 'waiting_staff' ORDER BY parked_for_limit_at`);
    const ids = waiting.map((r) => r.id as string);
    const w = await this.window(tx, p.timezone, now);
    const card = await tx.one(`SELECT id FROM approval_cards WHERE type = 'limit_waiting' AND status = 'pending'`);
    const title = JSON.stringify({ key: scope === 'day' ? 'card.limit_waiting_day' : 'card.limit_waiting_month', params: { count: ids.length } });
    const context = JSON.stringify({ conversationIds: ids, scope, resetsAt: scope === 'day' ? w.nextDay : w.nextMonth });
    if (card) await tx.q(`UPDATE approval_cards SET title = $2, context = $3 WHERE id = $1`, [card.id, title, context]);
    else {
      await tx.q(
        `INSERT INTO approval_cards (agent_key, type, title, context, options, default_option, expires_at) VALUES ('orbit', 'limit_waiting', $1, $2, $3, 'inbox', $4)`,
        [title, context, JSON.stringify([
          { key: 'inbox', label: 'card.option.open_inbox', style: 'primary', outcome: 'edited' },
          { key: 'upgrade', label: 'card.option.upgrade', style: 'secondary', outcome: 'approved' },
        ]), scope === 'day' ? w.nextDay : w.nextMonth],
      );
    }
    // Tell the owner once per period, the moment the first customer has to wait.
    const ev = await this.event(tx, scope, scope === 'day' ? w.dayKey : w.monthKey, 0);
    const told = await tx.one(`SELECT 1 FROM notifications WHERE type = 'ai_limit' AND created_at >= $1`, [ev.hit_at ?? now]);
    if (!told) await this.notify(tx, scope === 'day' ? 'notify.ai_limit_day' : 'notify.ai_limit_month', { count: ids.length }, '/inbox', 'ai_limit');
    liveToBusiness(tx, { type: 'card.new' });
    liveToBusiness(tx, { type: 'conversation.updated', data: { id: conversationId } });
  }

  private async notify(tx: Tx, key: string, params: Record<string, unknown>, link: string, type: string) {
    await tx.q(`INSERT INTO notifications (user_id, type, title, link) VALUES (NULL, $1, $2, $3)`, [type, JSON.stringify({ key, params }), link]);
    liveToBusiness(tx, { type: 'notification.new' });
  }

  /** Is Orbit paused right now (for The Bridge)? */
  async paused(tx: Tx, now = new Date()): Promise<{ scope: 'day' | 'month'; waiting: number; resetsAt: string } | null> {
    const p = await this.plan(tx);
    if (!p) return null;
    const w = await this.window(tx, p.timezone, now);
    const c = await this.counts(tx, w, null);
    const dayCap = dailyAiCap(p.limits);
    const monthCap = p.limits.aiConversationsPerMonth;
    const walletOk = (p.limits.overage === 'wallet' || p.limits.overage === 'charge') && Number(p.wallet) >= Number(p.limits.overagePrices?.aiConversation?.INR ?? Infinity);
    const scope: 'day' | 'month' | null = monthCap != null && c.month >= monthCap && !walletOk ? 'month' : dayCap != null && c.day >= dayCap ? 'day' : null;
    if (!scope) return null;
    const waiting = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM conversations WHERE parked_for_limit_at IS NOT NULL AND status = 'waiting_staff'`);
    return { scope, waiting: waiting?.n ?? 0, resetsAt: scope === 'day' ? w.nextDay : w.nextMonth };
  }

  /** Meters for Settings → Plan: conversations today and this month, with reset times. Never tokens or costs. */
  async meters(tx: Tx, now = new Date()) {
    const p = await this.plan(tx);
    if (!p) return null;
    const w = await this.window(tx, p.timezone, now);
    const c = await this.counts(tx, w, null);
    const asked = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM ai_usage WHERE agent_key = 'orbit' AND error IS NULL AND created_at >= $1`, [w.dayStart]);
    return {
      today: { used: c.day, cap: dailyAiCap(p.limits), resetsAt: w.nextDay },
      month: { used: c.month, cap: p.limits.aiConversationsPerMonth ?? null, resetsAt: w.nextMonth },
      assistantToday: { used: asked?.n ?? 0, cap: p.limits.assistantPerDay ?? null },
      wallet: Number(p.wallet),
      graceMessages: p.limits.graceMessages ?? 10,
    };
  }

  /** Owner questions to Orbit: a separate daily allowance (owners are told plainly when it runs out). */
  async assistantAllowed(tx: Tx, now = new Date()) {
    const p = await this.plan(tx);
    if (!p || p.limits.assistantPerDay == null) return { allowed: true, resetsAt: null as string | null };
    const w = await this.window(tx, p.timezone, now);
    const asked = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM ai_usage WHERE agent_key = 'orbit' AND error IS NULL AND created_at >= $1`, [w.dayStart]);
    return { allowed: (asked?.n ?? 0) < p.limits.assistantPerDay, resetsAt: w.nextDay };
  }

  // ------------------------------------------------------------ resuming

  /** Every few minutes: businesses with customers waiting since a limit get the offer once the allowance is back. */
  async resumeSweep() {
    const rows = await this.db.adminTx((tx) => tx.q(`SELECT DISTINCT business_id FROM conversations WHERE parked_for_limit_at IS NOT NULL AND status = 'waiting_staff' AND handled_by = 'human'`));
    for (const r of rows) await this.offerResume(r.business_id).catch((e) => logger.error(`resume offer failed: ${e.message}`, e.stack, 'Usage'));
    return rows.length;
  }

  /** When Orbit can answer again (reset or upgrade): "Want Orbit to reply to the N conversations still waiting?" */
  async offerResume(businessId: string, now = new Date()) {
    return this.db.withTenant(businessId, async (tx) => {
      if (await this.paused(tx, now)) return false;
      const waiting = await tx.q(`SELECT id FROM conversations WHERE parked_for_limit_at IS NOT NULL AND status = 'waiting_staff' AND handled_by = 'human' ORDER BY parked_for_limit_at`);
      await tx.q(`UPDATE approval_cards SET status = 'expired', decided_at = now() WHERE type = 'limit_waiting' AND status = 'pending'`);
      if (!waiting.length) return false;
      const ids = waiting.map((r) => r.id as string);
      const open = await tx.one(`SELECT id FROM approval_cards WHERE type = 'limit_resume' AND status = 'pending'`);
      const title = JSON.stringify({ key: 'card.limit_resume', params: { count: ids.length } });
      if (open) await tx.q(`UPDATE approval_cards SET title = $2, context = $3 WHERE id = $1`, [open.id, title, JSON.stringify({ conversationIds: ids })]);
      else {
        await tx.q(
          `INSERT INTO approval_cards (agent_key, type, title, context, options, default_option, expires_at) VALUES ('orbit', 'limit_resume', $1, $2, $3, 'myself', now() + interval '24 hours')`,
          [title, JSON.stringify({ conversationIds: ids }), JSON.stringify([
            { key: 'reply', label: 'card.option.reply_now', style: 'primary', outcome: 'approved' },
            { key: 'myself', label: 'card.option.handle_myself', style: 'secondary', outcome: 'rejected' },
          ])],
        );
        await this.notify(tx, 'notify.ai_resumed', { count: ids.length }, '/bridge', 'ai_resumed');
      }
      await tx.q(`UPDATE usage_limit_events SET resume_offered_at = now() WHERE resume_offered_at IS NULL AND hit_at IS NOT NULL`);
      liveToBusiness(tx, { type: 'card.new' });
      return true;
    });
  }

  /** The owner chose on the resume card: Orbit replies to the waiting chats, or the team keeps them. */
  async decideResume(tx: Tx, conversationIds: string[], replyNow: boolean) {
    const ids = (await tx.q(`SELECT id FROM conversations WHERE id = ANY($1::uuid[]) AND parked_for_limit_at IS NOT NULL AND handled_by = 'human'`, [conversationIds])).map((r) => r.id as string);
    if (replyNow) {
      await tx.q(`UPDATE conversations SET handled_by = 'aria', status = 'open', parked_for_limit_at = NULL, limit_ack_at = NULL WHERE id = ANY($1::uuid[])`, [ids]);
      const businessId = tx.businessId!;
      tx.afterCommit(() => {
        for (const id of ids) this.jobs.enqueue('channels.reply', { businessId, conversationId: id }, { jobId: `resume:${id}:${Date.now()}` }).catch(() => undefined);
      });
    } else {
      await tx.q(`UPDATE conversations SET parked_for_limit_at = NULL WHERE id = ANY($1::uuid[])`, [ids]);
    }
    return ids.length;
  }
}
