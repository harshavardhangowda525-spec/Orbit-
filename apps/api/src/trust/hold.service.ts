import { Injectable, OnModuleInit } from '@nestjs/common';
import { respectQuietHours, translate, type Sentence } from '@orbit/shared';
import { DbService, type Tx } from '../db/db.service';
import { JobsService } from '../jobs/jobs.service';
import { ChannelsService } from '../channels/channels.service';
import { postFeed } from '../common/feed';
import { liveToBusiness } from '../realtime/live';
import { badRequest, notFound } from '../common/errors';
import { logger } from '../logger';
import { fact, firstName, recordTrace, type TraceInput } from './trace';

export const HOLD_TYPES = ['message', 'booking_change', 'bulk_message', 'calls'] as const;
export type HoldType = (typeof HOLD_TYPES)[number];
export const HOLD_DEFAULTS: Record<HoldType, number> = { message: 30, booking_change: 30, bulk_message: 120, calls: 120 };
export const HOLD_MAX = 300;

/** Payloads the executor knows how to run. */
export type HoldPayload =
  | { kind: 'message'; customerId: string; text: string }
  | { kind: 'bulk_message'; customerIds: string[]; text: string; correctionOf?: string };

/**
 * The Undo window. Anything the Crew sends to customers on the owner's behalf
 * waits here first (30 s for one message, 2 min for a group by default). Undo
 * cancels it and nothing is sent. When the hold ends a job runs it; the job is
 * idempotent (it claims the row) and re-checks opt-outs, quiet hours and contact
 * caps at that moment. A sweep catches anything a lost job missed, so the action
 * still goes out on time if the app is closed.
 */
@Injectable()
export class HoldService implements OnModuleInit {
  constructor(private readonly db: DbService, private readonly jobs: JobsService, private readonly channels: ChannelsService) {}

  onModuleInit() {
    this.jobs.register('hold.execute', (d) => this.execute(d.businessId, d.id));
    this.jobs.register('hold.sweep', () => this.sweep());
  }

  /** The owner's hold time for this kind of action, within the plan's limit. */
  async seconds(tx: Tx, type: HoldType): Promise<number> {
    const r = await tx.one(
      `SELECT p.hold_seconds, (pl.limits->>'maxHoldSeconds')::int AS max FROM business_profiles p JOIN businesses b ON b.id = p.business_id LEFT JOIN plans pl ON pl.id = b.plan_id WHERE p.business_id = app_current_business()`,
    );
    const v = Number(r?.hold_seconds?.[type] ?? HOLD_DEFAULTS[type]);
    return Math.max(0, Math.min(Number.isFinite(v) ? v : HOLD_DEFAULTS[type], r?.max ?? HOLD_MAX));
  }

  async hold(tx: Tx, h: { agent: string; type: HoldType; summary: Sentence; payload: HoldPayload; audience: number; taskId?: string | null; createdBy?: string | null; trace: TraceInput }) {
    const traceId = await recordTrace(tx, { ...h.trace, taskId: h.taskId ?? null });
    const secs = await this.seconds(tx, h.type);
    const row = await tx.one(
      `INSERT INTO held_actions (task_id, agent_key, action_type, summary, payload, audience, hold_until, trace_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7), $8, $9) RETURNING id, hold_until`,
      [h.taskId ?? null, h.agent, h.type, JSON.stringify(h.summary), JSON.stringify(h.payload), h.audience, secs, traceId, h.createdBy ?? null],
    );
    this.schedule(tx, row.id, new Date(row.hold_until));
    liveToBusiness(tx, { type: 'held.changed', data: { id: row.id } });
    return { id: row.id as string, holdUntil: new Date(row.hold_until), seconds: secs, traceId };
  }

  private schedule(tx: Tx, id: string, at: Date) {
    const businessId = tx.businessId!;
    tx.afterCommit(() => {
      this.jobs.enqueue('hold.execute', { businessId, id }, { delayMs: at.getTime() - Date.now(), jobId: `hold:${id}:${at.getTime()}` }).catch((e) => logger.error(e.message, undefined, 'Hold'));
    });
  }

