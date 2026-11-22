import { Injectable, OnModuleInit } from '@nestjs/common';
import { formatTime, localParts, translate } from '@orbit/shared';
import { DbService, type Tx } from '../db/db.service';
import { ChannelsService } from '../channels/channels.service';
import { JobsService } from '../jobs/jobs.service';
import { postFeed } from '../common/feed';
import { liveToBusiness } from '../realtime/live';
import { agentName, fact, firstName } from '../trust/trace';
import { logger } from '../logger';
import { BookingsService } from './bookings.service';

type By = 'aria' | 'vox';
const langOf = (l: string | null | undefined) => (['en', 'hi', 'kn'].includes(l ?? '') ? (l as string) : 'en');

/**
 * Natural booking changes, the way customers actually say them: "running 10 min
 * late", "can I add a beard trim?", "yes, confirmed", "put me on the list if
 * anything opens up". Also the waitlist offer when someone cancels, and a gentle
 * "are you on your way?" when a customer has not arrived.
 */
@Injectable()
export class BookingChangesService implements OnModuleInit {
  constructor(private readonly db: DbService, private readonly bookings: BookingsService, private readonly channels: ChannelsService, private readonly jobs: JobsService) {}

  onModuleInit() {
    this.bookings.onCancelled = (tx, bk) => this.offerWaitlist(tx, bk);
    this.jobs.register('bookings.noshow', () => this.noShowSweep());
  }

  /** The customer's own upcoming booking (or null). */
  private async own(tx: Tx, bookingId: string, customerId: string | null) {
    if (!customerId) return null;
    return tx.one(
      `SELECT bk.*, s.name AS service, st.name AS staff_name FROM bookings bk JOIN services s ON s.id = bk.service_id LEFT JOIN staff st ON st.id = bk.staff_id
       WHERE bk.id = $1 AND bk.customer_id = $2 AND bk.deleted_at IS NULL AND bk.status IN ('pending', 'confirmed')`,
      [bookingId, customerId],
    );
  }

  /** When the next booking for the same person (or the business, with no staff) starts after this one. */
  private async gapAfter(tx: Tx, bk: any): Promise<number> {
    const next = await tx.one(
      `SELECT min(start_at) AS at FROM bookings WHERE id <> $1 AND deleted_at IS NULL AND status IN ('pending', 'confirmed') AND start_at >= $2
         AND ($3::uuid IS NULL OR staff_id = $3) AND start_at < $2::timestamptz + interval '4 hours'`,
      [bk.id, bk.end_at, bk.staff_id],
    );
    const ctx = await this.bookings.context(tx);
    // Closing time that day (last range end) also limits it.
    const local = localParts(new Date(bk.end_at), ctx.timezone);
    const day = (ctx.hours as any)?.[local.weekday];
    const close = day?.open && day.ranges.length ? day.ranges[day.ranges.length - 1].to : null;
    const closeMin = close ? Number(close.slice(0, 2)) * 60 + Number(close.slice(3)) - (Number(local.hhmm.slice(0, 2)) * 60 + Number(local.hhmm.slice(3))) : 240;
    const nextMin = next?.at ? (new Date(next.at).getTime() - new Date(bk.end_at).getTime()) / 60_000 : 240;
    return Math.max(0, Math.min(nextMin, closeMin));
  }

  private async tellTeam(tx: Tx, title: unknown, bookingId: string) {
    await tx.q(`INSERT INTO notifications (user_id, type, title, link) VALUES (NULL, 'booking_change', $1, '/bridge?view=today')`, [JSON.stringify(title)]);
    liveToBusiness(tx, { type: 'notification.new' });
    liveToBusiness(tx, { type: 'booking.changed', data: { id: bookingId } });
  }

