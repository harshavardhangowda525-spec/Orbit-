import { Injectable } from '@nestjs/common';
import {
  AVATAR_STYLES,
  DEFAULT_APPEARANCE,
  FESTIVALS,
  THEMES,
  experienceOf,
  festivalOn,
  planFor,
  type Appearance,
  type FestivalKey,
  type MilestoneKey,
  type Perk,
  type PlanExperience,
  type PlanFeatures,
  type Sentence,
  type ThemeKey,
} from '@orbit/shared';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { AppError, badRequest, notFound } from '../common/errors';
import { liveToBusiness } from '../realtime/live';
import { recordVersion, snapshot } from '../trust/versions';

const num = (v: unknown) => Number(v ?? 0);

export const AppearancePatch = z.object({
  theme: z.enum(THEMES).optional(),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  avatarStyle: z.enum(AVATAR_STYLES).optional(),
  festivals: z.array(z.enum(FESTIVALS)).max(FESTIVALS.length).optional(),
});

export interface BridgeSummaryInput {
  moneyToday: number;
  moneyYesterday: number;
  spentYesterday: number;
  bookingsToday: number;
  nextBookingAt: string | null;
  unpaidInvoices: number;
  unpaidAmount: number;
  businessCreatedAt: string;
}

function localDateIso(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '01';
  return `${g('year')}-${g('month')}-${g('day')}`;
}

function normalizeAppearance(raw: Partial<Appearance> | null | undefined): Appearance {
  const theme = raw?.theme && (THEMES as readonly string[]).includes(raw.theme) ? raw.theme : DEFAULT_APPEARANCE.theme;
  const avatarStyle = raw?.avatarStyle && (AVATAR_STYLES as readonly string[]).includes(raw.avatarStyle) ? raw.avatarStyle : DEFAULT_APPEARANCE.avatarStyle;
  const brandColor = typeof raw?.brandColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.brandColor) ? raw.brandColor : null;
  const festivals = Array.isArray(raw?.festivals)
    ? raw.festivals.filter((f): f is FestivalKey => (FESTIVALS as readonly string[]).includes(f))
    : DEFAULT_APPEARANCE.festivals;
  return { theme, brandColor, avatarStyle, festivals };
}

@Injectable()
export class ExperienceService {
  constructor(private readonly db: DbService) {}

  async get(businessId: string, now = new Date()) {
    return this.db.withTenant(businessId, async (tx) => {
      const biz = await tx.one(`SELECT id, timezone, currency, created_at FROM businesses WHERE id = $1`, [businessId]);
      if (!biz) throw notFound();
      const s = await tx.one(
        `WITH b AS (SELECT (date_trunc('day', $1::timestamptz AT TIME ZONE $2) AT TIME ZONE $2) AS start)
         SELECT
           (SELECT count(*) FROM bookings, b WHERE start_at >= b.start AND start_at < b.start + interval '1 day' AND status <> 'cancelled' AND deleted_at IS NULL) AS bookings_today,
           (SELECT COALESCE(sum(amount), 0) FROM payments, b WHERE status = 'paid' AND paid_at >= b.start AND paid_at < b.start + interval '1 day')
             + (SELECT COALESCE(sum(amount), 0) FROM revenue_entries WHERE deleted_at IS NULL AND entry_date = ($1::timestamptz AT TIME ZONE $2)::date) AS money_today,
           (SELECT COALESCE(sum(amount), 0) FROM payments, b WHERE status = 'paid' AND paid_at >= b.start - interval '1 day' AND paid_at < b.start)
             + (SELECT COALESCE(sum(amount), 0) FROM revenue_entries WHERE deleted_at IS NULL AND entry_date = ($1::timestamptz AT TIME ZONE $2)::date - 1) AS money_yesterday,
           (SELECT COALESCE(sum(total), 0) FROM expenses WHERE status = 'confirmed' AND (created_at AT TIME ZONE $2)::date = ($1::timestamptz AT TIME ZONE $2)::date - 1) AS spent_yesterday,
           (SELECT count(*) FROM invoices WHERE status IN ('sent', 'overdue')) AS unpaid_invoices,
           (SELECT COALESCE(sum(total), 0) FROM invoices WHERE status IN ('sent', 'overdue')) AS unpaid_amount,
           (SELECT min(start_at) FROM bookings, b WHERE start_at >= GREATEST(b.start, $1::timestamptz) AND start_at < b.start + interval '1 day' AND status IN ('pending', 'confirmed') AND deleted_at IS NULL) AS next_booking_at`,
        [now.toISOString(), biz.timezone],
      );
      return this.forBridge(tx, businessId, now, biz.timezone, biz.currency, {
        moneyToday: num(s.money_today),
        moneyYesterday: num(s.money_yesterday),
        spentYesterday: num(s.spent_yesterday),
        bookingsToday: num(s.bookings_today),
        nextBookingAt: s.next_booking_at ? new Date(s.next_booking_at).toISOString() : null,
        unpaidInvoices: num(s.unpaid_invoices),
        unpaidAmount: num(s.unpaid_amount),
        businessCreatedAt: new Date(biz.created_at).toISOString(),
      });
    });
  }

