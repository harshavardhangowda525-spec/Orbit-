import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { formatTime, respectQuietHours, type SequenceStep } from '@orbit/shared';
import { translate } from '@orbit/shared';
import { DbService, Tx } from '../db/db.service';
import { config } from '../config';
import { JobsService } from '../jobs/jobs.service';
import { ChannelsService } from '../channels/channels.service';
import { postFeed } from '../common/feed';
import { logger } from '../logger';

const MIN = 60_000;

/**
 * Nudge — retention agent. Every reminder and follow-up is a row in
 * scheduled_messages plus a delayed job. When the job fires, Nudge re-checks
 * everything (booking still on, lead not booked, consent, opt-out, quiet hours,
 * contact cap) before sending, so late or duplicate jobs are harmless.
 */
@Injectable()
export class NudgeService implements OnModuleInit {
  constructor(private readonly db: DbService, private readonly jobs: JobsService, private readonly channels: ChannelsService) {}

  onModuleInit() {
    this.jobs.register('nudge.send', (d) => this.process(d.businessId, d.id));
    this.jobs.register('nudge.renewals', () => this.scheduleRenewalsAll());
  }

  private async biz(tx: Tx) {
    return tx.one(
      `SELECT b.id, b.name, b.slug, b.timezone, b.default_language, p.quiet_hours, p.contact_cap_per_week, p.address, p.review_url
       FROM businesses b JOIN business_profiles p ON p.business_id = b.id WHERE b.id = app_current_business()`,
    );
  }

  private enqueue(tx: Tx, id: string, sendAt: Date) {
    const businessId = tx.businessId!;
    tx.afterCommit(() => {
      this.jobs.enqueue('nudge.send', { businessId, id }, { delayMs: sendAt.getTime() - Date.now(), jobId: `nudge:${id}:${sendAt.getTime()}` }).catch((e) => logger.error(e.message, undefined, 'Nudge'));
    });
  }

  private async schedule(
    tx: Tx,
    row: { customerId: string; bookingId?: string; leadId?: string; sequenceId: string | null; stepIndex: number; step: SequenceStep; kind: string; transactional: boolean; sendAt: Date; latest?: Date; key: string; agent: string },
    now: Date,
  ) {
    const b = await this.biz(tx);
    const at = respectQuietHours(row.sendAt, b.quiet_hours, b.timezone, row.latest);
    if (!at || at.getTime() < now.getTime() + MIN) return null; // too late to be useful
    const r = await tx.one(
      `INSERT INTO scheduled_messages (customer_id, booking_id, lead_id, sequence_id, step_index, agent_key, kind, transactional, preferred_channel, template, send_at, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (business_id, idempotency_key) DO NOTHING RETURNING id`,
      [row.customerId, row.bookingId ?? null, row.leadId ?? null, row.sequenceId, row.stepIndex, row.agent, row.kind, row.transactional, row.step.channel, row.step.template, at, row.key],
    );
    if (r) this.enqueue(tx, r.id, at);
    return r?.id ?? null;
  }

  /** Booking created or moved: schedule its reminders (e.g. 24 h and 2 h before) in the business's local time. */
  async onBookingScheduled(tx: Tx, booking: { id: string; customer_id: string; start_at: Date }, now = new Date()) {
    await this.cancelForBooking(tx, booking.id, 'rescheduled');
    const seqs = await tx.q(`SELECT id, steps, owner_agent FROM sequences WHERE active AND trigger = 'booking_created'`);
    for (const s of seqs) {
      for (const [i, step] of (s.steps as SequenceStep[]).entries()) {
        const start = new Date(booking.start_at);
        await this.schedule(tx, {
          customerId: booking.customer_id, bookingId: booking.id, sequenceId: s.id, stepIndex: i, step, kind: 'reminder', transactional: true,
          sendAt: new Date(start.getTime() + step.delayMin * MIN), latest: start, key: `bk:${booking.id}:${s.id}:${i}:${start.toISOString()}`, agent: s.owner_agent,
        }, now);
      }
    }
  }

  async cancelForBooking(tx: Tx, bookingId: string, reason: string) {
    await tx.q(`UPDATE scheduled_messages SET status = 'cancelled', skip_reason = $2 WHERE booking_id = $1 AND status = 'scheduled'`, [bookingId, reason]);
  }

