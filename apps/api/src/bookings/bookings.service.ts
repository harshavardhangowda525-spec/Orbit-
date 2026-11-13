import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { addDays, findSlots, localParts, toE164, formatTime, type Interval, type Slot, type StaffAvailability, type WeeklyHours } from '@orbit/shared';
import type { Tx } from '../db/db.service';
import { AppError, badRequest, notFound } from '../common/errors';
import { postFeed } from '../common/feed';
import { liveToBusiness } from '../realtime/live';
import { hashToken } from '../realtime/hash';
import { NudgeService } from '../nudge/nudge.service';
import { logger } from '../logger';
import { config } from '../config';

export const slotTaken = () => new AppError(409, 'slot_taken', 'Sorry, that time was just taken. Please pick another time.');

/** External calendar busy times (Google/Outlook), plugged in by the Powers module. */
export interface BusyProvider {
  busy(tx: Tx, from: Date, to: Date): Promise<{ staffId: string | null; intervals: Interval[] } | null>;
  onBookingChanged?(tx: Tx, bookingId: string, change: 'created' | 'moved' | 'cancelled'): void;
}

/** Ledger collects deposits: returns a payment link when this booking must be paid for to be confirmed. */
export type DepositProvider = (tx: Tx, booking: any, service: any, customer: any) => Promise<{ url: string; amount: number; payBy: Date } | null>;

export interface BookingInput {
  serviceId: string;
  staffId?: string | null; // null/undefined = any
  start: Date;
  customer: { name: string; phone: string; email?: string | null; language?: string | null };
  source: string; // aria:website_chat, booking_page, owner, ...
  createdBy?: string | null;
  note?: string | null;
  conversationId?: string | null;
}

/**
 * Bookings and availability. Every write takes a per-business advisory lock
 * and re-checks the slot, and the database exclusion constraint guarantees no
 * staff member is double booked even if two requests race.
 */
@Injectable()
export class BookingsService {
  private busyProvider: BusyProvider | null = null;
  constructor(private readonly nudge: NudgeService) {}

  setBusyProvider(p: BusyProvider) {
    this.busyProvider = p;
  }

  private depositProvider?: DepositProvider;
  setDepositProvider(p: DepositProvider) {
    this.depositProvider = p;
  }

  async context(tx: Tx) {
    const b = await tx.one(
      `SELECT b.id, b.name, b.slug, b.timezone, b.country, b.currency, b.default_language, p.hours, p.holidays, p.policies, p.address
       FROM businesses b JOIN business_profiles p ON p.business_id = b.id WHERE b.id = app_current_business()`,
    );
    if (!b) throw notFound();
    return b as { id: string; name: string; slug: string; timezone: string; country: string; currency: string; default_language: string; hours: WeeklyHours; holidays: string[]; policies: any; address: string | null };
  }

  async service(tx: Tx, serviceId: string) {
    const s = await tx.one(`SELECT * FROM services WHERE id = $1 AND active AND deleted_at IS NULL`, [serviceId]);
    if (!s) throw badRequest('unknown_service', 'That service is not available.');
    if (!s.duration_min) throw badRequest('not_bookable', 'This service is not booked by time. Orbit will take your details instead.');
    return s;
  }