  /** Everything the UI needs for plan identity, themes, upgrade/downgrade moments, daily delight and milestones. */
  async forBridge(tx: Tx, businessId: string, now: Date, tz: string, currency: string, summary: BridgeSummaryInput) {
    const planRow = await tx.one<{ code: string; name: string; sort_order: number; limits: Record<string, any>; features: PlanFeatures }>(
      `SELECT p.code, p.name, p.sort_order, p.limits, p.features FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.id = app_current_business()`,
    );
    const planRows = await tx.q<{ code: string; name: string; sort_order: number; limits: Record<string, any>; features: PlanFeatures }>(
      `SELECT code, name, sort_order, limits, features FROM plans WHERE active ORDER BY sort_order`,
    );
    const allPlans = planRows.map((p) => ({
      code: p.code,
      name: p.name,
      sortOrder: Number(p.sort_order),
      agents: (p.features?.agents ?? []) as string[],
      experience: experienceOf(p.code, p.features?.experience),
    }));
    const currentCode = planRow?.code ?? 'free';
    const currentName = planRow?.name ?? 'Free';
    const exp = experienceOf(currentCode, planRow?.features?.experience);
    const hasPerk = (p: Perk) => exp.perks.includes(p);
    const whiteLabel = hasPerk('whiteLabel') || !!planRow?.features?.whiteLabel;

    // Appearance (with safe fallback to 'space' if downgraded below the stored theme).
    const prof = await tx.one<{ appearance: Partial<Appearance> | null }>(`SELECT appearance FROM business_profiles LIMIT 1`);
    const stored = normalizeAppearance(prof?.appearance);
    const themeAllowed = exp.themes.includes(stored.theme);
    const effectiveTheme: ThemeKey = themeAllowed ? stored.theme : 'space';
    const effectiveAvatar = hasPerk('avatarStyles') ? stored.avatarStyle : 'initials';
    const effectiveBrandColor = hasPerk('brandColor') ? stored.brandColor : null;
    const todayLocal = localDateIso(now, tz);
    const activeFestival = effectiveTheme === 'festive' ? festivalOn(todayLocal, stored.festivals) : null;

    // Business branches for the 4th outer ring (constellation).
    const locations = hasPerk('constellation')
      ? await tx.q<{ id: string; name: string }>(`SELECT id, name FROM locations WHERE deleted_at IS NULL ORDER BY created_at LIMIT 8`)
      : [];

    // Dedicated Success Manager (read from platform_settings, Business+).
    let successManager: { name: string; role?: string; phone?: string; whatsapp?: string; email?: string } | null = null;
    if (hasPerk('successManager')) {
      const sm = await tx.one<{ value: any }>(`SELECT value FROM platform_settings WHERE key = 'support.success_manager'`);
      if (sm?.value && typeof sm.value === 'object' && sm.value.name) {
        successManager = sm.value;
      }
    }

    // Latest plan change (only the most recent change counts: unseen, or an active upgrade within 7 days).
    const latestPc = await tx.one<{ id: string; from_plan: string | null; to_plan: string; direction: 'up' | 'down' | 'same'; ticks: string[]; seen_at: string | null; created_at: string }>(
      `SELECT id, from_plan, to_plan, direction, ticks, seen_at, created_at FROM plan_changes ORDER BY created_at DESC LIMIT 1`,
    );
    const within7d = latestPc ? now.getTime() - new Date(latestPc.created_at).getTime() <= 7 * 86_400_000 : false;
    const pc = latestPc && (!latestPc.seen_at || (latestPc.direction === 'up' && within7d && latestPc.to_plan === currentCode)) ? latestPc : null;
    const planChange = pc ? this.buildPlanChange(pc, planRows, exp, stored, themeAllowed, whiteLabel) : null;

    // Weekly Wins card (Plus+).
    const wins = hasPerk('winsCard') ? await this.computeWins(tx, now, tz, currency, whiteLabel) : null;

    // Morning Story (Pro+).
    const morningStory = hasPerk('morningStory') ? await this.computeMorningStory(tx, tz, currency, summary) : null;

    // Milestones (Plus+).
    const milestones = hasPerk('milestones') ? await this.computeMilestones(tx, now, summary.businessCreatedAt, currency) : { unseen: null, reached: [] };

    return {
      plan: { code: currentCode, name: currentName, experience: exp, whiteLabel },
      allPlans: allPlans.map(({ code, name, sortOrder, experience }) => ({ code, name, sortOrder, experience })),
      appearance: {
        ...stored,
        effectiveTheme,
        effectiveAvatar,
        effectiveBrandColor,
        themeReset: !themeAllowed && stored.theme !== 'space',
        activeFestival,
      },
      locations,
      successManager,
      planChange,
      wins,
      morningStory,
      milestones,
    };
  }