  /** "Running 10 minutes late": fine if it still fits before the next booking; otherwise offer other times. */
  async runningLate(tx: Tx, customerId: string | null, bookingId: string, minutes: number, by: By, language: string) {
    const bk = await this.own(tx, bookingId, customerId);
    if (!bk) return { ok: false, error: 'That booking does not belong to this customer.' };
    const ctx = await this.bookings.context(tx);
    const grace = Number(ctx.booking_policy?.lateGraceMin ?? 15);
    const gap = await this.gapAfter(tx, bk);
    const c = await tx.one(`SELECT id, name, phone FROM customers WHERE id = $1`, [customerId]);
    if (minutes > grace && minutes > gap) {
      const options = (await this.bookings.slots(tx, { serviceId: bk.service_id, staffId: bk.staff_id, fromDate: localParts(new Date(), ctx.timezone).date, days: 2, limit: 3, excludeBookingId: bk.id }))
        .map((s) => ({ start: s.start.toISOString(), label: formatTime(language, s.start, ctx.timezone) }));
      return { ok: true, fits: false, options, note: `${minutes} minutes late does not fit before the next booking. Offer these times (reschedule_booking) or say the team will try to fit them in.` };
    }
    await tx.q(`UPDATE bookings SET late_minutes = $2, updated_at = now() WHERE id = $1`, [bk.id, minutes]);
    const who = firstName(c);
    await this.tellTeam(tx, { key: 'notify.booking.late', params: { customer: who, minutes, service: bk.service, time: `~t:${new Date(bk.start_at).toISOString()}` } }, bk.id);
    await postFeed(tx, by, 'customer_late', { key: 'feed.aria.late', params: { customer: who, minutes } }, {
      entityType: 'booking', entityId: bk.id, minutesSaved: 2,
      trace: {
        agent: by, customerId, action: { key: 'why.action.aria.late', params: { agent: await agentName(tx, by), customer: who, minutes } },
        trigger: { kind: 'inbound_message' }, approver: { kind: 'not_needed' },
        facts: [fact('fits', 'why.fact.late_fits', { minutes, gap: Math.round(gap) }, { type: 'booking', id: bk.id })],
      },
    });
    return { ok: true, fits: true, note: `Tell the customer it is fine, the team knows they will be about ${minutes} minutes late.${minutes > gap ? ' The appointment may need to be a little shorter.' : ''}` };
  }

  /** "Can I add a beard trim?": added if there is room after the booking. */
  async addToBooking(tx: Tx, customerId: string | null, bookingId: string, serviceId: string, by: By) {
    const bk = await this.own(tx, bookingId, customerId);
    if (!bk) return { ok: false, error: 'That booking does not belong to this customer.' };
    const s = await tx.one(`SELECT id, name, duration_min, price::float AS price FROM services WHERE id = $1 AND active AND deleted_at IS NULL`, [serviceId]);
    if (!s) return { ok: false, error: 'No such service.' };
    const gap = await this.gapAfter(tx, bk);
    if (s.duration_min > gap) return { ok: true, added: false, note: `There is not enough time after this booking for ${s.name}. Offer to book it separately (check_availability).` };
    const end = new Date(new Date(bk.end_at).getTime() + s.duration_min * 60_000);
    await tx.q(
      `UPDATE bookings SET end_at = $2, add_ons = add_ons || $3::jsonb, price = CASE WHEN price IS NULL OR $4::numeric IS NULL THEN price ELSE price + $4::numeric END, updated_at = now() WHERE id = $1`,
      [bk.id, end, JSON.stringify([{ serviceId: s.id, name: s.name, price: s.price, minutes: s.duration_min }]), s.price],
    );
    const c = await tx.one(`SELECT id, name, phone FROM customers WHERE id = $1`, [customerId]);
    const who = firstName(c);
    await this.tellTeam(tx, { key: 'notify.booking.add_on', params: { customer: who, service: s.name } }, bk.id);
    await postFeed(tx, by, 'booking_add_on', { key: 'feed.aria.add_on', params: { customer: who, service: s.name } }, {
      entityType: 'booking', entityId: bk.id, minutesSaved: 2, valueAmount: s.price ?? 0,
      trace: {
        agent: by, customerId, action: { key: 'why.action.aria.add_on', params: { agent: await agentName(tx, by), customer: who, service: s.name } },
        trigger: { kind: 'inbound_message' }, approver: { kind: 'not_needed' },
        facts: [fact('room', 'why.fact.add_on_fits', { service: s.name, minutes: s.duration_min }, { type: 'booking', id: bk.id })],
      },
    });
    return { ok: true, added: true, service: s.name, price: s.price, new_end: end.toISOString() };
  }