  /** Free slots for a service, earliest first. */
  async slots(tx: Tx, q: { serviceId: string; staffId?: string | null; fromDate?: string; days?: number; now?: Date; limit?: number; excludeBookingId?: string }): Promise<Slot[]> {
    const now = q.now ?? new Date();
    const ctx = await this.context(tx);
    const svc = await this.service(tx, q.serviceId);
    const fromDate = q.fromDate ?? localParts(now, ctx.timezone).date;
    const days = Math.min(q.days ?? 7, 31);
    let staff = await tx.q(
      `SELECT id, name, working_hours, leave FROM staff WHERE active AND deleted_at IS NULL
       AND (cardinality($1::uuid[]) = 0 OR id = ANY($1::uuid[])) ORDER BY created_at`,
      [svc.staff_ids ?? []],
    );
    if (q.staffId) {
      staff = staff.filter((s) => s.id === q.staffId);
      if (!staff.length) throw badRequest('unknown_staff', 'That person does not do this service.');
    }
    const from = new Date(`${fromDate}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - 1);
    const to = new Date(`${addDays(fromDate, days + 1)}T00:00:00Z`);
    const booked = await tx.q(
      `SELECT bk.staff_id, bk.start_at, bk.end_at, COALESCE(s.buffer_before_min, 0) AS bb, COALESCE(s.buffer_after_min, 0) AS ba
       FROM bookings bk LEFT JOIN services s ON s.id = bk.service_id
       WHERE bk.status IN ('pending', 'confirmed') AND bk.deleted_at IS NULL AND bk.start_at < $2 AND bk.end_at > $1 AND ($3::uuid IS NULL OR bk.id <> $3)`,
      [from, to, q.excludeBookingId ?? null],
    );
    const external = this.busyProvider ? await this.busyProvider.busy(tx, from, to).catch(() => null) : null;
    const busyFor = (staffId: string | null): Interval[] => [
      ...booked
        .filter((b) => staffId === null || b.staff_id === staffId || b.staff_id === null)
        .map((b) => ({ start: new Date(new Date(b.start_at).getTime() - b.bb * 60_000), end: new Date(new Date(b.end_at).getTime() + b.ba * 60_000) })),
      ...(external && (external.staffId === null || external.staffId === staffId) ? external.intervals : []),
    ];
    const availability: StaffAvailability[] = staff.length
      ? staff.map((s) => ({ id: s.id, name: s.name, hours: s.working_hours, leave: s.leave ?? [], busy: busyFor(s.id) }))
      : [{ id: null, hours: null, busy: busyFor(null) }];
    return findSlots({
      timeZone: ctx.timezone,
      businessHours: ctx.hours,
      holidays: (ctx.holidays ?? []).map((h: any) => (typeof h === 'string' ? h : h.date)),
      staff: availability,
      durationMin: svc.duration_min,
      bufferBeforeMin: svc.buffer_before_min,
      bufferAfterMin: svc.buffer_after_min,
      fromDate,
      days,
      now,
      stepMin: svc.duration_min >= 60 ? 30 : 15,
      limit: q.limit ?? 120,
    });
  }

  private async lock(tx: Tx) {
    await tx.q(`SELECT pg_advisory_xact_lock(hashtext(app_current_business()::text))`);
  }

  async upsertCustomer(tx: Tx, c: { name?: string | null; phone?: string | null; email?: string | null; language?: string | null }, source: string, country = 'IN') {
    const phone = c.phone ? toE164(c.phone, country as any) : null;
    if (c.phone && !phone) throw badRequest('invalid_phone', 'That phone number does not look right. Please check it.');
    const existing = phone
      ? await tx.one(`SELECT * FROM customers WHERE phone = $1 AND deleted_at IS NULL`, [phone])
      : c.email
        ? await tx.one(`SELECT * FROM customers WHERE email = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`, [c.email])
        : null;
    if (existing) {
      return tx.one(
        `UPDATE customers SET name = COALESCE(name, $2), email = COALESCE(email, $3), language = COALESCE(language, $4) WHERE id = $1 RETURNING *`,
        [existing.id, c.name?.trim() || null, c.email ?? null, c.language ?? null],
      );
    }
    return tx.one(
      `INSERT INTO customers (name, phone, email, language, source, consent) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      // Giving a number to book = consent to messages about that booking (not marketing).
      [c.name?.trim() || null, phone, c.email ?? null, c.language ?? null, source, JSON.stringify({ whatsapp: !!phone, sms: !!phone, email: !!c.email, calls: !!phone, marketing: false })],
    );
  }

