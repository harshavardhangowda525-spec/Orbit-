import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AI_TASK_TYPES, AI_TIERS, resolveRouting } from '@orbit/shared';
import { DbService, type Tx } from '../db/db.service';
import { AdminGuard, ClientIp, CurrentUser } from '../auth/guards';
import type { AuthUser } from '../auth/types';
import { AuditService } from '../audit/audit.service';
import { AiService } from '../ai/ai.service';
import { ZodPipe } from '../common/zod.pipe';
import { badRequest } from '../common/errors';

const Route = z.object({ provider: z.enum(['groq', 'claude']), model: z.string().trim().min(2).max(120) });
const TierCfg = z.object({ routes: z.object({ conversation: Route, command: Route, simple: Route }), fallback: z.array(Route).max(6) });
const RoutingPut = z.object({ free: TierCfg, standard: TierCfg, premium: TierCfg });
const BudgetPut = z.object({ budgetPct: z.number().min(1).max(100), netRevenueFactor: z.number().min(0.3).max(1).optional(), usdInr: z.number().min(10).max(500).optional() });
const MONTH = /^\d{4}-\d{2}$/;

async function setting(tx: Tx, key: string, fallback: number): Promise<number> {
  const r = await tx.one<{ value: unknown }>(`SELECT value FROM platform_settings WHERE key = $1`, [key]);
  const n = Number(r?.value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Admin: AI routing per tier and task (no code changes), the AI cost budget
 * as a share of net revenue, and margins per business, per plan and overall.
 * Provider and model names appear only here, never to businesses.
 */
@UseGuards(AdminGuard)
@Controller('admin/ai')
export class AdminAiController {
  constructor(private readonly db: DbService, private readonly audit: AuditService, private readonly ai: AiService) {}

  @Get('routing')
  async routing() {
    return {
      routing: await this.ai.currentRouting(),
      tiers: AI_TIERS,
      taskTypes: AI_TASK_TYPES,
      providers: { groq: !!process.env.GROQ_API_KEY, claude: !!process.env.ANTHROPIC_API_KEY },
    };
  }

  @Put('routing')
  async putRouting(@CurrentUser() u: AuthUser, @Body(new ZodPipe(RoutingPut)) body: z.infer<typeof RoutingPut>, @ClientIp() ip: string) {
    // A tier must not fall back to a provider that is not set up on this server.
    const ready = { groq: !!process.env.GROQ_API_KEY, claude: !!process.env.ANTHROPIC_API_KEY };
    for (const t of AI_TIERS) {
      const used = [...Object.values(body[t].routes), ...body[t].fallback];
      const missing = used.find((r) => !ready[r.provider]);
      if (missing && process.env.NODE_ENV !== 'test') throw badRequest('provider_not_configured', `${missing.provider} has no API key on this server yet; add it before routing ${t} to it.`);
    }
    const before = await this.ai.currentRouting();
    await this.db.adminTx(async (tx) => {
      await tx.q(
        `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ('ai.routing', $1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [JSON.stringify(body), u.id],
      );
      await this.audit.write({ actorId: u.id, actorKind: 'admin', action: 'admin.ai.routing', entity: 'platform_settings', before, after: body, ip }, tx);
    });
    this.ai.invalidate();
    return { routing: resolveRouting(body) };
  }

  @Get('budget')
  budget() {
    return this.db.adminTx(async (tx) => ({
      budgetPct: await setting(tx, 'ai.budget_pct', 25),
      netRevenueFactor: await setting(tx, 'ai.net_revenue_factor', 0.83),
      usdInr: await setting(tx, 'fx.usd_inr', 84),
    }));
  }

  @Put('budget')
  async putBudget(@CurrentUser() u: AuthUser, @Body(new ZodPipe(BudgetPut)) body: z.infer<typeof BudgetPut>, @ClientIp() ip: string) {
    return this.db.adminTx(async (tx) => {
      const pairs: [string, number | undefined][] = [['ai.budget_pct', body.budgetPct], ['ai.net_revenue_factor', body.netRevenueFactor], ['fx.usd_inr', body.usdInr]];
      for (const [key, value] of pairs) {
        if (value === undefined) continue;
        await tx.q(
          `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [key, JSON.stringify(value), u.id],
        );
      }
      await this.audit.write({ actorId: u.id, actorKind: 'admin', action: 'admin.ai.budget', entity: 'platform_settings', after: body, ip }, tx);
      return { ok: true };
    });
  }

  /**
   * Margins for a month: revenue (Razorpay charges, net of GST and gateway fees by
   * the configured factor), the AI budget at the set %, actual AI cost, and the
   * difference; per business, per plan and overall. Flags businesses over their
   * budget share and plans whose average is over it. The "amount to move" is the
   * month's AI budget (the transfer itself happens at the bank).
   */
  @Get('margins')
  margins(@Query('month') month?: string) {
    return this.db.adminTx(async (tx) => {
      const m = month && MONTH.test(month) ? month : new Date().toISOString().slice(0, 7);
      const pct = await setting(tx, 'ai.budget_pct', 25);
      const factor = await setting(tx, 'ai.net_revenue_factor', 0.83);
      const fx = await setting(tx, 'fx.usd_inr', 84);
      const rows = await tx.q(
        `WITH w AS (SELECT to_date($1, 'YYYY-MM')::timestamptz AS s, (to_date($1, 'YYYY-MM') + interval '1 month')::timestamptz AS e)
         SELECT b.id, b.name, p.code AS plan,
                COALESCE((SELECT sum(c.amount) FROM subscription_charges c, w WHERE c.business_id = b.id AND c.currency = 'INR' AND c.charged_at >= w.s AND c.charged_at < w.e), 0)::float AS gross,
                COALESCE((SELECT sum(a.cost) FROM ai_usage a, w WHERE a.business_id = b.id AND a.created_at >= w.s AND a.created_at < w.e), 0)::float AS cost_usd,
                (SELECT count(DISTINCT a.conversation_id)::int FROM ai_usage a, w WHERE a.business_id = b.id AND a.agent_key IN ('aria', 'vox') AND a.error IS NULL AND a.conversation_id IS NOT NULL AND a.created_at >= w.s AND a.created_at < w.e) AS conversations,
                (SELECT count(*)::int FROM ai_usage a, w WHERE a.business_id = b.id AND a.failover AND a.created_at >= w.s AND a.created_at < w.e) AS failovers
         FROM businesses b JOIN plans p ON p.id = b.plan_id
         ORDER BY b.created_at`,
        [m],
      );
      const round = (n: number) => Math.round(n * 100) / 100;
      const businesses = rows.map((r) => {
        const net = r.gross * factor;
        const budget = (net * pct) / 100;
        const cost = r.cost_usd * fx;
        return {
          id: r.id, name: r.name, plan: r.plan, conversations: r.conversations, failovers: r.failovers,
          revenueGross: round(r.gross), revenueNet: round(net), aiBudget: round(budget), aiCost: round(cost), difference: round(budget - cost),
          overBudget: cost > budget && (r.gross > 0 || cost > 0) && r.plan !== 'free' ? true : false,
        };
      });
      const byPlan = Object.values(
        businesses.reduce<Record<string, any>>((acc, b) => {
          const p = (acc[b.plan] ??= { plan: b.plan, businesses: 0, revenueNet: 0, aiBudget: 0, aiCost: 0 });
          p.businesses++;
          p.revenueNet += b.revenueNet;
          p.aiBudget += b.aiBudget;
          p.aiCost += b.aiCost;
          return acc;
        }, {}),
      ).map((p: any) => ({
        ...p, revenueNet: round(p.revenueNet), aiBudget: round(p.aiBudget), aiCost: round(p.aiCost),
        difference: round(p.aiBudget - p.aiCost), avgAiCost: round(p.aiCost / Math.max(1, p.businesses)),
        overBudget: p.plan !== 'free' && p.aiCost > p.aiBudget,
      }));
      const total = businesses.reduce((t, b) => ({ revenueNet: t.revenueNet + b.revenueNet, aiBudget: t.aiBudget + b.aiBudget, aiCost: t.aiCost + b.aiCost }), { revenueNet: 0, aiBudget: 0, aiCost: 0 });
      const byProvider = await tx.q(
        `SELECT COALESCE(provider, 'unknown') AS provider, model, tier, task_type AS "taskType", count(*)::int AS calls, sum(CASE WHEN error IS NULL THEN 0 ELSE 1 END)::int AS failed,
                sum(input_tokens)::bigint AS "inputTokens", sum(output_tokens)::bigint AS "outputTokens", round((sum(cost) * $2)::numeric, 2)::float AS "costInr"
         FROM ai_usage WHERE created_at >= to_date($1, 'YYYY-MM') AND created_at < to_date($1, 'YYYY-MM') + interval '1 month'
         GROUP BY 1, 2, 3, 4 ORDER BY "costInr" DESC NULLS LAST LIMIT 50`,
        [m, fx],
      );
      return {
        month: m,
        settings: { budgetPct: pct, netRevenueFactor: factor, usdInr: fx },
        total: { revenueNet: round(total.revenueNet), aiBudget: round(total.aiBudget), aiCost: round(total.aiCost), difference: round(total.aiBudget - total.aiCost), costPctOfRevenue: total.revenueNet > 0 ? round((total.aiCost / total.revenueNet) * 100) : null },
        transferToAiAccount: round(total.aiBudget),
        byPlan,
        businesses: businesses.sort((a, b) => b.aiCost - a.aiCost),
        flagged: businesses.filter((b) => b.overBudget).map((b) => b.id),
        byProvider,
      };
    });
  }
}
