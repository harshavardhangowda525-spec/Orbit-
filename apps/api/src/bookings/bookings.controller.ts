import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { formatTime } from '@orbit/shared';
import { DbService } from '../db/db.service';
import { CurrentTenant, Public, Roles, TenantGuard } from '../auth/guards';
import type { Tenant } from '../auth/types';
import { ZodPipe } from '../common/zod.pipe';
import { badRequest, notFound } from '../common/errors';
import { hashToken } from '../realtime/ws.gateway';
import { BookingsService } from './bookings.service';

const SlotQuery = z.object({
  serviceId: z.string().uuid(),
  staffId: z.string().uuid().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  days: z.coerce.number().int().min(1).max(31).optional(),
});
const Create = z.object({
  serviceId: z.string().uuid(),
  staffId: z.string().uuid().nullable().optional(),
  start: z.string().datetime({ offset: true }),
  name: z.string().trim().min(1).max(80),
  phone: z.string().trim().min(6).max(20),
  email: z.string().email().max(120).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});
const Change = z.object({
  start: z.string().datetime({ offset: true }).optional(),
  staffId: z.string().uuid().nullable().optional(),
  status: z.enum(['cancelled', 'completed', 'no_show']).optional(),
  reason: z.string().max(300).optional(),
});

const slotJson = (s: { start: Date; end: Date; staffId: string | null }) => ({ start: s.start.toISOString(), end: s.end.toISOString(), staffId: s.staffId });

/** Owner and staff calendar. */
@UseGuards(TenantGuard)
@Controller()
export class BookingsController {
  constructor(private readonly db: DbService, private readonly bookings: BookingsService) {}

  @Get('calendar')
  calendar(@CurrentTenant() t: Tenant, @Query('from') from?: string, @Query('to') to?: string) {
    const f = from && !isNaN(Date.parse(from)) ? new Date(from) : new Date(Date.now() - 86_400_000);
    const e = to && !isNaN(Date.parse(to)) ? new Date(to) : new Date(f.getTime() + 8 * 86_400_000);
    if (e.getTime() - f.getTime() > 62 * 86_400_000) throw badRequest('range_too_long', 'Please choose a shorter period.');
    return this.db.withTenant(t.businessId, async (tx) => ({
      staff: await tx.q(`SELECT id, name FROM staff WHERE active AND deleted_at IS NULL ORDER BY created_at`),
      services: await tx.q(`SELECT id, name, duration_min AS "durationMin", price::float AS price FROM services WHERE active AND deleted_at IS NULL ORDER BY sort_order`),
      bookings: await tx.q(
        `SELECT bk.id, bk.start_at AS "startAt", bk.end_at AS "endAt", bk.status, bk.source, bk.staff_id AS "staffId", bk.service_id AS "serviceId",
                c.id AS "customerId", c.name AS customer, c.phone, s.name AS service
         FROM bookings bk LEFT JOIN customers c ON c.id = bk.customer_id LEFT JOIN services s ON s.id = bk.service_id
         WHERE bk.deleted_at IS NULL AND bk.start_at < $2 AND bk.end_at > $1 ORDER BY bk.start_at`,
        [f, e],
      ),
    }));
  }

  @Get('slots')
  slots(@CurrentTenant() t: Tenant, @Query(new ZodPipe(SlotQuery)) q: z.infer<typeof SlotQuery>) {
    return this.db.withTenant(t.businessId, async (tx) => (await this.bookings.slots(tx, { serviceId: q.serviceId, staffId: q.staffId, fromDate: q.date, days: q.days })).map(slotJson));
  }

  @Roles('owner', 'manager', 'staff')
  @Post('bookings')
  create(@CurrentTenant() t: Tenant, @Body(new ZodPipe(Create)) b: z.infer<typeof Create>) {
    return this.db.withTenant(t.businessId, async (tx) => {
      const r = await this.bookings.create(tx, { serviceId: b.serviceId, staffId: b.staffId, start: new Date(b.start), customer: { name: b.name, phone: b.phone, email: b.email }, source: 'owner', createdBy: t.userId, note: b.note });
      return { id: r.booking.id, start: r.booking.start_at, staffId: r.booking.staff_id, customerId: r.customer.id, manageUrl: r.manageUrl };
    }, t.userId);
  }

  @Roles('owner', 'manager', 'staff')
  @Patch('bookings/:id')
  change(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Change)) b: z.infer<typeof Change>) {
    return this.db.withTenant(t.businessId, async (tx) => {
      if (b.status === 'cancelled') return this.bookings.cancel(tx, id, b.reason ?? 'owner', 'owner');
      if (b.status) return this.bookings.complete(tx, id, b.status);
      if (b.start) return this.bookings.reschedule(tx, id, new Date(b.start), b.staffId);
      throw badRequest('nothing_to_change', 'Nothing to change.');
    }, t.userId);
  }
}

/** Customer-facing booking page and manage-booking link (no sign-in, rate limited). */
@Controller('public')
export class PublicBookingController {
  constructor(private readonly db: DbService, private readonly bookings: BookingsService) {}