  private buildPlanChange(
    pc: { id: string; from_plan: string | null; to_plan: string; direction: 'up' | 'down' | 'same'; ticks: string[]; seen_at: string | null; created_at: string },
    planRows: { code: string; name: string; limits: Record<string, any>; features: PlanFeatures }[],
    toExp: PlanExperience,
    appearance: Appearance,
    themeAllowed: boolean,
    whiteLabel: boolean,
  ) {
    const fromRow = planRows.find((p) => p.code === pc.from_plan);
    const toRow = planRows.find((p) => p.code === pc.to_plan);
    const fromAgents = new Set((fromRow?.features?.agents ?? ['orbit', 'aria', 'khata']).filter((a) => a !== 'orbit'));
    const toAgents = (toRow?.features?.agents ?? []).filter((a) => a !== 'orbit');
    const newAgents = toAgents.filter((a) => !fromAgents.has(a));
    const pausedAgents = [...fromAgents].filter((a) => !toAgents.includes(a));
    const ticks = Array.isArray(pc.ticks) ? pc.ticks : [];

    // 3 highlight lines for the upgrade celebration.
    const highlights: Sentence[] = [];
    if (pc.direction === 'up') {
      if (newAgents.length) {
        highlights.push({ key: 'exp.upgrade.hl_agents', params: { agents: newAgents.map((a) => a[0].toUpperCase() + a.slice(1)).join(', ') } });
      }
      const aiMonth = toRow?.limits?.aiConversationsPerMonth;
      if (aiMonth == null && toRow?.limits?.aiConversationsPerDay == null) {
        highlights.push({ key: 'exp.upgrade.hl_ai_unlimited' });
      } else if (aiMonth) {
        highlights.push({ key: 'exp.upgrade.hl_ai', params: { n: Number(aiMonth) } });
      }
      if (whiteLabel) highlights.push({ key: 'exp.upgrade.hl_wl' });
      else if (toExp.perks.includes('constellation')) highlights.push({ key: 'exp.upgrade.hl_business' });
      else if (toExp.perks.includes('morningStory')) highlights.push({ key: 'exp.upgrade.hl_delight' });
      else highlights.push({ key: 'exp.upgrade.hl_themes' });
    }

    // 7-day "What's new for you" checklist items (ticked off as features are actually used).
    const checklist: { key: string; label: Sentence; done: boolean; action: 'details' | 'crew' | 'story' | 'report' | 'wins' }[] = [];
    if (pc.direction === 'up') {
      if (toExp.themes.length > 2) {
        checklist.push({ key: 'try_theme', label: { key: 'exp.whatsnew.try_theme' }, done: ticks.includes('try_theme') || appearance.theme !== 'space', action: 'details' });
      }
      if (newAgents.length) {
        checklist.push({ key: 'try_crew', label: { key: 'exp.whatsnew.try_crew' }, done: ticks.includes('try_crew'), action: 'crew' });
      }
      if (toExp.perks.includes('morningStory')) {
        checklist.push({ key: 'try_story', label: { key: 'exp.whatsnew.try_story' }, done: ticks.includes('try_story'), action: 'story' });
      } else if (toExp.perks.includes('winsCard')) {
        checklist.push({ key: 'try_wins', label: { key: 'exp.whatsnew.try_wins' }, done: ticks.includes('try_wins'), action: 'wins' });
      }
      if (toExp.perks.includes('avatarStyles')) {
        checklist.push({ key: 'try_avatar', label: { key: 'exp.whatsnew.try_avatar' }, done: ticks.includes('try_avatar') || appearance.avatarStyle !== 'initials', action: 'details' });
      }
      if (toExp.perks.includes('brandColor')) {
        checklist.push({ key: 'try_brand', label: { key: 'exp.whatsnew.try_brand' }, done: ticks.includes('try_brand') || !!appearance.brandColor, action: 'details' });
      }
      if (toExp.perks.includes('magazineReport')) {
        checklist.push({ key: 'try_report', label: { key: 'exp.whatsnew.try_report' }, done: ticks.includes('try_report'), action: 'report' });
      }
    }

    return {
      id: pc.id,
      fromPlan: pc.from_plan,
      toPlan: pc.to_plan,
      toPlanName: toRow?.name ?? pc.to_plan,
      direction: pc.direction,
      seenAt: pc.seen_at,
      createdAt: pc.created_at,
      newAgents,
      pausedAgents,
      themeReset: pc.direction === 'down' && !themeAllowed && appearance.theme !== 'space',
      highlights: highlights.slice(0, 3),
      checklist: checklist.slice(0, 4),
    };
  }