  /** "Yes, I'll be there." */
  async confirm(tx: Tx, customerId: string | null, bookingId: string, by: By) {
    const bk = await this.own(tx, bookingId, customerId);
    if (!bk) return { ok: false, error: 'That booking does not belong to this customer.' };
    // A pending booking stays pending (it waits for its deposit); the customer's yes is recorded either way.
    await tx.q(`UPDATE bookings SET customer_confirmed_at = now() WHERE id = $1`, [bk.id]);
    const c = await tx.one(`SELECT id, name, phone FROM customers WHERE id = $1`, [customerId]);
    await postFeed(tx, by, 'booking_confirmed', { key: 'feed.aria.confirmed', params: { customer: firstName(c), time: `~t:${new Date(bk.start_at).toISOString()}` } }, { entityType: 'booking', entityId: bk.id, minutesSaved: 1 });
    liveToBusiness(tx, { type: 'booking.changed', data: { id: bk.id } });
    return { ok: true };
  }

  /** "Tell me if something opens up on Saturday." */
  async joinWaitlist(tx: Tx, customerId: string | null, serviceId: string, wantedDate: string | null, by: By) {
    if (!customerId) return { ok: false, error: 'Ask for their name and mobile number first (create_lead or get_customer).' };
    const s = await tx.one(`SELECT name FROM services WHERE id = $1 AND deleted_at IS NULL`, [serviceId]);
    if (!s) return { ok: false, error: 'No such service.' };
    const dup = await tx.one(`SELECT id FROM waitlist_entries WHERE customer_id = $1 AND service_id = $2 AND status = 'waiting' AND wanted_date IS NOT DISTINCT FROM $3::date`, [customerId, serviceId, wantedDate]);
    if (!dup) await tx.q(`INSERT INTO waitlist_entries (customer_id, service_id, wanted_date) VALUES ($1, $2, $3)`, [customerId, serviceId, wantedDate]);
    const c = await tx.one(`SELECT id, name, phone FROM customers WHERE id = $1`, [customerId]);
    await postFeed(tx, by, 'waitlist_joined', { key: 'feed.aria.waitlist', params: { customer: firstName(c), service: s.name } }, { entityType: 'customer', entityId: customerId, minutesSaved: 1 });
    return { ok: true, note: 'Tell the customer they are on the list and will get a message as soon as a time opens up.' };
  }

