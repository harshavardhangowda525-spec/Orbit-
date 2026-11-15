import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { isValidWeeklyHours } from '@orbit/shared';
import { DbService } from '../db/db.service';
import { CurrentTenant, Roles, TenantGuard } from '../auth/guards';
import type { Tenant } from '../auth/types';
import { ZodPipe } from '../common/zod.pipe';
import { badRequest, notFound } from '../common/errors';
import { postFeed } from '../common/feed';
import { liveToBusiness } from '../realtime/live';
import { fact } from '../trust/trace';
import { SnapService } from './snap.service';

const Read = z.object({ kind: z.enum(['price_list', 'card', 'hours']), fileIds: z.array(z.string().uuid()).min(1).max(5) });
const Item = z.object({
  name: z.string().trim().min(1).max(120),
  nameEn: z.string().trim().max(120).nullable().optional(),
  category: z.string().trim().max(60).nullable().optional(),
  description: z.string().trim().max(300).nullable().optional(),
  price: z.number().nonnegative().max(10_000_000).nullable(),
  priceType: z.enum(['fixed', 'from', 'range', 'per_hour']).default('fixed'),
  priceMax: z.number().nonnegative().max(10_000_000).nullable().optional(),
  durationMin: z.number().int().min(5).max(600),
  // add: a new service; update: change the price of an existing one ("You already have Haircut ₹300. Update to ₹350?"); skip: ignore.
  action: z.enum(['add', 'update', 'skip']),
  updateId: z.string().uuid().optional(),
});
const ApplyServices = z.object({ items: z.array(Item).min(1).max(200) });
const ApplyDetails = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().max(30).optional(),
  address: z.string().trim().max(300).optional(),
  hours: z.unknown().optional(),
});

/**
 * Snap to set up: photograph the price board, business card or hours board.
 * Reading returns a draft; nothing changes until the owner confirms it here.
 */
@UseGuards(TenantGuard)
@Controller('snap')
export class SnapController {
  constructor(private readonly db: DbService, private readonly snap: SnapService) {}

  @Roles('owner', 'manager')
  @Post()
  read(@CurrentTenant() t: Tenant, @Body(new ZodPipe(Read)) b: z.infer<typeof Read>) {
    return this.snap.read(t.businessId, b.kind, b.fileIds, t.userId);
  }

  /** The services list for Details (with the photo each came from). */
  @Get('services')
  listServices(@CurrentTenant() t: Tenant) {
    return this.db.withTenant(t.businessId, (tx) =>
      tx.q(
        `SELECT id, name, name_en AS "nameEn", category, price::float AS price, price_type AS "priceType", price_max::float AS "priceMax", duration_min AS "durationMin", source_file_ids AS "fileIds"
         FROM services WHERE deleted_at IS NULL AND active ORDER BY sort_order, created_at`,
      ),
    );
  }

  @Get(':id')
  get(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(t.businessId, async (tx) => {
      const s = await tx.one(`SELECT id, kind, file_ids AS "fileIds", status, result, problem, created_at AS "createdAt" FROM snaps WHERE id = $1`, [id]);
      if (!s) throw notFound();
      return s;
    });
  }

  private async draft(tx: any, id: string, kind: string) {
    const s = await tx.one(`SELECT * FROM snaps WHERE id = $1 FOR UPDATE`, [id]);
    if (!s || s.kind !== kind) throw notFound();
    if (s.status === 'applied') throw badRequest('already_added', 'These were already added.');
    if (s.status !== 'draft') throw badRequest('not_ready', 'Nothing to add from this photo.');
    return s;
  }

  /** Add the services the owner kept (and update the prices they chose to update). */
  @Roles('owner', 'manager')
  @Post(':id/services')
  services(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ApplyServices)) b: z.infer<typeof ApplyServices>) {
    return this.db.withTenant(t.businessId, async (tx) => {
      const s = await this.draft(tx, id, 'price_list');
      let added = 0;
      let updated = 0;
      const order = (await tx.one(`SELECT COALESCE(max(sort_order), 0)::int AS n FROM services`))?.n ?? 0;
      for (const it of b.items) {
        if (it.action === 'skip') continue;
        if (it.action === 'update') {
          if (!it.updateId) throw badRequest('update_id', 'Choose which service to update.');
          const r = await tx.one(
            `UPDATE services SET price = $2, price_type = $3, price_max = $4, source_file_ids = source_file_ids || $5::uuid[] WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
            [it.updateId, it.price, it.priceType, it.priceMax ?? null, s.file_ids],
          );
          if (r) updated++;
          continue;
        }
        await tx.q(
          `INSERT INTO services (name, name_en, category, description, price, price_type, price_max, duration_min, sort_order, source_file_ids, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [it.name, it.nameEn ?? null, it.category ?? null, it.description ?? null, it.price, it.priceType, it.priceMax ?? null, it.durationMin, order + ++added, s.file_ids, t.userId],
        );
      }
      await tx.q(`UPDATE snaps SET status = 'applied', applied_at = now() WHERE id = $1`, [id]);
      if (added + updated > 0) {
        await postFeed(tx, 'orbit', 'services_added', { key: 'feed.orbit.services_added', params: { count: added + updated } }, {
          entityType: 'snap', entityId: id, minutesSaved: Math.min(60, (added + updated) * 2),
          trace: {
            agent: 'orbit', action: { key: 'why.action.orbit.services_added', params: { count: added + updated } }, trigger: { kind: 'owner_decision' }, approver: { kind: 'owner' },
            facts: [fact('photos', 'why.fact.read_from_photos', { count: s.file_ids.length }), fact('confirmed', 'why.fact.you_checked', { count: added + updated })],
          },
        });
      }
      liveToBusiness(tx, { type: 'stats.changed' });
      // Aria answers from the services table, so she knows the new prices at once.
      return { added, updated };
    }, t.userId);
  }

  /** Business card / signboard / hours board: save only the fields the owner kept. */
  @Roles('owner', 'manager')
  @Post(':id/details')
  details(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ApplyDetails)) b: z.infer<typeof ApplyDetails>) {
    return this.db.withTenant(t.businessId, async (tx) => {
      const s = await tx.one(`SELECT kind FROM snaps WHERE id = $1`, [id]);
      if (!s) throw notFound();
      await this.draft(tx, id, s.kind);
      if (b.hours !== undefined && !isValidWeeklyHours(b.hours)) throw badRequest('hours', 'Please check the opening hours.');
      if (b.name) await tx.q(`UPDATE businesses SET name = $1 WHERE id = app_current_business()`, [b.name]);
      await tx.q(
        `UPDATE business_profiles SET phone = COALESCE($1, phone), address = COALESCE($2, address), hours = COALESCE($3::jsonb, hours) WHERE business_id = app_current_business()`,
        [b.phone || null, b.address || null, b.hours ? JSON.stringify(b.hours) : null],
      );
      await tx.q(`UPDATE snaps SET status = 'applied', applied_at = now() WHERE id = $1`, [id]);
      liveToBusiness(tx, { type: 'stats.changed' });
      return { ok: true };
    }, t.userId);
  }

  @Post(':id/discard')
  discard(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(t.businessId, (tx) => tx.q(`UPDATE snaps SET status = 'discarded' WHERE id = $1 AND status = 'draft'`, [id]).then(() => ({ ok: true })));
  }
}

@Module({ controllers: [SnapController], providers: [SnapService], exports: [SnapService] })
export class SnapModule {}