  /** Undo: cancel before it runs. Nothing is sent. */
  async undo(businessId: string, userId: string | null, id: string, via: 'app' | 'whatsapp' = 'app') {
    return this.db.withTenant(businessId, async (tx) => {
      const h = await tx.one(
        `UPDATE held_actions SET status = 'cancelled', cancelled_by = $2, cancelled_via = $3, cancelled_at = now() WHERE id = $1 AND status = 'holding' RETURNING *`,
        [id, userId, via],
      );
      if (!h) {
        const cur = await tx.one(`SELECT status FROM held_actions WHERE id = $1`, [id]);
        if (!cur) throw notFound();
        if (cur.status === 'cancelled') return { ok: true, status: 'cancelled' };
        throw badRequest('already_sent', 'This has already gone out. You can send a correction instead.');
      }
      if (h.task_id) await tx.q(`UPDATE tasks SET status = 'cancelled', result = '{"reason":"owner_undo"}', finished_at = now() WHERE id = $1`, [h.task_id]);
      await postFeed(tx, h.agent_key, 'held_cancelled', { key: 'feed.orbit.undone' }, { entityType: 'held_action', entityId: h.id });
      liveToBusiness(tx, { type: 'held.changed', data: { id } });
      return { ok: true, status: 'cancelled' };
    }, userId ?? undefined);
  }

  /** Job: run one held action when its hold ends. Safe to run twice. */
  async execute(businessId: string, id: string, now = new Date()) {
    return this.db.withTenant(businessId, async (tx) => {
      const h = await tx.one(`UPDATE held_actions SET status = 'executing' WHERE id = $1 AND status = 'holding' AND hold_until <= $2::timestamptz + interval '2 seconds' RETURNING *`, [id, now]);
      if (!h) return { status: 'skipped' };
      // Quiet hours are checked when it actually sends (the owner may have asked late at night).
      const p = await tx.one(`SELECT p.quiet_hours, p.contact_cap_per_week, b.timezone FROM business_profiles p JOIN businesses b ON b.id = p.business_id WHERE p.business_id = app_current_business()`);
      const allowed = respectQuietHours(now, p.quiet_hours, p.timezone);
      if (allowed && allowed.getTime() > now.getTime() + 60_000) {
        await tx.q(`UPDATE held_actions SET status = 'holding', hold_until = $2 WHERE id = $1`, [id, allowed]);
        this.schedule(tx, id, allowed);
        liveToBusiness(tx, { type: 'held.changed', data: { id } });
        return { status: 'deferred', until: allowed };
      }
      try {
        const payload = h.payload as HoldPayload;
        const result = payload.kind === 'message' ? await this.sendOne(tx, h, payload, now) : await this.sendMany(tx, h, payload, p.contact_cap_per_week, now);
        await tx.q(`UPDATE held_actions SET status = 'executed', executed_at = now(), result = $2 WHERE id = $1`, [id, JSON.stringify(result)]);
        if (h.task_id) await tx.q(`UPDATE tasks SET status = 'done', result = $2, finished_at = now() WHERE id = $1`, [h.task_id, JSON.stringify(result)]);
        liveToBusiness(tx, { type: 'held.changed', data: { id } });
        return { status: 'executed', ...result };
      } catch (e) {
        logger.error(`held action ${id} failed: ${(e as Error).message}`, (e as Error).stack, 'Hold');
        await tx.q(`UPDATE held_actions SET status = 'failed', error = $2 WHERE id = $1`, [id, (e as Error).message.slice(0, 500)]);
        liveToBusiness(tx, { type: 'held.changed', data: { id } });
        return { status: 'failed' };
      }
    });
  }

  private async customer(tx: Tx, id: string) {
    return tx.one(`SELECT id, name, phone, email, consent, opted_out_at, language FROM customers WHERE id = $1 AND deleted_at IS NULL`, [id]);
  }

