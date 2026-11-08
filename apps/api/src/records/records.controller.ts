import { Controller, Get, Module, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { CurrentTenant, TenantGuard } from '../auth/guards';
import type { Tenant } from '../auth/types';
import { notFound } from '../common/errors';

/**
 * Read-only business records (classic "Details" data). Every query runs inside
 * withTenant, so RLS limits results to the caller's business.
 */
@UseGuards(TenantGuard)
@Controller()
export class RecordsController {
  constructor(private readonly db: DbService) {}

  @Get('customers')
  customers(@CurrentTenant() t: Tenant, @Query('q') q?: string) {
    return this.db.withTenant(t.businessId, (tx) =>
      tx.q(
        `SELECT id, name, phone, email, tags, lifetime_spend::float AS "lifetimeSpend", visit_count AS "visitCount", last_visit_at AS "lastVisitAt"
         FROM customers WHERE deleted_at IS NULL AND ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR phone LIKE '%' || $1 || '%')
         ORDER BY last_visit_at DESC NULLS LAST LIMIT 100`,
        [q?.slice(0, 60) || null],
      ),
    );
  }

  @Get('customers/:id')
  async customer(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const c = await this.db.withTenant(t.businessId, (tx) => tx.one(`SELECT * FROM customers WHERE id = $1 AND deleted_at IS NULL`, [id]));
    if (!c) throw notFound();
    return c;
  }

  @Get('bookings')
  bookings(@CurrentTenant() t: Tenant) {
    return this.db.withTenant(t.businessId, (tx) =>
      tx.q(
        `SELECT bk.id, bk.start_at AS "startAt", bk.end_at AS "endAt", bk.status, bk.source, c.name AS customer, s.name AS service, st.name AS staff
         FROM bookings bk LEFT JOIN customers c ON c.id = bk.customer_id LEFT JOIN services s ON s.id = bk.service_id LEFT JOIN staff st ON st.id = bk.staff_id
         WHERE bk.deleted_at IS NULL AND bk.start_at > now() - interval '30 days' ORDER BY bk.start_at LIMIT 200`,
      ),
    );
  }

  @Get('conversations')
  conversations(@CurrentTenant() t: Tenant) {
    return this.db.withTenant(t.businessId, (tx) =>
      tx.q(
        `SELECT cv.id, cv.channel, cv.status, cv.handled_by AS "handledBy", cv.last_message_at AS "lastMessageAt", c.name AS customer
         FROM conversations cv LEFT JOIN customers c ON c.id = cv.customer_id ORDER BY cv.last_message_at DESC NULLS LAST LIMIT 100`,
      ),
    );
  }

  @Get('conversations/:id/messages')
  messages(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(t.businessId, (tx) =>
      tx.q(`SELECT id, direction, sender, body, created_at AS "at" FROM messages WHERE conversation_id = $1 ORDER BY created_at`, [id]),
    );
  }

  @Get('tasks')
  tasks(@CurrentTenant() t: Tenant) {
    return this.db.withTenant(t.businessId, (tx) =>
      tx.q(`SELECT id, agent_key AS agent, goal, status, created_by_kind AS "createdBy", created_at AS "createdAt" FROM tasks ORDER BY created_at DESC LIMIT 100`),
    );
  }

  @Get('crew')
  crew(@CurrentTenant() t: Tenant) {
    return this.db.withTenant(t.businessId, (tx) =>
      tx.q(`SELECT agent_key AS agent, display_name AS name, personality, enabled, auto_approval_rules AS "autoApprovalRules" FROM agents ORDER BY created_at`),
    );
  }
}

@Module({ controllers: [RecordsController] })
export class RecordsModule {}