  private async computeWins(tx: Tx, now: Date, tz: string, currency: string, whiteLabel: boolean) {
    const r = await tx.one(
      `WITH w AS (SELECT $1::timestamptz - interval '7 days' AS since)
       SELECT
         (SELECT count(*)::int FROM bookings, w WHERE created_at >= w.since AND status <> 'cancelled' AND deleted_at IS NULL) AS bookings,
         (SELECT COALESCE(sum(amount), 0) FROM payments, w WHERE status = 'paid' AND paid_at >= w.since)
           + (SELECT COALESCE(sum(amount), 0) FROM revenue_entries WHERE deleted_at IS NULL AND entry_date >= ($1::timestamptz AT TIME ZONE $2)::date - 7) AS money,
         (SELECT COALESCE(sum(minutes_saved), 0) FROM feed_events, w WHERE at >= w.since) AS minutes,
         (SELECT count(*)::int FROM messages, w WHERE direction = 'out' AND sender IN ('aria', 'vox') AND created_at >= w.since) AS replies`,
      [now.toISOString(), tz],
    );
    const money = num(r?.money);
    const bookings = num(r?.bookings);
    const hours = Math.round((num(r?.minutes) / 60) * 10) / 10;
    const replies = num(r?.replies);
    const titleKey = whiteLabel ? 'exp.wins.title' : 'exp.wins.orbit_title';
    if (money > 0) return { titleKey, kind: 'money' as const, value: money, currency, sentence: { key: 'exp.wins.money', params: { amount: `~m:${currency}:${money}` } } };
    if (bookings > 0) return { titleKey, kind: 'bookings' as const, value: bookings, currency, sentence: { key: 'exp.wins.bookings', params: { count: bookings } } };
    if (hours > 0) return { titleKey, kind: 'hours' as const, value: hours, currency, sentence: { key: 'exp.wins.hours', params: { hours } } };
    if (replies > 0) return { titleKey, kind: 'messages' as const, value: replies, currency, sentence: { key: 'exp.wins.messages', params: { count: replies } } };
    return { titleKey, kind: 'empty' as const, value: 0, currency, sentence: { key: 'exp.wins.ready' } };
  }