  async create(tx: Tx, input: BookingInput, now = new Date()) {
    await this.lock(tx);
    const ctx = await this.context(tx);
    const svc = await this.service(tx, input.serviceId);
    const day = localParts(input.start, ctx.timezone).date;
    const free = await this.slots(tx, { serviceId: svc.id, staffId: input.staffId ?? null, fromDate: day, days: 1, now, limit: 500 });
    const slot = free.find((s) => s.start.getTime() === input.start.getTime());
    if (!slot) throw slotTaken();
    const customer = await this.upsertCustomer(tx, input.customer, input.source.split(':').pop() ?? input.source, ctx.country);
    const token = `${ctx.id}.${randomBytes(18).toString('base64url')}`;
    let booking: any;
    try {
      await tx.q('SAVEPOINT bk');
      booking = await tx.one(
        `INSERT INTO bookings (customer_id, service_id, staff_id, start_at, end_at, status, source, price, manage_token_hash, customer_note, created_by)
         VALUES ($1, $2, $3, $4, $5, 'confirmed', $6, $7, $8, $9, $10) RETURNING *`,
        [customer.id, svc.id, slot.staffId, slot.start, slot.end, input.source, svc.price, hashToken(token), input.note ?? null, input.createdBy ?? null],
      );
      await tx.q('RELEASE SAVEPOINT bk');
    } catch (e: any) {
      await tx.q('ROLLBACK TO SAVEPOINT bk');
      if (e?.code === '23P01') throw slotTaken();
      throw e;
    }
    if (input.conversationId) await tx.q(`UPDATE conversations SET customer_id = $2 WHERE id = $1 AND customer_id IS NULL`, [input.conversationId, customer.id]);
    // The customer booked: open leads are won and their follow-ups stop.
    await tx.q(`UPDATE leads SET status = 'booked' WHERE customer_id = $1 AND status IN ('new', 'contacted', 'qualified')`, [customer.id]);
    await this.nudge.stopForCustomer(tx, customer.id, 'customer_booked');
    await this.nudge.onBookingScheduled(tx, booking, now);

    const staffName = slot.staffId ? (await tx.one(`SELECT name FROM staff WHERE id = $1`, [slot.staffId]))?.name : null;
    const byAria = input.source.startsWith('aria');
    const channel = input.source.includes(':') ? input.source.split(':')[1] : input.source;
    const first = (customer.name ?? '').split(' ')[0] || customer.phone;
    await postFeed(
      tx,
      byAria ? 'aria' : 'orbit',
      'booking_created',
      { key: byAria ? 'feed.aria.booked' : 'feed.orbit.booked', params: { customer: first, service: svc.name, time: `~t:${slot.start.toISOString()}`, channel: `@channel.${channel}` } },
      { entityType: 'booking', entityId: booking.id, valueAmount: byAria ? Number(svc.price ?? 0) : 0, minutesSaved: byAria ? 6 : 0, channel },
    );
    liveToBusiness(tx, { type: 'booking.changed', data: { id: booking.id } });
    this.busyProvider?.onBookingChanged?.(tx, booking.id, 'created');
    // Services with a deposit stay "pending" (the slot is held) until the deposit is paid.
    let deposit: Awaited<ReturnType<DepositProvider>> = null;
    if (svc.deposit_required && this.depositProvider && Number(svc.price ?? svc.deposit_amount ?? 0) > 0) {
      await tx.q('SAVEPOINT deposit');
      try {
        deposit = await this.depositProvider(tx, booking, svc, customer);
        await tx.q('RELEASE SAVEPOINT deposit');
      } catch (e) {
        // Payments down: keep the customer's booking (confirmed) rather than lose it.
        await tx.q('ROLLBACK TO SAVEPOINT deposit');
        logger.warn(`deposit link failed for booking ${booking.id}: ${(e as Error).message}`, 'Bookings');
      }
    }
    if (deposit) {
      booking = await tx.one(`UPDATE bookings SET status = 'pending' WHERE id = $1 RETURNING *`, [booking.id]);
    }
    return {
      booking,
      customer,
      service: svc,
      staffName,
      deposit,
      manageUrl: `${config.publicBaseUrl}/manage/${token}`,
      localTime: formatTime(input.customer.language ?? ctx.default_language, slot.start, ctx.timezone),
    };
  }

