import { syncCrewToPlan } from '../billing/crew-plan';
import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { BUSINESS_TYPES } from '@orbit/shared';
import { DbService } from '../db/db.service';
import { AdminGuard, ClientIp, CurrentUser } from '../auth/guards';
import type { AuthUser } from '../auth/types';
import { AuthService } from '../auth/auth.service';
import { AuditService } from '../audit/audit.service';
import { ZodPipe } from '../common/zod.pipe';
import { badRequest, notFound } from '../common/errors';

const BusinessPatch = z.object({
  status: z.enum(['live', 'paused', 'suspended', 'onboarding']).optional(),
  planCode: z.string().min(1).max(40).optional(),
});
const PlanPut = z.object({
  name: z.string().min(1).max(60),
  prices: z.object({ INR: z.number().min(0), USD: z.number().min(0) }),
  limits: z.record(z.unknown()),
  features: z.object({ agents: z.array(z.string()), powers: z.array(z.string()) }).passthrough(),
  active: z.boolean().default(true),
});
const TemplatePut = z.object({ content: z.object({ type: z.enum(BUSINESS_TYPES), services: z.array(z.unknown()).min(1) }).passthrough() });

/**
 * Platform admin panel (the Orbit team). Uses the admin database role for
 * cross-business aggregates. Every change and every impersonation is audited.
 */
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly db: DbService, private readonly auth: AuthService, private readonly audit: AuditService) {}

  @Get('businesses')
  businesses(@Query('q') q?: string) {
    return this.db.adminTx((tx) =>
      tx.q(
        `SELECT b.id, b.name, b.slug, b.type, b.status, b.onboarding_step AS "onboardingStep", b.created_at AS "createdAt", p.code AS plan,
           COALESCE(u.ai_messages, 0) AS "aiMessages", COALESCE(u.call_minutes, 0) AS "callMinutes", COALESCE(u.tasks, 0) AS tasks,
           (SELECT count(*)::int FROM customers c WHERE c.business_id = b.id) AS customers,
           (SELECT count(*)::int FROM bookings k WHERE k.business_id = b.id AND k.created_at > now() - interval '30 days') AS "bookings30d",
           (SELECT count(*)::int FROM tasks t WHERE t.business_id = b.id AND t.status = 'failed' AND t.updated_at > now() - interval '7 days') AS "failedTasks7d"
         FROM businesses b JOIN plans p ON p.id = b.plan_id
         LEFT JOIN usage_counters u ON u.business_id = b.id AND u.period = to_char(now(), 'YYYY-MM')
         WHERE ($1::text IS NULL OR b.name ILIKE '%' || $1 || '%' OR b.slug ILIKE '%' || $1 || '%')
         ORDER BY b.created_at DESC LIMIT 200`,
        [q?.slice(0, 60) || null],
      ),
    );
  }

  @Get('businesses/:id')
  async business(@Param('id', ParseUUIDPipe) id: string) {
    return this.db.adminTx(async (tx) => {
      const b = await tx.one(`SELECT b.*, p.code AS plan FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.id = $1`, [id]);
      if (!b) throw notFound();
      const owners = await tx.q(`SELECT u.id, u.name, u.phone, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.business_id = $1`, [id]);
      const usage = await tx.q(`SELECT period, ai_messages, call_minutes, tasks, campaigns_sent FROM usage_counters WHERE business_id = $1 ORDER BY period DESC LIMIT 6`, [id]);
      const audit = await tx.q(`SELECT action, actor_kind, at FROM audit_log WHERE business_id = $1 ORDER BY at DESC LIMIT 20`, [id]);
      return { business: b, members: owners, usage, audit };
    });
  }

  @Patch('businesses/:id')
  async patchBusiness(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(BusinessPatch)) body: z.infer<typeof BusinessPatch>, @ClientIp() ip: string) {
    return this.db.adminTx(async (tx) => {
      const before = await tx.one(`SELECT status, plan_id FROM businesses WHERE id = $1`, [id]);
      if (!before) throw notFound();
      let planId = before.plan_id;
      if (body.planCode) {
        const p = await tx.one(`SELECT id FROM plans WHERE code = $1`, [body.planCode]);
        if (!p) throw badRequest('unknown_plan', 'That plan does not exist.');
        planId = p.id;
      }
      const after = await tx.one(`UPDATE businesses SET status = COALESCE($2, status), plan_id = $3 WHERE id = $1 RETURNING status, plan_id`, [id, body.status ?? null, planId]);
      await syncCrewToPlan(tx, id, before.plan_id, planId);
      await this.audit.write({ businessId: id, actorId: u.id, actorKind: 'admin', action: 'admin.business.update', entity: 'business', entityId: id, before, after, ip }, tx);
      return after;
    });
  }

  /** Short-lived token that acts as owner of exactly one business. Audited. */
  @Post('businesses/:id/impersonate')
  async impersonate(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string) {
    const b = await this.db.one(`SELECT id, name FROM businesses WHERE id = $1`, [id]);
    if (!b) throw notFound();
    await this.audit.write({ businessId: id, actorId: u.id, actorKind: 'admin', action: 'admin.impersonate', entity: 'business', entityId: id, ip });
    return { token: this.auth.issue({ sub: u.id, imp: { adminId: u.id, businessId: id } }, '1h'), businessId: id, expiresInSec: 3600 };
  }

  @Get('plans')
  plans() {
    return this.db.q(`SELECT code, name, prices, limits, features, active, sort_order AS "sortOrder" FROM plans ORDER BY sort_order`);
  }

  @Put('plans/:code')
  async putPlan(@CurrentUser() u: AuthUser, @Param('code') code: string, @Body(new ZodPipe(PlanPut)) body: z.infer<typeof PlanPut>, @ClientIp() ip: string) {
    return this.db.adminTx(async (tx) => {
      const before = await tx.one(`SELECT name, prices, limits, features, active FROM plans WHERE code = $1`, [code]);
      if (!before) throw notFound();
      const after = await tx.one(
        `UPDATE plans SET name = $2, prices = $3, limits = $4, features = $5, active = $6 WHERE code = $1 RETURNING code, name, prices, limits, features, active`,
        [code, body.name, JSON.stringify(body.prices), JSON.stringify(body.limits), JSON.stringify(body.features), body.active],
      );
      await this.audit.write({ actorId: u.id, actorKind: 'admin', action: 'admin.plan.update', entity: 'plan', before, after, ip }, tx);
      return after;
    });
  }

  @Get('templates')
  templates() {
    return this.db.q(`SELECT type, version, content, updated_at AS "updatedAt" FROM business_templates ORDER BY type`);
  }

  @Put('templates/:type')
  async putTemplate(@CurrentUser() u: AuthUser, @Param('type') type: string, @Body(new ZodPipe(TemplatePut)) body: z.infer<typeof TemplatePut>, @ClientIp() ip: string) {
    if (body.content.type !== type) throw badRequest('type_mismatch', 'The template type does not match.');
    return this.db.adminTx(async (tx) => {
      const r = await tx.one(
        `UPDATE business_templates SET content = $2, version = version + 1, updated_by = $3 WHERE type = $1 RETURNING type, version`,
        [type, JSON.stringify(body.content), u.id],
      );
      if (!r) throw notFound();
      await this.audit.write({ actorId: u.id, actorKind: 'admin', action: 'admin.template.update', entity: 'business_template', after: r, ip }, tx);
      return r;
    });
  }

  @Get('health')
  async health() {
    const started = Date.now();
    const db = await this.db.adminTx((tx) =>
      tx.one(`SELECT
        (SELECT count(*)::int FROM businesses) AS businesses,
        (SELECT count(*)::int FROM businesses WHERE status = 'live') AS live,
        (SELECT count(*)::int FROM users) AS users,
        (SELECT count(*)::int FROM tasks WHERE status = 'failed' AND updated_at > now() - interval '1 day') AS "failedTasks24h",
        (SELECT count(*)::int FROM tasks WHERE status = 'queued') AS "queuedTasks"`),
    );
    return { ok: true, dbLatencyMs: Date.now() - started, ...db };
  }

  @Get('audit')
  auditLog() {
    return this.db.adminTx((tx) => tx.q(`SELECT a.action, a.actor_kind, a.entity, a.business_id, a.at, COALESCE(u.email::text, u.phone, u.name) AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.at DESC LIMIT 100`));
  }
}

@Module({ controllers: [AdminController] })
export class AdminModule {}