  private async computeMorningStory(tx: Tx, _tz: string, currency: string, summary: BridgeSummaryInput) {
    const moment = await tx.one<{ agent_key: string; sentence: Sentence; value_amount: number }>(
      `SELECT agent_key, sentence, COALESCE(value_amount, 0) AS value_amount
       FROM feed_events WHERE agent_key <> 'orbit' AND event_type NOT IN ('business_created', 'business_live')
       ORDER BY (at > now() - interval '2 days') DESC, COALESCE(value_amount, 0) DESC, at DESC LIMIT 1`,
    );
    const suggestion: Sentence = summary.unpaidInvoices > 0
      ? { key: 'exp.story.tip_unpaid', params: { count: summary.unpaidInvoices, amount: `~m:${currency}:${summary.unpaidAmount}` } }
      : summary.bookingsToday < 3
      ? { key: 'exp.story.tip_slots' }
      : { key: 'exp.story.tip_steady' };
    return {
      currency,
      yesterdayMoney: summary.moneyYesterday,
      yesterdaySpent: summary.spentYesterday,
      yesterdayNet: summary.moneyYesterday - summary.spentYesterday,
      bookingsToday: summary.bookingsToday,
      nextBookingAt: summary.nextBookingAt,
      bestMoment: moment ? { agent: moment.agent_key, sentence: moment.sentence } : null,
      suggestion,
    };
  }

  private async computeMilestones(tx: Tx, now: Date, createdAt: string, currency: string) {
    const stats = await tx.one(
      `SELECT
         (SELECT count(*)::int FROM bookings WHERE status <> 'cancelled' AND deleted_at IS NULL) AS bookings,
         (SELECT COALESCE(sum(amount), 0) FROM payments WHERE status = 'paid') AS earned`,
    );
    const bookings = num(stats?.bookings);
    const earned = num(stats?.earned);
    const ageDays = (now.getTime() - new Date(createdAt).getTime()) / 86_400_000;

    const checks: { key: MilestoneKey; ok: boolean; value: number }[] = [
      { key: 'bookings_100', ok: bookings >= 100, value: bookings },
      { key: 'bookings_1000', ok: bookings >= 1000, value: bookings },
      { key: 'earned_1lakh', ok: earned >= 100_000, value: earned },
      { key: 'earned_10lakh', ok: earned >= 1_000_000, value: earned },
      { key: 'year_1', ok: ageDays >= 365, value: 1 },
    ];
    for (const c of checks) {
      if (c.ok) {
        await tx.q(
          `INSERT INTO milestones (key, value) VALUES ($1, $2) ON CONFLICT (business_id, key) DO NOTHING`,
          [c.key, c.value],
        );
      }
    }
    const rows = await tx.q<{ id: string; key: MilestoneKey; value: number | null; reached_at: string; seen_at: string | null }>(
      `SELECT id, key, value::float AS value, reached_at, seen_at FROM milestones ORDER BY reached_at DESC`,
    );
    const formatted = rows.map((r) => ({ id: r.id, key: r.key, value: r.value, reachedAt: r.reached_at, seenAt: r.seen_at, currency }));
    return {
      unseen: formatted.find((r) => !r.seenAt) ?? null,
      reached: formatted,
    };
  }