  /** Booking completed: thank-you / review request / trial follow-up sequences. */
  async onBookingCompleted(tx: Tx, booking: { id: string; customer_id: string; end_at: Date; service_category?: string | null }, now = new Date()) {
    const seqs = await tx.q(`SELECT id, steps, owner_agent FROM sequences WHERE active AND trigger = 'booking_completed'`);
    for (const s of seqs) {
      for (const [i, step] of (s.steps as SequenceStep[]).entries()) {
        const cond = step.condition?.match(/^service_category=(.+)$/);
        if (cond && cond[1] !== booking.service_category) continue;
        await this.schedule(tx, {
          customerId: booking.customer_id, bookingId: booking.id, sequenceId: s.id, stepIndex: i, step, kind: 'review_request', transactional: false,
          sendAt: new Date(new Date(booking.end_at).getTime() + step.delayMin * MIN), key: `done:${booking.id}:${s.id}:${i}`, agent: s.owner_agent,
        }, now);
      }
    }
  }

  /** New lead: follow-ups that stop as soon as the customer books, replies or opts out. */
  async onLeadCreated(tx: Tx, lead: { id: string; customer_id: string; created_at: Date }, now = new Date()) {
    const seqs = await tx.q(`SELECT id, steps, owner_agent FROM sequences WHERE active AND trigger = 'lead_created'`);
    for (const s of seqs) {
      for (const [i, step] of (s.steps as SequenceStep[]).entries()) {
        await this.schedule(tx, {
          customerId: lead.customer_id, leadId: lead.id, sequenceId: s.id, stepIndex: i, step, kind: 'follow_up', transactional: false,
          sendAt: new Date(new Date(lead.created_at).getTime() + step.delayMin * MIN), key: `lead:${lead.id}:${s.id}:${i}`, agent: s.owner_agent,
        }, now);
      }
    }
  }

  /**
   * Renewals: a customer whose last visit for a repeat service (haircut every 30
   * days, monthly membership...) is due again, and who has not booked it, gets one
   * friendly nudge per visit. Uses the business's own "renewal due" sequence when
   * it has one (e.g. fee reminders), otherwise a short default message.
   */
  async scheduleRenewals(businessId: string, now = new Date()) {
    return this.db.withTenant(businessId, async (tx) => {
      const due = await tx.q(
        `SELECT * FROM (
           SELECT DISTINCT ON (bk.customer_id, bk.service_id) bk.id, bk.customer_id, bk.service_id, bk.end_at, s.renewal_interval_days AS every
           FROM bookings bk JOIN services s ON s.id = bk.service_id
           WHERE s.renewal_interval_days IS NOT NULL AND s.active AND s.deleted_at IS NULL AND bk.status = 'completed' AND bk.deleted_at IS NULL AND bk.customer_id IS NOT NULL
           ORDER BY bk.customer_id, bk.service_id, bk.end_at DESC
         ) last
         WHERE last.end_at + make_interval(days => last.every) <= $1::timestamptz + interval '3 days'
           AND last.end_at + make_interval(days => last.every) > $1::timestamptz - interval '14 days'
           AND NOT EXISTS (SELECT 1 FROM bookings n WHERE n.customer_id = last.customer_id AND n.service_id = last.service_id AND n.start_at > last.end_at AND n.status IN ('pending', 'confirmed', 'completed') AND n.deleted_at IS NULL)`,
        [now],
      );
      if (!due.length) return 0;
      const seqs = await tx.q(`SELECT id, steps, owner_agent FROM sequences WHERE active AND trigger = 'renewal_due'`);
      const lang = (await this.biz(tx)).default_language ?? 'en';
      let n = 0;
      for (const d of due) {
        const dueAt = new Date(new Date(d.end_at).getTime() + d.every * 24 * 60 * MIN);
        const plans = seqs.length
          ? seqs.flatMap((s: any) => (s.steps as SequenceStep[]).map((step, i) => ({ seq: s.id, i, step, agent: s.owner_agent })))
          : [{ seq: null, i: 0, step: { channel: 'whatsapp', delayMin: 0, template: translate(lang, 'nudge.renewal', { name: '{{name}}', service: '{{service}}', business: '{{business}}', link: '{{link}}' }) } as SequenceStep, agent: 'nudge' }];
        for (const p of plans) {
          const sendAt = new Date(Math.max(now.getTime() + 2 * MIN, dueAt.getTime() + p.step.delayMin * MIN));
          const id = await this.schedule(tx, {
            customerId: d.customer_id, bookingId: d.id, sequenceId: p.seq, stepIndex: p.i, step: p.step, kind: 'renewal', transactional: false,
            sendAt, key: `renew:${d.id}:${p.seq ?? 'default'}:${p.i}`, agent: p.agent,
          }, now);
          if (id) n++;
        }
      }
      return n;
    });
  }

