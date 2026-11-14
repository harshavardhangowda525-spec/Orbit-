import { Body, Controller, Delete, Get, Global, Module, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { EXCEPTABLE_RULES, type DecisionTrace } from '@orbit/shared';
import { DbService } from '../db/db.service';
import { CurrentTenant, Roles, TenantGuard } from '../auth/guards';
import type { Tenant } from '../auth/types';
import { ZodPipe } from '../common/zod.pipe';
import { badRequest, notFound } from '../common/errors';
import { liveToBusiness } from '../realtime/live';
import { HOLD_DEFAULTS, HOLD_MAX, HOLD_TYPES, HoldService } from './hold.service';
import { recentChanges, recordVersion, revertVersion, snapshot } from './versions';

const Feedback = z.object({ verdict: z.enum(['good', 'change_rule', 'exception']) });
const REVIEW_CHANNELS = ['website_chat', 'chat_link', 'whatsapp', 'instagram', 'messenger', 'gmail', 'outlook', 'sms'] as const;
const Safety = z.object({
  holdSeconds: z.object(Object.fromEntries(HOLD_TYPES.map((t) => [t, z.number().int().min(0).max(HOLD_MAX).optional()])) as Record<(typeof HOLD_TYPES)[number], z.ZodOptional<z.ZodNumber>>).optional(),
  reviewBeforeSend: z.object(Object.fromEntries(REVIEW_CHANNELS.map((c) => [c, z.boolean().optional()])) as Record<(typeof REVIEW_CHANNELS)[number], z.ZodOptional<z.ZodBoolean>>).optional(),
});

/**
 * Trust: the Undo window, "Why did you do that?", the owner's exceptions,
 * Crew → Safety settings, and 24-hour undo of settings changes.
 */
@UseGuards(TenantGuard)
@Controller('trust')
export class TrustController {
  constructor(private readonly db: DbService, private readonly hold: HoldService) {}

  @Get('held')
  held(@CurrentTenant() t: Tenant) {
    return this.db.withTenant(t.businessId, (tx) => this.hold.list(tx));
  }

  @Roles('owner', 'manager')
  @Post('held/:id/undo')
  undo(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.hold.undo(t.businessId, t.userId, id, 'app');
  }

  @Roles('owner', 'manager')
  @Post('held/:id/correction')
  correction(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.hold.correction(t.businessId, t.userId, id);
  }

  /** The stored reasons for one action. The sentence is phrased from these on the owner's screen. */
  @Get('traces/:id')
  trace(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(t.businessId, async (tx) => {
      const r = await tx.one(`SELECT * FROM decision_traces WHERE id = $1`, [id]);
      if (!r) throw notFound();
      const c = r.customer_id ? await tx.one(`SELECT id, name, phone FROM customers WHERE id = $1`, [r.customer_id]) : null;
      const code: string | null = r.rule?.code ?? null;
      const exception = c && code ? await tx.one(`SELECT id FROM customer_exceptions WHERE customer_id = $1 AND action_code = $2`, [c.id, code]) : null;
      const mine = await tx.q(`SELECT verdict FROM trace_feedback WHERE trace_id = $1 AND user_id = $2`, [id, t.userId]);
      const b = await tx.one(`SELECT timezone FROM businesses WHERE id = app_current_business()`);
      const trace: DecisionTrace = {
        id: r.id, agent: r.agent_key, action: r.action, trigger: r.trigger, rule: r.rule, facts: r.facts, alternatives: r.alternatives, approver: r.approver,
        customer: c ? { id: c.id, name: (c.name ?? '').split(' ')[0] || c.phone } : null, createdAt: r.created_at,
      };
      return {
        trace,
        timezone: b.timezone,
        canException: !!(c && code && (EXCEPTABLE_RULES as readonly string[]).includes(code)),
        exceptionId: exception?.id ?? null,
        feedback: mine.map((m) => m.verdict),
      };
    });
  }

  @Post('traces/:id/feedback')
  feedback(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Feedback)) b: z.infer<typeof Feedback>) {
    return this.db.withTenant(t.businessId, async (tx) => {
      const r = await tx.one(`SELECT id, agent_key, customer_id, rule FROM decision_traces WHERE id = $1`, [id]);
      if (!r) throw notFound();
      const code: string | null = r.rule?.code ?? null;
      let exceptionId: string | null = null;
      if (b.verdict === 'exception') {
        if (!r.customer_id || !code || !(EXCEPTABLE_RULES as readonly string[]).includes(code)) throw badRequest('no_exception', 'This kind of action cannot be switched off for one customer.');
        const e = await tx.one(
          `INSERT INTO customer_exceptions (customer_id, action_code, trace_id, created_by) VALUES ($1, $2, $3, $4)
           ON CONFLICT (business_id, customer_id, action_code) DO UPDATE SET trace_id = EXCLUDED.trace_id RETURNING id`,
          [r.customer_id, code, id, t.userId],
        );
        exceptionId = e.id;
        // Anything of this kind already waiting for them is cancelled too.
        const kind = code.startsWith('nudge.') ? code.slice(6) : null;
        if (kind) await tx.q(`UPDATE scheduled_messages SET status = 'cancelled', skip_reason = 'owner_exception' WHERE customer_id = $1 AND kind = $2 AND status = 'scheduled'`, [r.customer_id, kind]);
      }
      await tx.q(
        `INSERT INTO trace_feedback (trace_id, agent_key, rule_code, verdict, user_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (business_id, trace_id, user_id, verdict) DO NOTHING`,
        [id, r.agent_key, code, b.verdict, t.userId],
      );
      return { ok: true, exceptionId, setting: b.verdict === 'change_rule' ? (r.rule?.setting ?? null) : null };
    }, t.userId);
  }

  /** Customers the owner switched something off for. */
  @Get('exceptions')
  exceptions(@CurrentTenant() t: Tenant) {
    return this.db.withTenant(t.businessId, (tx) =>
      tx.q(
        `SELECT e.id, e.action_code AS rule, e.created_at AS "createdAt", c.id AS "customerId", COALESCE(c.name, c.phone) AS customer
         FROM customer_exceptions e JOIN customers c ON c.id = e.customer_id ORDER BY e.created_at DESC LIMIT 100`,
      ),
    );
  }

  @Roles('owner', 'manager')
  @Delete('exceptions/:id')
  async removeException(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.db.withTenant(t.businessId, (tx) => tx.one(`DELETE FROM customer_exceptions WHERE id = $1 RETURNING id`, [id]));
    if (!r) throw notFound();
    return { ok: true };
  }

  /** Crew → Safety: hold times per action type and "review before sending" per channel. */
  @Get('safety')
  safety(@CurrentTenant() t: Tenant) {
    return this.db.withTenant(t.businessId, async (tx) => {
      const r = await tx.one(
        `SELECT p.hold_seconds, p.review_before_send, (pl.limits->>'maxHoldSeconds')::int AS max FROM business_profiles p JOIN businesses b ON b.id = p.business_id LEFT JOIN plans pl ON pl.id = b.plan_id WHERE p.business_id = app_current_business()`,
      );
      return { holdSeconds: { ...HOLD_DEFAULTS, ...(r?.hold_seconds ?? {}) }, reviewBeforeSend: r?.review_before_send ?? {}, maxSeconds: r?.max ?? HOLD_MAX, channels: REVIEW_CHANNELS };
    });
  }

  @Roles('owner', 'manager')
  @Patch('safety')
  saveSafety(@CurrentTenant() t: Tenant, @Body(new ZodPipe(Safety)) b: z.infer<typeof Safety>) {
    return this.db.withTenant(t.businessId, async (tx) => {
      const before = await snapshot(tx, 'profile', t.businessId);
      const max = (await tx.one(`SELECT (pl.limits->>'maxHoldSeconds')::int AS max FROM businesses b LEFT JOIN plans pl ON pl.id = b.plan_id WHERE b.id = app_current_business()`))?.max ?? HOLD_MAX;
      const hold = { ...HOLD_DEFAULTS, ...(before?.hold_seconds ?? {}) } as Record<string, number>;
      for (const [k, v] of Object.entries(b.holdSeconds ?? {})) if (v !== undefined) hold[k] = Math.min(v, max);
      const review = { ...(before?.review_before_send ?? {}) } as Record<string, boolean>;
      for (const [k, v] of Object.entries(b.reviewBeforeSend ?? {})) if (v !== undefined) review[k] = v;
      await tx.q(`UPDATE business_profiles SET hold_seconds = $1, review_before_send = $2 WHERE business_id = app_current_business()`, [JSON.stringify(hold), JSON.stringify(review)]);
      const after = await snapshot(tx, 'profile', t.businessId);
      await recordVersion(tx, { entity: 'profile', id: t.businessId, label: { key: 'change.safety' }, before, after, by: t.userId });
      return { holdSeconds: hold, reviewBeforeSend: review, maxSeconds: max };
    }, t.userId);
  }

  /** Settings and knowledge changes from the last 24 hours, each undoable. */
  @Get('changes')
  changes(@CurrentTenant() t: Tenant) {
    return this.db.withTenant(t.businessId, (tx) => recentChanges(tx));
  }

  @Roles('owner', 'manager')
  @Post('changes/:id/undo')
  undoChange(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(t.businessId, async (tx) => {
      const r = await revertVersion(tx, id, t.userId);
      liveToBusiness(tx, { type: 'stats.changed' });
      return r;
    }, t.userId);
  }
}

@Global()
@Module({ controllers: [TrustController], providers: [HoldService], exports: [HoldService] })
export class TrustModule {}