  async updateAppearance(businessId: string, userId: string, raw: unknown) {
    const parsed = AppearancePatch.safeParse(raw);
    if (!parsed.success) throw badRequest('invalid_input', 'Please choose a valid theme or colour.');
    return this.db.withTenant(businessId, async (tx) => {
      const planRow = await tx.one<{ code: string; features: PlanFeatures }>(
        `SELECT p.code, p.features FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.id = app_current_business()`,
      );
      const exp = experienceOf(planRow?.code ?? 'free', planRow?.features?.experience);
      const d = parsed.data;
      if (d.theme && !exp.themes.includes(d.theme)) {
        throw new AppError(403, 'plan_locked', 'That theme is available on a higher plan.');
      }
      if (d.brandColor && !exp.perks.includes('brandColor')) {
        throw new AppError(403, 'plan_locked', 'Custom brand colour is available on Business.');
      }
      if (d.avatarStyle && d.avatarStyle !== 'initials' && !exp.perks.includes('avatarStyles')) {
        throw new AppError(403, 'plan_locked', 'Crew avatar styles are available on Pro and up.');
      }
      const before = await snapshot(tx, 'appearance', businessId);
      const cur = normalizeAppearance(before?.appearance);
      const next: Appearance = {
        theme: d.theme ?? cur.theme,
        brandColor: d.brandColor !== undefined ? d.brandColor : cur.brandColor,
        avatarStyle: d.avatarStyle ?? cur.avatarStyle,
        festivals: d.festivals ?? cur.festivals,
      };
      await tx.q(`UPDATE business_profiles SET appearance = $1, updated_at = now() WHERE business_id = app_current_business()`, [JSON.stringify(next)]);
      await recordVersion(tx, {
        entity: 'appearance',
        id: businessId,
        label: { key: 'change.appearance' },
        before: before ? { appearance: cur } : null,
        after: { appearance: next },
        by: userId,
      });
      // Auto-tick upgrade checklist items if applicable.
      const autoTicks: string[] = [];
      if (d.theme && d.theme !== 'space') autoTicks.push('try_theme');
      if (d.brandColor) autoTicks.push('try_brand');
      if (d.avatarStyle && d.avatarStyle !== 'initials') autoTicks.push('try_avatar');
      if (autoTicks.length) {
        const pc = await tx.one<{ id: string; ticks: string[] }>(
          `SELECT id, ticks FROM plan_changes WHERE direction = 'up' AND created_at > now() - interval '7 days' ORDER BY created_at DESC LIMIT 1`,
        );
        if (pc) {
          const merged = Array.from(new Set([...(Array.isArray(pc.ticks) ? pc.ticks : []), ...autoTicks]));
          await tx.q(`UPDATE plan_changes SET ticks = $2 WHERE id = $1`, [pc.id, JSON.stringify(merged)]);
        }
      }
      liveToBusiness(tx, { type: 'stats.changed' });
      return { ok: true, appearance: next };
    }, userId);
  }

  async markPlanChangeSeen(businessId: string, id: string) {
    return this.db.withTenant(businessId, async (tx) => {
      const r = await tx.one(`UPDATE plan_changes SET seen_at = COALESCE(seen_at, now()) WHERE id = $1 RETURNING id`, [id]);
      if (!r) throw notFound();
      return { ok: true };
    });
  }

  async tickChecklist(businessId: string, id: string, item: string) {
    if (!/^[a-z0-9_]{2,40}$/.test(item)) throw badRequest('invalid_input', 'Invalid checklist item.');
    return this.db.withTenant(businessId, async (tx) => {
      const pc = await tx.one<{ id: string; ticks: string[] }>(`SELECT id, ticks FROM plan_changes WHERE id = $1 FOR UPDATE`, [id]);
      if (!pc) throw notFound();
      const ticks = Array.from(new Set([...(Array.isArray(pc.ticks) ? pc.ticks : []), item]));
      await tx.q(`UPDATE plan_changes SET ticks = $2 WHERE id = $1`, [id, JSON.stringify(ticks)]);
      return { ok: true, ticks };
    });
  }

  async markMilestoneSeen(businessId: string, id: string) {
    return this.db.withTenant(businessId, async (tx) => {
      const r = await tx.one(`UPDATE milestones SET seen_at = COALESCE(seen_at, now()) WHERE id = $1 RETURNING id`, [id]);
      if (!r) throw notFound();
      return { ok: true };
    });
  }