  private async sendOne(tx: Tx, h: any, p: Extract<HoldPayload, { kind: 'message' }>, now: Date) {
    const c = await this.customer(tx, p.customerId);
    if (!c) return { sent: 0, sentTo: [], skipped: { gone: 1 } };
    const r = await this.channels.deliver(tx, 'whatsapp', { customer: c, body: personalise(p.text, c), agent: h.agent_key });
    if (!r.delivered) return { sent: 0, sentTo: [], skipped: { [r.reason ?? 'no_channel_connected']: 1 } };
    await tx.q(`INSERT INTO contact_log (customer_id, channel, agent_key, at) VALUES ($1, $2, $3, $4)`, [c.id, r.channel, h.agent_key, now]);
    await postFeed(tx, h.agent_key, 'message_sent', { key: 'feed.orbit.message_sent', params: { customer: firstName(c) } }, { entityType: 'customer', entityId: c.id, channel: r.channel ?? undefined, trace: h.trace_id });
    return { sent: 1, sentTo: [c.id], skipped: {}, channel: r.channel };
  }

  private async sendMany(tx: Tx, h: any, p: Extract<HoldPayload, { kind: 'bulk_message' }>, cap: number, now: Date) {
    const sentTo: string[] = [];
    const skipped: Record<string, number> = {};
    const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
    let channel: string | null = null;
    for (const id of [...new Set(p.customerIds)]) {
      const c = await this.customer(tx, id);
      if (!c) { skip('gone'); continue; }
      // A correction goes to everyone who got the first message, even past the weekly cap.
      if (!p.correctionOf) {
        const n = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM contact_log WHERE customer_id = $1 AND at > $2::timestamptz - interval '7 days'`, [c.id, now]);
        if ((n?.n ?? 0) >= cap) { skip('contact_cap'); continue; }
      }
      const r = await this.channels.deliver(tx, 'whatsapp', { customer: c, body: personalise(p.text, c), agent: h.agent_key });
      if (!r.delivered) { skip(r.reason ?? 'no_channel_connected'); continue; }
      channel ??= r.channel;
      await tx.q(`INSERT INTO contact_log (customer_id, channel, agent_key, at) VALUES ($1, $2, $3, $4)`, [c.id, r.channel, h.agent_key, now]);
      sentTo.push(c.id);
    }
    await postFeed(tx, h.agent_key, p.correctionOf ? 'correction_sent' : 'bulk_sent', { key: p.correctionOf ? 'feed.orbit.correction_sent' : 'feed.orbit.bulk_sent', params: { count: sentTo.length } }, {
      entityType: 'held_action', entityId: h.id, channel: channel ?? undefined, trace: h.trace_id,
    });
    return { sent: sentTo.length, sentTo, skipped, channel };
  }

  /** Safety net: anything whose hold ended but did not run (lost job, restart) runs now. */
  async sweep() {
    const due = await this.db.adminTx((tx) => tx.q(`SELECT business_id, id FROM held_actions WHERE status = 'holding' AND hold_until < now() - interval '20 seconds' LIMIT 200`));
    for (const d of due) await this.execute(d.business_id, d.id).catch((e) => logger.error(`hold sweep: ${e.message}`, e.stack, 'Hold'));
    // Something stuck mid-send (process died) is marked failed rather than sent twice.
    await this.db.adminTx((tx) => tx.q(`UPDATE held_actions SET status = 'failed', error = 'interrupted' WHERE status = 'executing' AND hold_until < now() - interval '15 minutes'`));
    return due.length;
  }

  /**
   * After a message went out it cannot be unsent. "Send a correction" drafts a
   * polite follow-up to the same people and puts it in Needs You for approval.
   */
  async correction(businessId: string, userId: string, id: string) {
    return this.db.withTenant(businessId, async (tx) => {
      const h = await tx.one(`SELECT * FROM held_actions WHERE id = $1 FOR UPDATE`, [id]);
      if (!h) throw notFound();
      if (h.status !== 'executed' || !(h.result?.sentTo ?? []).length) throw badRequest('nothing_sent', 'Nothing was sent, so there is nothing to correct.');
      if (h.correction_card_id) return { ok: true, cardId: h.correction_card_id };
      const b = await tx.one(`SELECT name, default_language FROM businesses WHERE id = app_current_business()`);
      const draft = translate(b.default_language ?? 'en', 'correction.draft', { business: b.name });
      const count = h.result.sentTo.length;
      const traceId = await recordTrace(tx, {
        agent: 'orbit', action: { key: 'why.action.orbit.correction' }, trigger: { kind: 'owner_decision' }, approver: { kind: 'owner' },
        facts: [fact('sent', 'why.fact.sent_to', { count, date: `~d:${new Date(h.executed_at).toISOString()}`, time: `~t:${new Date(h.executed_at).toISOString()}` })],
      });
      const card = await tx.one(
        `INSERT INTO approval_cards (agent_key, type, title, context, suggested_action, options, default_option, expires_at, trace_id)
         VALUES ('orbit', 'correction', $1, $2, $3, $4, 'no', now() + interval '24 hours', $5) RETURNING id`,
        [
          JSON.stringify({ key: 'card.correction', params: { count } }),
          JSON.stringify({ heldId: id, customerIds: h.result.sentTo, original: (h.payload as HoldPayload).text, draft }),
          JSON.stringify({ text: draft }),
          JSON.stringify([
            { key: 'send', label: 'card.option.send_correction', style: 'primary', outcome: 'approved' },
            { key: 'no', label: 'card.option.dont_send', style: 'secondary', outcome: 'rejected' },
          ]),
          traceId,
        ],
      );
      await tx.q(`UPDATE held_actions SET correction_card_id = $2 WHERE id = $1`, [id, card.id]);
      liveToBusiness(tx, { type: 'card.new' });
      return { ok: true, cardId: card.id };
    }, userId);
  }

  /** The owner approved the correction card: it goes through the same hold, so it can be undone too. */
  async sendCorrection(tx: Tx, card: any, userId: string) {
    const ids: string[] = card.context?.customerIds ?? [];
    if (!ids.length) return null;
    return this.hold(tx, {
      agent: 'orbit', type: ids.length > 1 ? 'bulk_message' : 'message', audience: ids.length, createdBy: userId,
      summary: { key: 'held.correction', params: { count: ids.length } },
      payload: ids.length > 1 ? { kind: 'bulk_message', customerIds: ids, text: card.context.draft, correctionOf: card.context.heldId } : { kind: 'message', customerId: ids[0], text: card.context.draft },
      trace: { agent: 'orbit', action: { key: 'why.action.orbit.correction' }, trigger: { kind: 'owner_decision' }, approver: { kind: 'owner' }, facts: [fact('approved', 'why.fact.you_approved_correction')] },
    });
  }

  /** What the undo bar shows: holding now, plus what finished in the last two minutes. */
  async list(tx: Tx) {
    return tx.q(
      `SELECT id, agent_key AS agent, action_type AS type, summary, audience, hold_until AS "holdUntil", created_at AS "createdAt", status,
         executed_at AS "executedAt", cancelled_at AS "cancelledAt", trace_id AS "traceId", correction_card_id AS "correctionCardId",
         COALESCE((result->>'sent')::int, 0) AS sent, payload->>'text' AS text
       FROM held_actions
       WHERE status IN ('holding', 'executing') OR GREATEST(executed_at, cancelled_at, created_at) > now() - interval '2 minutes'
       ORDER BY created_at DESC LIMIT 10`,
    );
  }
}

/** "{{name}}" in an owner's message becomes each customer's first name. */
function personalise(text: string, c: { name?: string | null }) {
  return text.replace(/\{\{\s*name\s*\}\}/gi, (c.name ?? '').split(' ')[0] || '').replace(/\s+([,.!?])/g, '$1');
}