  /** Someone cancelled: offer the time to the first person waiting for that service (and day). */
  async offerWaitlist(tx: Tx, bk: any) {
    if (new Date(bk.start_at).getTime() < Date.now() + 30 * 60_000) return null;
    const ctx = await this.bookings.context(tx);
    const day = localParts(new Date(bk.start_at), ctx.timezone).date;
    const w = await tx.one(
      `SELECT w.id, c.id AS customer_id, c.name, c.phone, c.email, c.language, c.consent, c.opted_out_at FROM waitlist_entries w JOIN customers c ON c.id = w.customer_id
       WHERE w.status = 'waiting' AND w.service_id = $1 AND (w.wanted_date IS NULL OR w.wanted_date = $2::date) AND w.customer_id <> $3
       ORDER BY (w.wanted_date IS NULL), w.created_at LIMIT 1`,
      [bk.service_id, day, bk.customer_id],
    );
    if (!w) return null;
    const lang = langOf(w.language);
    const svc = await tx.one(`SELECT name FROM services WHERE id = $1`, [bk.service_id]);
    const when = new Intl.DateTimeFormat(lang === 'en' ? 'en-IN' : `${lang}-IN`, { weekday: 'long', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: ctx.timezone }).format(new Date(bk.start_at));
    const body = translate(lang, 'aria.msg.waitlist_offer', { name: firstName(w), business: ctx.name, service: svc?.name ?? '', when });
    const r = await this.channels.deliver(tx, 'whatsapp', { customer: { id: w.customer_id, name: w.name, phone: w.phone, email: w.email, consent: w.consent ?? {}, opted_out_at: w.opted_out_at ?? {} }, body, agent: 'aria' }).catch((e) => {
      logger.warn(`waitlist offer not sent: ${e.message}`, 'Bookings');
      return { delivered: false } as { delivered: boolean };
    });
    await tx.q(`UPDATE waitlist_entries SET status = 'offered', offered_booking_slot = $2, offered_at = now(), updated_at = now() WHERE id = $1`, [w.id, bk.start_at]);
    await postFeed(tx, 'aria', 'waitlist_offered', { key: 'feed.aria.waitlist_offer', params: { customer: firstName(w), time: `~t:${new Date(bk.start_at).toISOString()}` } }, {
      entityType: 'customer', entityId: w.customer_id, minutesSaved: 3,
      trace: {
        agent: 'aria', customerId: w.customer_id, action: { key: 'why.action.aria.waitlist_offer', params: { agent: await agentName(tx, 'aria'), customer: firstName(w) } },
        trigger: { kind: 'external_event' }, approver: { kind: 'not_needed' },
        facts: [fact('freed', 'why.fact.slot_freed', { time: `~t:${new Date(bk.start_at).toISOString()}` }, { type: 'booking', id: bk.id }), fact('waiting', 'why.fact.was_waiting', { customer: firstName(w) })],
      },
    });
    return { offered: w.customer_id, delivered: r.delivered };
  }

  /** A customer has not arrived N minutes after their start: one friendly check-in, and the team is told. */
  async noShowSweep(now = new Date()) {
    const ids = await this.db.adminTx((tx) =>
      tx.q<{ id: string }>(
        `SELECT DISTINCT bk.business_id AS id FROM bookings bk WHERE bk.status = 'confirmed' AND bk.noshow_checked_at IS NULL AND bk.deleted_at IS NULL
           AND bk.start_at < $1::timestamptz - interval '10 minutes' AND bk.start_at > $1::timestamptz - interval '2 hours'`,
        [now],
      ),
    );
    let n = 0;
    for (const { id } of ids) {
      await this.db.withTenant(id, async (tx) => {
        const ctx = await this.bookings.context(tx);
        const wait = Number(ctx.booking_policy?.noShowCheckMin ?? 15);
        const due = await tx.q(
          `SELECT bk.id, bk.start_at, bk.late_minutes, s.name AS service, c.id AS customer_id, c.name, c.phone, c.email, c.language, c.consent, c.opted_out_at
           FROM bookings bk JOIN services s ON s.id = bk.service_id JOIN customers c ON c.id = bk.customer_id
           WHERE bk.status = 'confirmed' AND bk.noshow_checked_at IS NULL AND bk.deleted_at IS NULL
             AND bk.start_at + make_interval(mins => $2 + bk.late_minutes) < $1 AND bk.start_at > $1::timestamptz - interval '2 hours'`,
          [now, wait],
        );
        for (const b of due) {
          await tx.q(`UPDATE bookings SET noshow_checked_at = $2 WHERE id = $1`, [b.id, now]);
          const lang = langOf(b.language);
          const body = translate(lang, 'aria.msg.noshow_check', { name: firstName(b), business: ctx.name, service: b.service });
          await this.channels.deliver(tx, 'whatsapp', { customer: { id: b.customer_id, name: b.name, phone: b.phone, email: b.email, consent: b.consent ?? {}, opted_out_at: b.opted_out_at ?? {} }, body, agent: 'aria' }).catch(() => null);
          await this.tellTeam(tx, { key: 'notify.booking.not_arrived', params: { customer: firstName(b), service: b.service, time: `~t:${new Date(b.start_at).toISOString()}` } }, b.id);
          n++;
        }
      }).catch((e) => logger.error(`no-show sweep failed: ${e.message}`, e.stack, 'Bookings'));
    }
    return n;
  }
}