  async scheduleRenewalsAll(now = new Date()) {
    const ids = await this.db.adminTx((tx) => tx.q<{ business_id: string }>(`SELECT DISTINCT business_id FROM services WHERE renewal_interval_days IS NOT NULL AND active AND deleted_at IS NULL`));
    let n = 0;
    for (const { business_id } of ids) n += await this.scheduleRenewals(business_id, now).catch((e) => (logger.error(`renewals failed: ${e.message}`, e.stack, 'Nudge'), 0));
    return n;
  }

  /** Stop all non-transactional messages for a customer (they booked, replied or opted out). */
  async stopForCustomer(tx: Tx, customerId: string, reason: string) {
    await tx.q(
      `UPDATE scheduled_messages SET status = 'cancelled', skip_reason = $2 WHERE customer_id = $1 AND status = 'scheduled' AND NOT transactional`,
      [customerId, reason],
    );
  }

  /** Job handler: send one scheduled message if it is still appropriate. */
  async process(businessId: string, id: string, now = new Date()) {
    return this.db.withTenant(businessId, async (tx) => {
      const m = await tx.one(`SELECT * FROM scheduled_messages WHERE id = $1 FOR UPDATE`, [id]);
      if (!m || m.status !== 'scheduled') return { status: m?.status ?? 'missing' };
      if (new Date(m.send_at).getTime() > now.getTime() + MIN) return { status: 'not_due' };
      const done = async (status: string, reason: string | null, extra: Record<string, unknown> = {}) => {
        await tx.q(`UPDATE scheduled_messages SET status = $2, skip_reason = $3, attempts = attempts + 1, channel = $4, body = $5, sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END WHERE id = $1`, [
          id, status, reason, extra.channel ?? null, extra.body ?? null,
        ]);
        return { status, reason };
      };
      const b = await this.biz(tx);
      const c = await tx.one(`SELECT * FROM customers WHERE id = $1 AND deleted_at IS NULL`, [m.customer_id]);
      if (!c) return done('cancelled', 'customer_deleted');

      // The owner's Crew settings: an agent that is switched off sends nothing; some kinds can be turned off on their own.
      const agent = await tx.one(`SELECT enabled, auto_approval_rules AS rules FROM agents WHERE agent_key = $1`, [m.agent_key]);
      if (agent && !agent.enabled) return done('skipped', 'agent_off');
      const permission: Record<string, string> = { review_request: 'reviewRequests', renewal: 'renewals', follow_up: 'followUps' };
      if (permission[m.kind] && agent?.rules?.[permission[m.kind]] === false) return done('skipped', 'not_allowed');

      let booking: any = null;
      if (m.booking_id) {
        booking = await tx.one(`SELECT bk.*, s.name AS service, s.category FROM bookings bk LEFT JOIN services s ON s.id = bk.service_id WHERE bk.id = $1`, [m.booking_id]);
        if (m.kind === 'reminder' && (!booking || !['pending', 'confirmed'].includes(booking.status) || new Date(booking.start_at) <= now)) {
          return done('cancelled', 'booking_changed');
        }
      }
      if (m.kind === 'renewal' && booking) {
        const again = await tx.one(`SELECT 1 FROM bookings WHERE customer_id = $1 AND service_id = $2 AND start_at > $3 AND status IN ('pending', 'confirmed', 'completed') AND deleted_at IS NULL`, [c.id, booking.service_id, booking.end_at]);
        if (again) return done('cancelled', 'customer_booked');
      }
      if (m.kind === 'review_request') {
        const recent = await tx.one(`SELECT 1 FROM scheduled_messages WHERE customer_id = $1 AND kind = 'review_request' AND status = 'sent' AND sent_at > now() - interval '90 days'`, [c.id]);
        if (recent) return done('skipped', 'asked_recently');
      }
      let lead: any = null;
      if (m.kind === 'follow_up' && m.lead_id) {
        lead = await tx.one(`SELECT * FROM leads WHERE id = $1`, [m.lead_id]);
        if (!lead || ['booked', 'lost'].includes(lead.status)) return done('cancelled', 'lead_closed');
        const booked = await tx.one(`SELECT 1 FROM bookings WHERE customer_id = $1 AND created_at > $2 AND status <> 'cancelled'`, [c.id, lead.created_at]);
        if (booked) return done('cancelled', 'customer_booked');
        const replied = await tx.one(
          `SELECT 1 FROM messages ms JOIN conversations cv ON cv.id = ms.conversation_id
           WHERE cv.customer_id = $1 AND ms.direction = 'in' AND ms.created_at > $2 AND ms.created_at > COALESCE((SELECT max(sent_at) FROM scheduled_messages WHERE lead_id = $3 AND status = 'sent'), $2)`,
          [c.id, lead.created_at, lead.id],
        );
        if (replied && m.step_index > 0) return done('cancelled', 'customer_replied');
      }

      // Quiet hours at the moment of sending (jobs can run late): push to the next allowed time.
      const allowed = respectQuietHours(now, b.quiet_hours, b.timezone, booking ? new Date(booking.start_at) : undefined);
      if (!allowed) return done('skipped', 'quiet_hours');
      if (allowed.getTime() > now.getTime() + MIN) {
        await tx.q(`UPDATE scheduled_messages SET send_at = $2 WHERE id = $1`, [id, allowed]);
        this.enqueue(tx, id, allowed);
        return { status: 'deferred', reason: 'quiet_hours' };
      }

      if (!m.transactional) {
        const consentKey = m.kind === 'win_back' || m.kind === 'greeting' ? 'marketing' : null;
        if (consentKey && !c.consent?.[consentKey]) return done('skipped', 'no_consent');
        const n = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM contact_log WHERE customer_id = $1 AND at > $2::timestamptz - interval '7 days'`, [c.id, now]);
        if ((n?.n ?? 0) >= b.contact_cap_per_week) return done('skipped', 'contact_cap');
      }

      const body = render(m.template, {
        name: (c.name ?? '').split(' ')[0] || 'there',
        business: b.name,
        address: b.address ?? '',
        service: booking?.service ?? lead?.interest ?? '',
        interest: lead?.interest ?? booking?.service ?? '',
        time: booking ? formatTime(c.language ?? b.default_language ?? 'en', booking.start_at, b.timezone) : '',
        review_link: b.review_url || `${config.publicBaseUrl}/${b.slug}`,
        link: `${config.publicBaseUrl}/${b.slug}`,
      });
      const r = await this.channels.deliver(tx, m.preferred_channel, { customer: c, body, agent: m.agent_key });
      if (!r.delivered) return done('skipped', r.reason ?? 'no_channel_connected');
      await tx.q(`INSERT INTO contact_log (customer_id, channel, agent_key, at) VALUES ($1, $2, $3, $4)`, [c.id, r.channel, m.agent_key, now]);
      const firstName = (c.name ?? '').split(' ')[0] || c.phone || '';
      if (m.kind === 'reminder') {
        await postFeed(tx, 'nudge', 'reminder_sent', { key: 'feed.nudge.reminder_sent', params: { customer: firstName, service: booking?.service ?? '' } }, { entityType: 'booking', entityId: booking?.id, minutesSaved: 2, channel: r.channel ?? undefined });
      } else if (m.kind === 'follow_up') {
        if (lead?.status === 'new') await tx.q(`UPDATE leads SET status = 'contacted' WHERE id = $1`, [lead.id]);
        await postFeed(tx, 'nudge', 'follow_up_sent', { key: 'feed.nudge.follow_up_sent', params: { customer: firstName } }, { entityType: 'lead', entityId: lead?.id, minutesSaved: 3, channel: r.channel ?? undefined });
      } else if (m.kind === 'renewal') {
        await postFeed(tx, 'nudge', 'renewal_sent', { key: 'feed.nudge.renewal_sent', params: { customer: firstName, service: booking?.service ?? '' } }, { entityType: 'customer', entityId: c.id, minutesSaved: 3, channel: r.channel ?? undefined });
      } else {
        await postFeed(tx, 'nudge', 'review_request_sent', { key: 'feed.nudge.review_request', params: { customer: firstName } }, { entityType: 'customer', entityId: c.id, minutesSaved: 2, channel: r.channel ?? undefined });
      }
      return done('sent', null, { channel: r.channel, body });
    });
  }
}

export function render(template: string, vars: Record<string, string>) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '').replace(/\s+([,.!?])/g, '$1').trim();
}

@Module({ providers: [NudgeService], exports: [NudgeService] })
export class NudgeModule {}