  /** Monthly magazine-style Business Report (Business+). */
  async monthlyReport(businessId: string, month?: string) {
    return this.db.withTenant(businessId, async (tx) => {
      const biz = await tx.one<{ name: string; timezone: string; currency: string; plan_code: string; features: PlanFeatures }>(
        `SELECT b.name, b.timezone, b.currency, p.code AS plan_code, p.features FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.id = app_current_business()`,
      );
      if (!biz) throw notFound();
      const exp = experienceOf(biz.plan_code, biz.features?.experience);
      if (!exp.perks.includes('magazineReport')) {
        throw new AppError(403, 'plan_locked', 'Monthly Business Report is available on Business and up.');
      }
      const m = month && /^\d{4}-\d{2}$/.test(month) ? month : localDateIso(new Date(), biz.timezone).slice(0, 7);
      const start = `${m}-01`;
      const s = await tx.one(
        `WITH rng AS (
           SELECT ($1::date::timestamp AT TIME ZONE $2) AS s, (($1::date + interval '1 month')::timestamp AT TIME ZONE $2) AS e
         )
         SELECT
           (SELECT COALESCE(sum(amount), 0) FROM payments, rng WHERE status = 'paid' AND paid_at >= rng.s AND paid_at < rng.e)
             + (SELECT COALESCE(sum(amount), 0) FROM revenue_entries WHERE deleted_at IS NULL AND entry_date >= $1::date AND entry_date < ($1::date + interval '1 month')::date) AS revenue,
           (SELECT COALESCE(sum(total), 0) FROM expenses WHERE status = 'confirmed' AND COALESCE(books_month, to_char(created_at AT TIME ZONE $2, 'YYYY-MM')) = $3) AS expenses,
           (SELECT count(*)::int FROM bookings, rng WHERE start_at >= rng.s AND start_at < rng.e AND status <> 'cancelled' AND deleted_at IS NULL) AS bookings,
           (SELECT count(DISTINCT customer_id)::int FROM bookings, rng WHERE start_at >= rng.s AND start_at < rng.e AND status <> 'cancelled' AND deleted_at IS NULL) AS customers`,
        [start, biz.timezone, m],
      );
      const topServices = await tx.q<{ name: string; count: number; revenue: number }>(
        `WITH rng AS (
           SELECT ($1::date::timestamp AT TIME ZONE $2) AS s, (($1::date + interval '1 month')::timestamp AT TIME ZONE $2) AS e
         )
         SELECT s.name, count(*)::int AS count, COALESCE(sum(s.price), 0)::float AS revenue
         FROM bookings b JOIN services s ON s.id = b.service_id, rng
         WHERE b.start_at >= rng.s AND b.start_at < rng.e AND b.status <> 'cancelled' AND b.deleted_at IS NULL
         GROUP BY s.name ORDER BY count DESC, revenue DESC LIMIT 5`,
        [start, biz.timezone],
      );
      const crew = await tx.q<{ agent: string; name: string; value: number; minutes: number }>(
        `WITH rng AS (
           SELECT ($1::date::timestamp AT TIME ZONE $2) AS s, (($1::date + interval '1 month')::timestamp AT TIME ZONE $2) AS e
         )
         SELECT f.agent_key AS agent, COALESCE(a.display_name, f.agent_key) AS name, COALESCE(sum(f.value_amount), 0)::float AS value, COALESCE(sum(f.minutes_saved), 0)::int AS minutes
         FROM feed_events f LEFT JOIN agents a ON a.agent_key = f.agent_key, rng
         WHERE f.at >= rng.s AND f.at < rng.e AND f.agent_key <> 'orbit'
         GROUP BY f.agent_key, a.display_name ORDER BY value DESC, minutes DESC`,
        [start, biz.timezone],
      );
      const revenue = num(s?.revenue);
      const expenses = num(s?.expenses);
      return {
        month: m,
        businessName: biz.name,
        currency: biz.currency,
        whiteLabel: exp.perks.includes('whiteLabel') || !!biz.features?.whiteLabel,
        revenue,
        expenses,
        profit: revenue - expenses,
        bookings: num(s?.bookings),
        customers: num(s?.customers),
        topServices,
        crew,
        hoursSaved: Math.round((crew.reduce((a, c) => a + c.minutes, 0) / 60) * 10) / 10,
      };
    });
  }