  async reschedule(tx: Tx, bookingId: string, start: Date, staffId: string | null | undefined, now = new Date()) {
    await this.lock(tx);
    const bk = await tx.one(`SELECT * FROM bookings WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [bookingId]);
    if (!bk || !['pending', 'confirmed'].includes(bk.status)) throw notFound('That booking cannot be changed.');
    const ctx = await this.context(tx);
    const day = localParts(start, ctx.timezone).date;
    const free = await this.slots(tx, { serviceId: bk.service_id, staffId: staffId === undefined ? bk.staff_id : staffId, fromDate: day, days: 1, now, limit: 500, excludeBookingId: bk.id });
    const slot = free.find((s) => s.start.getTime() === start.getTime());
    if (!slot) throw slotTaken();
    let updated: any;
    try {
      await tx.q('SAVEPOINT rs');
      updated = await tx.one(`UPDATE bookings SET start_at = $2, end_at = $3, staff_id = $4 WHERE id = $1 RETURNING *`, [bk.id, slot.start, slot.end, slot.staffId]);
      await tx.q('RELEASE SAVEPOINT rs');
    } catch (e: any) {
      await tx.q('ROLLBACK TO SAVEPOINT rs');
      if (e?.code === '23P01') throw slotTaken();
      throw e;
    }
    await this.nudge.onBookingScheduled(tx, updated, now);
    const c = await tx.one(`SELECT name FROM customers WHERE id = $1`, [bk.customer_id]);
    await postFeed(tx, 'orbit', 'booking_moved', { key: 'feed.orbit.booking_moved', params: { customer: (c?.name ?? '').split(' ')[0], time: `~t:${slot.start.toISOString()}` } }, { entityType: 'booking', entityId: bk.id });
    liveToBusiness(tx, { type: 'booking.changed', data: { id: bk.id } });
    this.busyProvider?.onBookingChanged?.(tx, bk.id, 'moved');
    return updated;
  }

  async cancel(tx: Tx, bookingId: string, reason: string, by: 'customer' | 'owner' | 'aria') {
    const bk = await tx.one(`UPDATE bookings SET status = 'cancelled', cancelled_reason = $2 WHERE id = $1 AND status IN ('pending', 'confirmed') RETURNING *`, [bookingId, reason]);
    if (!bk) throw notFound('That booking is already cancelled or finished.');
    await this.nudge.cancelForBooking(tx, bk.id, 'booking_cancelled');
    const c = await tx.one(`SELECT name FROM customers WHERE id = $1`, [bk.customer_id]);
    await postFeed(tx, by === 'aria' ? 'aria' : 'orbit', 'booking_cancelled', { key: 'feed.orbit.booking_cancelled', params: { customer: (c?.name ?? '').split(' ')[0], time: `~t:${new Date(bk.start_at).toISOString()}` } }, { entityType: 'booking', entityId: bk.id });
    liveToBusiness(tx, { type: 'booking.changed', data: { id: bk.id } });
    this.busyProvider?.onBookingChanged?.(tx, bk.id, 'cancelled');
    return bk;
  }

  async complete(tx: Tx, bookingId: string, status: 'completed' | 'no_show') {
    const bk = await tx.one(
      `UPDATE bookings bk SET status = $2 FROM services s WHERE bk.id = $1 AND s.id = bk.service_id AND bk.status IN ('pending', 'confirmed') RETURNING bk.*, s.category AS service_category`,
      [bookingId, status],
    );
    if (!bk) throw notFound();
    await this.nudge.cancelForBooking(tx, bk.id, status);
    if (status === 'completed') {
      await tx.q(`UPDATE customers SET visit_count = visit_count + 1, last_visit_at = $2, lifetime_spend = lifetime_spend + COALESCE($3::numeric, 0) WHERE id = $1`, [bk.customer_id, bk.end_at, bk.price]);
      await this.nudge.onBookingCompleted(tx, bk);
    }
    liveToBusiness(tx, { type: 'booking.changed', data: { id: bk.id } });
    return bk;
  }

  /** Customer self-service link: "<businessId>.<secret>". */
  static parseManageToken(token: string): { businessId: string } | null {
    const m = token.match(/^([0-9a-f-]{36})\.[A-Za-z0-9_-]{20,}$/);
    return m ? { businessId: m[1] } : null;
  }
}