  private async businessId(slug: string) {
    if (!/^[a-z0-9-]{1,64}$/.test(slug)) throw notFound();
    const b = await this.db.one<{ id: string }>(`SELECT id FROM businesses WHERE slug = $1 AND status IN ('live', 'onboarding')`, [slug]);
    if (!b) throw notFound('We could not find this business.');
    return b.id;
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('businesses/:slug/staff')
  async staff(@Param('slug') slug: string, @Query('serviceId') serviceId?: string) {
    const id = await this.businessId(slug);
    return this.db.withTenant(id, async (tx) => {
      const svc = serviceId && /^[0-9a-f-]{36}$/.test(serviceId) ? await tx.one(`SELECT staff_ids FROM services WHERE id = $1`, [serviceId]) : null;
      return tx.q(`SELECT id, name FROM staff WHERE active AND deleted_at IS NULL AND (cardinality($1::uuid[]) = 0 OR id = ANY($1::uuid[])) ORDER BY created_at`, [svc?.staff_ids ?? []]);
    });
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('businesses/:slug/slots')
  async slots(@Param('slug') slug: string, @Query(new ZodPipe(SlotQuery)) q: z.infer<typeof SlotQuery>) {
    const id = await this.businessId(slug);
    return this.db.withTenant(id, async (tx) => (await this.bookings.slots(tx, { serviceId: q.serviceId, staffId: q.staffId, fromDate: q.date, days: q.days ?? 7, limit: 150 })).map(slotJson));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('businesses/:slug/bookings')
  async book(@Param('slug') slug: string, @Body(new ZodPipe(Create)) b: z.infer<typeof Create>) {
    const id = await this.businessId(slug);
    return this.db.withTenant(id, async (tx) => {
      const r = await this.bookings.create(tx, { serviceId: b.serviceId, staffId: b.staffId, start: new Date(b.start), customer: { name: b.name, phone: b.phone, email: b.email }, source: 'booking_page', note: b.note });
      return { id: r.booking.id, start: r.booking.start_at, end: r.booking.end_at, service: r.service.name, staff: r.staffName, manageUrl: r.manageUrl, status: r.booking.status, deposit: r.deposit };
    });
  }

  private async manageCtx(token: string) {
    const parsed = BookingsService.parseManageToken(token);
    if (!parsed) throw notFound('This link is not valid any more.');
    return parsed.businessId;
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('manage/:token')
  async manage(@Param('token') token: string) {
    const businessId = await this.manageCtx(token);
    return this.db.withTenant(businessId, async (tx) => {
      const bk = await tx.one(
        `SELECT bk.id, bk.start_at, bk.end_at, bk.status, bk.service_id, s.name AS service, st.name AS staff, c.name AS customer, c.language
         FROM bookings bk JOIN services s ON s.id = bk.service_id LEFT JOIN staff st ON st.id = bk.staff_id LEFT JOIN customers c ON c.id = bk.customer_id
         WHERE bk.manage_token_hash = $1`,
        [hashToken(token)],
      );
      if (!bk) throw notFound('This link is not valid any more.');
      const ctx = await this.bookings.context(tx);
      const hours = Number(ctx.policies?.cancellation_hours ?? 2);
      const canChange = ['pending', 'confirmed'].includes(bk.status) && new Date(bk.start_at).getTime() - Date.now() > hours * 3_600_000;
      return {
        business: { name: ctx.name, slug: ctx.slug, timezone: ctx.timezone },
        booking: { id: bk.id, start: bk.start_at, end: bk.end_at, status: bk.status, serviceId: bk.service_id, service: bk.service, staff: bk.staff, customer: bk.customer, localTime: formatTime(bk.language ?? 'en', bk.start_at, ctx.timezone) },
        canChange,
        policyHours: hours,
      };
    });
  }

  private async changeAllowed(tx: any, token: string) {
    const bk = await tx.one(`SELECT * FROM bookings WHERE manage_token_hash = $1`, [hashToken(token)]);
    if (!bk) throw notFound('This link is not valid any more.');
    const ctx = await this.bookings.context(tx);
    const hours = Number(ctx.policies?.cancellation_hours ?? 2);
    if (new Date(bk.start_at).getTime() - Date.now() <= hours * 3_600_000) {
      throw badRequest('too_late', `Changes are possible up to ${hours} hours before. Please call the business.`);
    }
    return bk;
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('manage/:token/cancel')
  async cancel(@Param('token') token: string) {
    const businessId = await this.manageCtx(token);
    return this.db.withTenant(businessId, async (tx) => {
      const bk = await this.changeAllowed(tx, token);
      await this.bookings.cancel(tx, bk.id, 'customer', 'customer');
      return { ok: true };
    });
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('manage/:token/reschedule')
  async reschedule(@Param('token') token: string, @Body(new ZodPipe(z.object({ start: z.string().datetime({ offset: true }) }))) b: { start: string }) {
    const businessId = await this.manageCtx(token);
    return this.db.withTenant(businessId, async (tx) => {
      const bk = await this.changeAllowed(tx, token);
      const r = await this.bookings.reschedule(tx, bk.id, new Date(b.start), undefined);
      return { ok: true, start: r.start_at };
    });
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('manage/:token/slots')
  async manageSlots(@Param('token') token: string, @Query('date') date?: string) {
    const businessId = await this.manageCtx(token);
    return this.db.withTenant(businessId, async (tx) => {
      const bk = await tx.one(`SELECT id, service_id, staff_id FROM bookings WHERE manage_token_hash = $1`, [hashToken(token)]);
      if (!bk) throw notFound();
      return (await this.bookings.slots(tx, { serviceId: bk.service_id, staffId: bk.staff_id, fromDate: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined, days: 7, excludeBookingId: bk.id })).map(slotJson);
    });
  }
}