  /** Friendly preview for a locked feature, built from the business's real data. */
  async featurePreview(businessId: string, feature: string) {
    return this.db.withTenant(businessId, async (tx) => {
      const biz = await tx.one<{ currency: string; timezone: string }>(`SELECT currency, timezone FROM businesses WHERE id = app_current_business()`);
      if (!biz) throw notFound();
      const plans = await tx.q<{ code: string; name: string; sort_order: number; features: PlanFeatures }>(`SELECT code, name, sort_order, features FROM plans WHERE active ORDER BY sort_order`);
      const expPlans = plans.map((p) => ({ code: p.code, name: p.name, sortOrder: Number(p.sort_order), experience: experienceOf(p.code, p.features?.experience) }));
      const stats = await tx.one(
        `SELECT
           (SELECT count(*)::int FROM bookings WHERE created_at > now() - interval '7 days' AND status <> 'cancelled' AND deleted_at IS NULL) AS week_bookings,
           (SELECT count(*)::int FROM bookings WHERE start_at >= now() AND status <> 'cancelled' AND deleted_at IS NULL) AS upcoming_bookings,
           (SELECT count(*)::int FROM customers WHERE deleted_at IS NULL) AS customers,
           (SELECT count(*)::int FROM services WHERE active AND deleted_at IS NULL) AS services,
           (SELECT COALESCE(sum(amount), 0) FROM payments WHERE status = 'paid' AND paid_at > now() - interval '30 days') AS month_money`,
      );
      const agentPlan = (agent: string) => {
        const p = plans.find((x) => x.code !== 'enterprise' && (x.features?.agents ?? []).includes(agent as any));
        return p ? { code: p.code, name: p.name } : { code: 'pro', name: 'Pro' };
      };
      const cur = biz.currency;
      if (['vox', 'spark', 'nudge', 'ledger'].includes(feature)) {
        const plan = agentPlan(feature);
        const count = feature === 'vox' ? num(stats?.week_bookings) : feature === 'spark' ? num(stats?.customers) : feature === 'nudge' ? num(stats?.upcoming_bookings) : num(stats?.services);
        return {
          feature,
          plan,
          headline: { key: `exp.lock.${feature}_headline` } as Sentence,
          body: { key: `exp.lock.${feature}_body`, params: { count } } as Sentence,
        };
      }
      if (feature === 'morningStory') {
        const plan = planFor(expPlans, 'morningStory') ?? { code: 'pro', name: 'Pro' };
        return {
          feature,
          plan,
          headline: { key: 'exp.lock.story_headline' } as Sentence,
          body: { key: 'exp.lock.story_body', params: { amount: `~m:${cur}:${num(stats?.month_money)}`, count: num(stats?.upcoming_bookings) } } as Sentence,
        };
      }
      if (feature === 'magazineReport') {
        const plan = planFor(expPlans, 'magazineReport') ?? { code: 'business', name: 'Business' };
        return {
          feature,
          plan,
          headline: { key: 'exp.lock.report_headline' } as Sentence,
          body: { key: 'exp.lock.report_body', params: { amount: `~m:${cur}:${num(stats?.month_money)}`, count: num(stats?.week_bookings) } } as Sentence,
        };
      }
      const plan = (THEMES as readonly string[]).includes(feature)
        ? planFor(expPlans, feature as ThemeKey)
        : planFor(expPlans, feature as Perk);
      const target = plan ?? { code: 'pro', name: 'Pro' };
      return {
        feature,
        plan: target,
        headline: { key: 'exp.lock.theme_headline' } as Sentence,
        body: { key: 'exp.lock.theme_body', params: { plan: target.name } } as Sentence,
      };
    });
  }
}
