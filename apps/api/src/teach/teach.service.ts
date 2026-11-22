import { Injectable, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import {
  OWNER_ONLY_TEACH, TEACH_PROFILE_FIELDS, WEEKDAYS, addDays, hoursOn, localParts, translate, weekdayOf,
  type Sentence, type TeachAffected, type TeachAffectedChoice, type TeachChange, type TeachPreview, type TeachPreviewLine, type WeeklyHours, type Weekday,
} from '@orbit/shared';
import { DbService, type Tx } from '../db/db.service';
import { AiService } from '../ai/ai.service';
import { JobsService } from '../jobs/jobs.service';
import { HoldService } from '../trust/hold.service';
import { badRequest, notFound } from '../common/errors';
import { postFeed } from '../common/feed';
import { liveToBusiness } from '../realtime/live';
import { agentName, fact, firstName } from '../trust/trace';
import { recordVersion, revertVersion, snapshot } from '../trust/versions';
import { jsonFrom } from '../snap/snap.service';
import { logger } from '../logger';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/);
const text = (max: number) => z.string().trim().min(1).max(max);
const Change = z.discriminatedUnion('type', [
  z.object({ type: z.literal('update_hours'), days: z.array(z.enum(WEEKDAYS)).min(1).max(7), ranges: z.array(z.object({ from: hhmm, to: hhmm })).max(4), from: date.nullable().default(null) }),
  z.object({ type: z.literal('add_closure'), from: date, to: date.nullable().optional(), reason: z.string().trim().max(120).nullable().optional() }),
  z.object({ type: z.literal('update_service'), service: text(120), price: z.number().nonnegative().max(10_000_000).nullable().optional(), durationMin: z.number().int().min(0).max(1440).nullable().optional(), active: z.boolean().nullable().optional() }),
  z.object({ type: z.literal('add_service'), name: text(120), price: z.number().nonnegative().max(10_000_000).nullable(), durationMin: z.number().int().min(0).max(1440).default(30) }),
  z.object({ type: z.literal('remove_service'), service: text(120) }),
  z.object({ type: z.literal('staff_leave'), staff: text(80), from: date, to: date.nullable().optional() }),
  z.object({ type: z.literal('add_faq'), question: text(300), answer: text(2000) }),
  z.object({ type: z.literal('update_policy'), title: text(120), content: text(2000) }),
  z.object({ type: z.literal('update_profile'), field: z.enum(TEACH_PROFILE_FIELDS), value: text(500) }),
  z.object({ type: z.literal('set_rule'), maxDiscountPct: z.number().min(0).max(100) }),
]);
const Parsed = z.object({
  kind: z.enum(['teach', 'question', 'not_teach']),
  question: z.string().trim().max(300).nullable().optional(),
  changes: z.array(z.unknown()).max(12).default([]),
});

/** What the AI is told. The JSON shape is strict; dates are always resolved to YYYY-MM-DD here, never left relative. */
function teachPrompt(c: Ctx) {
  return `KIND: teach
You turn one instruction from the owner of ${c.name} (a ${c.type.replace(/_/g, ' ')}) into changes to the business's information. The owner may write in English, Hindi, Kannada or a mix.
TODAY: ${c.today} (${c.weekday}). Time zone ${c.tz}. "Next week" starts on the coming Monday. Resolve every date to YYYY-MM-DD in this time zone.
Opening hours now: ${WEEKDAYS.map((d) => `${d} ${hoursText(c.hours, d)}`).join('; ')}.
Services: ${c.services.map((s) => `${s.name} (${s.price == null ? 'price on request' : s.price}, ${s.duration_min} min)`).join('; ') || 'none'}.
Team: ${c.staff.map((s) => s.name).join(', ') || 'none'}.

Reply with JSON only:
{"kind": "teach" | "question" | "not_teach", "question": string|null, "changes": [ ... ]}
- "not_teach": the message is not a change to the business's information (a question, a task, small talk).
- "question": you cannot tell exactly what to change (e.g. which day, which service, what time). Ask ONE short question in the owner's language, changes = [].
- "teach": list every change. Allowed changes (use exactly these fields):
  {"type":"update_hours","days":["mon".."sun"],"ranges":[{"from":"HH:MM","to":"HH:MM"}],"from":"YYYY-MM-DD"|null}   ranges [] = closed that day; from = the first date it applies (null = from today)
  {"type":"add_closure","from":"YYYY-MM-DD","to":"YYYY-MM-DD"|null,"reason":string|null}   closed on a date or dates (holiday, event)
  {"type":"update_service","service":"exact service name","price":number|null,"durationMin":number|null,"active":boolean|null}   only the fields that change
  {"type":"add_service","name":string,"price":number|null,"durationMin":number}
  {"type":"remove_service","service":"exact service name"}
  {"type":"staff_leave","staff":"exact team member name","from":"YYYY-MM-DD","to":"YYYY-MM-DD"|null}
  {"type":"add_faq","question":string,"answer":string}   something customers ask (parking, payment methods, what to bring)
  {"type":"update_policy","title":string,"content":string}   cancellation, late arrival, refunds, deposits
  {"type":"update_profile","field":"phone|whatsapp|website|address|description|instagram|facebook","value":string}
  {"type":"set_rule","maxDiscountPct":number}   the most discount the front desk may ever offer
Never invent a price, time or date the owner did not say.`;
}

interface Ctx {
  name: string; type: string; tz: string; currency: string; today: string; weekday: Weekday;
  hours: WeeklyHours; holidays: { date: string; reason?: string | null }[]; hoursChanges: { from: string; hours: WeeklyHours }[];
  guardrails: { maxDiscountPct?: number }; social: Record<string, string>; profile: Record<string, string | null>;
  services: { id: string; name: string; price: number | null; duration_min: number; active: boolean }[];
  staff: { id: string; name: string; leave: { from: string; to: string }[] }[];
}

const norm = (s: string) => s.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function hoursText(h: WeeklyHours | undefined, d: Weekday) {
  const day = h?.[d];
  return day?.open && day.ranges.length ? day.ranges.map((r) => `${r.from}–${r.to}`).join(', ') : 'closed';
}
const hoursParam = (h: WeeklyHours | undefined, d: Weekday) => {
  const t = hoursText(h, d);
  return t === 'closed' ? '@teach.closed' : t;
};
/** Find a service or team member by the name the owner used (exact, then starts-with, then contains). */
function byName<T extends { name: string }>(rows: T[], name: string): T | null {
  const n = norm(name);
  return rows.find((r) => norm(r.name) === n) ?? rows.find((r) => norm(r.name).startsWith(n) || n.startsWith(norm(r.name))) ?? rows.find((r) => norm(r.name).includes(n)) ?? null;
}
const dateRange = (from: string, to: string | null | undefined) => {
  const out: string[] = [];
  for (let d = from; d <= (to ?? from) && out.length < 62; d = addDays(d, 1)) out.push(d);
  return out;
};
const inRanges = (time: string, end: string, ranges: { from: string; to: string }[]) => ranges.some((r) => r.from <= time && end <= r.to);

/**
 * Teach Orbit by talking. The owner says what changed; Orbit shows exactly what
 * will change (and which bookings that touches) and only saves it when the owner
 * confirms. Every change is a field version, so the whole teach can be undone for
 * 24 hours. Staff can teach FAQs and leave; price and rule changes wait for the owner.
 */
@Injectable()
export class TeachService implements OnModuleInit {
  constructor(private readonly db: DbService, private readonly ai: AiService, private readonly jobs: JobsService, private readonly hold: HoldService) {}

  onModuleInit() {
    // Hours that start on a later date become the regular hours on that date.
    this.jobs.register('teach.hours', () => this.applyDueHours());
  }

  async teach(businessId: string, userId: string, role: string, input: { text: string; source?: 'app' | 'voice' | 'knowledge' | 'whatsapp'; language?: string }, now = new Date()): Promise<TeachPreview> {
    const ctx = await this.db.withTenant(businessId, (tx) => this.context(tx, now));
    let parsed: z.infer<typeof Parsed>;
    try {
      const res = await this.ai.complete(businessId, 'orbit', { system: teachPrompt(ctx), messages: [{ role: 'user', content: input.text }], tools: [], maxTokens: 1500 }, {}, { task: 'command' });
      parsed = Parsed.parse(jsonFrom(res.content.filter((b) => b.type === 'text').map((b: any) => b.text).join('\n')));
    } catch (e) {
      logger.warn(`teach parse failed: ${(e as Error).message}`, 'Teach');
      parsed = { kind: 'question', question: null, changes: [] };
    }
    const changes: TeachChange[] = [];
    for (const raw of parsed.changes) {
      const c = Change.safeParse(raw);
      if (c.success) changes.push(c.data as TeachChange);
    }
    if (parsed.kind === 'teach' && !changes.length) parsed.kind = 'question';

    return this.db.withTenant(businessId, async (tx) => {
      const { lines, affected, conflicts, kept } = parsed.kind === 'teach' ? await this.preview(tx, ctx, changes) : { lines: [], affected: [], conflicts: [], kept: [] as TeachChange[] };
      const needsOwner = role === 'staff' && kept.some((c) => OWNER_ONLY_TEACH.includes(c.type));
      const status: TeachPreview['status'] = parsed.kind === 'not_teach' ? 'not_teach' : parsed.kind === 'question' || !kept.length ? 'question' : 'preview';
      const question = status === 'question' ? parsed.question || translate(['hi', 'kn'].includes(input.language ?? '') ? input.language! : 'en', 'teach.ask_again') : null;
      const r = await tx.one(
        `INSERT INTO teach_requests (text, source, status, question, changes, affected, conflicts, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [input.text, input.source ?? 'app', status, question, JSON.stringify(kept), JSON.stringify({ lines, affected }), JSON.stringify(conflicts), userId],
      );
      return { id: r.id, status, question, changes: kept, lines, affected, conflicts, needsOwner };
    }, userId);
  }

  async get(businessId: string, id: string): Promise<TeachPreview & { versionIds: string[]; appliedAt: string | null }> {
    return this.db.withTenant(businessId, async (tx) => {
      const r = await tx.one(`SELECT * FROM teach_requests WHERE id = $1`, [id]);
      if (!r) throw notFound();
      return this.shape(r);
    });
  }

  private shape(r: any) {
    return {
      id: r.id, status: r.status, question: r.question, changes: r.changes, lines: r.affected?.lines ?? [], affected: r.affected?.affected ?? [], conflicts: r.conflicts,
      needsOwner: r.status === 'needs_owner', versionIds: r.version_ids ?? [], appliedAt: r.applied_at,
    };
  }

  /**
   * Save it. Staff teaching a price or rule change send it to the owner (a Needs You
   * card) instead. For bookings on days that change: keep, or message the customer.
   */
  async confirm(businessId: string, userId: string, role: string, id: string, choices: Record<string, TeachAffectedChoice> = {}, now = new Date()) {
    return this.db.withTenant(businessId, async (tx) => {
      const r = await tx.one(`SELECT * FROM teach_requests WHERE id = $1 FOR UPDATE`, [id]);
      if (!r) throw notFound();
      if (r.status === 'applied') return { ...this.shape(r), already: true };
      if (!['preview', 'needs_owner'].includes(r.status)) throw badRequest('not_ready', 'There is nothing to save for this yet.');
      const changes = r.changes as TeachChange[];
      if (role === 'staff' && changes.some((c) => OWNER_ONLY_TEACH.includes(c.type))) {
        if (r.status !== 'needs_owner') await this.askOwner(tx, r, userId);
        const updated = await tx.one(`SELECT * FROM teach_requests WHERE id = $1`, [id]);
        return this.shape(updated);
      }
      const applied = await this.apply(tx, r, userId, choices, now);
      return { ...this.shape(applied), messaged: applied.messaged ?? 0 };
    }, userId);
  }

  /** Staff asked for a price or rule change: the owner decides (Needs You). */
  private async askOwner(tx: Tx, r: any, userId: string) {
    const who = await tx.one(`SELECT name FROM users WHERE id = $1`, [userId]);
    const card = await tx.one(
      `INSERT INTO approval_cards (agent_key, type, title, context, options, default_option, expires_at)
       VALUES ('orbit', 'teach_approval', $1, $2, $3, 'reject', now() + interval '3 days') RETURNING id`,
      [
        JSON.stringify({ key: 'card.teach_approval', params: { person: (who?.name ?? '').split(' ')[0] || '—', text: String(r.text).slice(0, 140) } }),
        JSON.stringify({ teachId: r.id, lines: r.affected?.lines ?? [] }),
        JSON.stringify([
          { key: 'approve', label: 'card.option.approve', style: 'primary', outcome: 'approved' },
          { key: 'reject', label: 'card.option.not_now', style: 'secondary', outcome: 'rejected' },
        ]),
      ],
    );
    await tx.q(`UPDATE teach_requests SET status = 'needs_owner', card_id = $2 WHERE id = $1`, [r.id, card.id]);
    liveToBusiness(tx, { type: 'card.new' });
  }

  /** The owner's answer on the Needs You card. */
  async decideCard(tx: Tx, card: any, approved: boolean, ownerId: string) {
    const r = await tx.one(`SELECT * FROM teach_requests WHERE id = $1 FOR UPDATE`, [card.context?.teachId]);
    if (!r || r.status !== 'needs_owner') return;
    if (approved) await this.apply(tx, r, ownerId, {}, new Date());
    else await tx.q(`UPDATE teach_requests SET status = 'cancelled' WHERE id = $1`, [r.id]);
  }

  async cancel(businessId: string, userId: string, id: string) {
    return this.db.withTenant(businessId, async (tx) => {
      const r = await tx.one(`UPDATE teach_requests SET status = 'cancelled' WHERE id = $1 AND status IN ('preview', 'question', 'needs_owner', 'not_teach') RETURNING id`, [id]);
      if (!r) throw badRequest('not_open', 'This was already saved or cancelled.');
      return { ok: true };
    }, userId);
  }

  /** Undo everything one teach changed (newest first), within 24 hours. */
  async undo(businessId: string, userId: string, id: string) {
    return this.db.withTenant(businessId, async (tx) => {
      const r = await tx.one(`SELECT * FROM teach_requests WHERE id = $1 FOR UPDATE`, [id]);
      if (!r) throw notFound();
      if (r.status !== 'applied') throw badRequest('not_applied', 'This was not saved, so there is nothing to undo.');
      for (const v of [...(r.version_ids as string[])].reverse()) await revertVersion(tx, v, userId);
      await tx.q(`UPDATE teach_requests SET status = 'cancelled' WHERE id = $1`, [id]);
      await postFeed(tx, 'orbit', 'teach_undone', { key: 'feed.orbit.teach_undone', params: {} }, { entityType: 'teach_request', entityId: id });
      return { ok: true };
    }, userId);
  }

  async recent(businessId: string) {
    return this.db.withTenant(businessId, async (tx) =>
      (await tx.q(`SELECT * FROM teach_requests WHERE status = 'applied' AND applied_at > now() - interval '7 days' ORDER BY applied_at DESC LIMIT 10`)).map((r) => ({ ...this.shape(r), text: r.text })),
    );
  }

  // ---------------------------------------------------------------- internals

  async context(tx: Tx, now: Date): Promise<Ctx> {
    const b = await tx.one(
      `SELECT b.name, b.type, b.timezone, b.currency, p.hours, p.holidays, p.hours_changes, p.guardrails, p.social_links, p.phone, p.whatsapp, p.website, p.address, p.description
       FROM businesses b JOIN business_profiles p ON p.business_id = b.id WHERE b.id = app_current_business()`,
    );
    const local = localParts(now, b.timezone);
    const services = await tx.q(`SELECT id, name, price::float AS price, duration_min, active FROM services WHERE deleted_at IS NULL ORDER BY sort_order, name`);
    const staff = await tx.q(`SELECT id, name, leave FROM staff WHERE active AND deleted_at IS NULL ORDER BY created_at`);
    return {
      name: b.name, type: b.type, tz: b.timezone, currency: b.currency, today: local.date, weekday: weekdayOf(local.date),
      hours: b.hours, holidays: (b.holidays ?? []).map((h: any) => (typeof h === 'string' ? { date: h } : h)), hoursChanges: b.hours_changes ?? [],
      guardrails: b.guardrails ?? {}, social: b.social_links ?? {},
      profile: { phone: b.phone, whatsapp: b.whatsapp, website: b.website, address: b.address, description: b.description },
      services, staff,
    };
  }

  /** Before → after for each change, the bookings it touches, and anything that does not add up. */
  private async preview(tx: Tx, c: Ctx, changes: TeachChange[]) {
    const lines: TeachPreviewLine[] = [];
    const affected: TeachAffected[] = [];
    const conflicts: Sentence[] = [];
    const kept: TeachChange[] = [];
    const money = (n: number | null | undefined) => (n == null ? '@teach.price_on_request' : `~m:${c.currency}:${n}`);
    const upcoming = await tx.q(
      `SELECT bk.id, bk.start_at, bk.end_at, bk.staff_id, bk.service_id, s.name AS service, st.name AS staff, c.name AS customer, c.phone,
              to_char(bk.start_at AT TIME ZONE $1, 'YYYY-MM-DD') AS day, to_char(bk.start_at AT TIME ZONE $1, 'HH24:MI') AS t0, to_char(bk.end_at AT TIME ZONE $1, 'HH24:MI') AS t1
       FROM bookings bk JOIN services s ON s.id = bk.service_id LEFT JOIN staff st ON st.id = bk.staff_id LEFT JOIN customers c ON c.id = bk.customer_id
       WHERE bk.deleted_at IS NULL AND bk.status IN ('pending', 'confirmed') AND bk.start_at > now() AND bk.start_at < now() + interval '120 days' ORDER BY bk.start_at`,
      [c.tz],
    );
    const hit = (b: any, reason: TeachAffected['reason']) => {
      if (affected.some((a) => a.bookingId === b.id)) return;
      affected.push({ bookingId: b.id, start: new Date(b.start_at).toISOString(), customer: firstName({ name: b.customer, phone: b.phone }), service: b.service, staff: b.staff, reason });
    };
    for (const ch of changes) {
      switch (ch.type) {
        case 'update_hours': {
          const from = ch.from && ch.from > c.today ? ch.from : null;
          if (ch.from && ch.from < c.today) conflicts.push({ key: 'teach.conflict.past', params: { date: `~d:${ch.from}T12:00:00Z` } });
          const at = from ?? c.today;
          const was = hoursOn({ businessHours: c.hours, hoursChanges: c.hoursChanges }, at);
          for (const d of ch.days) {
            const after = ch.ranges.length ? ch.ranges.map((r) => `${r.from}–${r.to}`).join(', ') : '@teach.closed';
            lines.push({ type: ch.type, before: { key: 'teach.line.hours', params: { day: `@teach.day.${d}`, hours: hoursParam(was, d) } }, after: { key: 'teach.line.hours', params: { day: `@teach.day.${d}`, hours: after } }, from, to: null });
          }
          for (const b of upcoming) {
            if (b.day < at || !ch.days.includes(weekdayOf(b.day))) continue;
            if (!ch.ranges.length) hit(b, 'closed');
            else if (!inRanges(b.t0, b.t1, ch.ranges)) hit(b, 'hours');
          }
          kept.push({ ...ch, from });
          break;
        }
        case 'add_closure': {
          const to = ch.to && ch.to >= ch.from ? ch.to : ch.from;
          if (to < c.today) { conflicts.push({ key: 'teach.conflict.past', params: { date: `~d:${ch.from}T12:00:00Z` } }); break; }
          const from = ch.from < c.today ? c.today : ch.from;
          lines.push({ type: ch.type, before: null, after: ch.reason ? { key: 'teach.line.closed_for', params: { reason: ch.reason } } : { key: 'teach.line.closed', params: {} }, from, to: to !== from ? to : null });
          for (const b of upcoming) if (b.day >= from && b.day <= to) hit(b, 'closed');
          kept.push({ ...ch, from, to });
          break;
        }
        case 'update_service':
        case 'remove_service': {
          const s = byName(c.services, ch.service);
          if (!s) { conflicts.push({ key: 'teach.conflict.no_service', params: { service: ch.service } }); break; }
          if (ch.type === 'remove_service') {
            lines.push({ type: ch.type, before: { key: 'teach.line.service', params: { service: s.name, price: money(s.price) } }, after: { key: 'teach.line.removed', params: { service: s.name } }, from: null, to: null });
            for (const b of upcoming) if (b.service_id === s.id) hit(b, 'service_removed');
          } else {
            const price = ch.price !== undefined && ch.price !== null ? ch.price : s.price;
            const dur = ch.durationMin ?? s.duration_min;
            const before: Sentence = { key: 'teach.line.service_full', params: { service: s.name, price: money(s.price), minutes: s.duration_min } };
            const after: Sentence = ch.active === false ? { key: 'teach.line.paused', params: { service: s.name } } : { key: 'teach.line.service_full', params: { service: s.name, price: money(price), minutes: dur } };
            lines.push({ type: ch.type, before, after, from: null, to: null });
          }
          kept.push({ ...ch, service: s.name, serviceId: s.id });
          break;
        }
        case 'add_service': {
          const dup = byName(c.services, ch.name);
          if (dup && norm(dup.name) === norm(ch.name)) { conflicts.push({ key: 'teach.conflict.exists', params: { service: dup.name } }); break; }
          lines.push({ type: ch.type, before: null, after: { key: 'teach.line.service_full', params: { service: ch.name, price: money(ch.price), minutes: ch.durationMin } }, from: null, to: null });
          kept.push(ch);
          break;
        }
        case 'staff_leave': {
          const s = byName(c.staff, ch.staff);
          if (!s) { conflicts.push({ key: 'teach.conflict.no_staff', params: { staff: ch.staff } }); break; }
          const to = ch.to && ch.to >= ch.from ? ch.to : ch.from;
          if (to < c.today) { conflicts.push({ key: 'teach.conflict.past', params: { date: `~d:${ch.from}T12:00:00Z` } }); break; }
          lines.push({ type: ch.type, before: null, after: { key: 'teach.line.leave', params: { staff: s.name } }, from: ch.from, to: to !== ch.from ? to : null });
          for (const b of upcoming) if (b.staff_id === s.id && b.day >= ch.from && b.day <= to) hit(b, 'leave');
          kept.push({ ...ch, staff: s.name, staffId: s.id, to });
          break;
        }
        case 'add_faq':
          lines.push({ type: ch.type, before: null, after: { key: 'teach.line.faq', params: { question: ch.question, answer: ch.answer } }, from: null, to: null });
          kept.push(ch);
          break;
        case 'update_policy':
          lines.push({ type: ch.type, before: null, after: { key: 'teach.line.policy', params: { title: ch.title, content: ch.content } }, from: null, to: null });
          kept.push(ch);
          break;
        case 'update_profile': {
          const was = ['instagram', 'facebook'].includes(ch.field) ? c.social[ch.field] ?? null : c.profile[ch.field] ?? null;
          lines.push({ type: ch.type, before: was ? { key: 'teach.line.field', params: { field: `@teach.field.${ch.field}`, value: was } } : null, after: { key: 'teach.line.field', params: { field: `@teach.field.${ch.field}`, value: ch.value } }, from: null, to: null });
          kept.push(ch);
          break;
        }
        case 'set_rule': {
          const was = c.guardrails.maxDiscountPct;
          lines.push({ type: ch.type, before: was != null ? { key: 'teach.line.discount', params: { pct: was } } : { key: 'teach.line.no_discount', params: {} }, after: { key: 'teach.line.discount', params: { pct: ch.maxDiscountPct } }, from: null, to: null });
          kept.push(ch);
          break;
        }
      }
    }
    return { lines, affected, conflicts, kept };
  }

  /** Write the changes, each as an undoable version, and tell the customers the owner chose to tell. */
  private async apply(tx: Tx, r: any, userId: string, choices: Record<string, TeachAffectedChoice>, now: Date) {
    const ctx = await this.context(tx, now);
    const changes = r.changes as TeachChange[];
    const versionIds: string[] = [];
    const add = (id: string | null) => id && versionIds.push(id);
    const label = (key: string, params: Sentence['params'] = {}): Sentence => ({ key, params });

    // Business information: one version for all profile changes in this teach.
    const profile = changes.filter((c) => ['update_hours', 'add_closure', 'update_profile', 'set_rule', 'update_policy'].includes(c.type));
    if (profile.length) {
      const before = await snapshot(tx, 'business_info', await this.bizId(tx));
      let hours: WeeklyHours = JSON.parse(JSON.stringify(ctx.hours ?? {}));
      let hoursChanges = [...ctx.hoursChanges];
      const holidays = [...ctx.holidays];
      const social = { ...ctx.social };
      const guard = { ...ctx.guardrails };
      const cols: Record<string, string> = {};
      const policies = { ...(before?.policies ?? {}) };
      for (const ch of profile) {
        if (ch.type === 'update_hours') {
          const set = (h: WeeklyHours) => { for (const d of ch.days) h[d] = { open: ch.ranges.length > 0, ranges: ch.ranges }; return h; };
          if (!ch.from || ch.from <= ctx.today) hours = set(hours);
          else {
            const existing = hoursChanges.find((x) => x.from === ch.from);
            const base: WeeklyHours = JSON.parse(JSON.stringify(existing?.hours ?? hoursOn({ businessHours: hours, hoursChanges }, ch.from)));
            hoursChanges = [...hoursChanges.filter((x) => x.from !== ch.from), { from: ch.from, hours: set(base) }].sort((a, b) => (a.from < b.from ? -1 : 1));
          }
        } else if (ch.type === 'add_closure') {
          for (const d of dateRange(ch.from, ch.to)) if (!holidays.some((h) => h.date === d)) holidays.push({ date: d, reason: ch.reason ?? null });
        } else if (ch.type === 'update_profile') {
          if (ch.field === 'instagram' || ch.field === 'facebook') social[ch.field] = ch.value;
          else cols[ch.field] = ch.value;
        } else if (ch.type === 'set_rule') guard.maxDiscountPct = ch.maxDiscountPct;
        else if (ch.type === 'update_policy') {
          policies[norm(ch.title).replace(/ /g, '_').slice(0, 40) || 'policy'] = ch.content;
          const hrs = /cancel/i.test(ch.title + ch.content) ? /(\d{1,2})\s*(?:hours?|hrs?|घंटे|ಗಂಟೆ)/i.exec(ch.content) : null;
          if (hrs) policies.cancellation_hours = Number(hrs[1]);
        }
      }
      holidays.sort((a, b) => (a.date < b.date ? -1 : 1));
      const sets = Object.keys(cols).map((k, i) => `${k} = $${i + 7}`);
      await tx.q(
        `UPDATE business_profiles SET hours = $1, hours_changes = $2, holidays = $3, social_links = $4, guardrails = $5, policies = $6${sets.length ? ', ' + sets.join(', ') : ''}, updated_at = now() WHERE business_id = app_current_business()`,
        [JSON.stringify(hours), JSON.stringify(hoursChanges), JSON.stringify(holidays), JSON.stringify(social), JSON.stringify(guard), JSON.stringify(policies), ...Object.values(cols)],
      );
      add(await recordVersion(tx, { entity: 'business_info', id: await this.bizId(tx), label: label('change.teach_info', { text: String(r.text).slice(0, 80) }), before, after: await snapshot(tx, 'business_info', await this.bizId(tx)), by: userId, source: 'teach' }));
    }

    for (const ch of changes) {
      if (ch.type === 'update_service' && ch.serviceId) {
        const before = await snapshot(tx, 'service', ch.serviceId);
        await tx.q(
          `UPDATE services SET price = CASE WHEN $2::boolean THEN $3::numeric ELSE price END, duration_min = COALESCE($4, duration_min), active = COALESCE($5, active), updated_at = now() WHERE id = $1`,
          [ch.serviceId, ch.price !== undefined && ch.price !== null, ch.price ?? null, ch.durationMin ?? null, ch.active ?? null],
        );
        add(await recordVersion(tx, { entity: 'service', id: ch.serviceId, label: label('change.teach_service', { service: ch.service }), before, after: await snapshot(tx, 'service', ch.serviceId), by: userId, source: 'teach' }));
      } else if (ch.type === 'remove_service' && ch.serviceId) {
        const before = await snapshot(tx, 'service', ch.serviceId);
        await tx.q(`UPDATE services SET active = false, deleted_at = now(), updated_at = now() WHERE id = $1`, [ch.serviceId]);
        add(await recordVersion(tx, { entity: 'service', id: ch.serviceId, label: label('change.teach_service_removed', { service: ch.service }), before, after: await snapshot(tx, 'service', ch.serviceId), by: userId, source: 'teach' }));
      } else if (ch.type === 'add_service') {
        const s = await tx.one(
          `INSERT INTO services (name, price, duration_min, sort_order, created_by) VALUES ($1, $2, $3, (SELECT COALESCE(max(sort_order), 0) + 1 FROM services), $4) RETURNING id`,
          [ch.name, ch.price, ch.durationMin, userId],
        );
        add(await recordVersion(tx, { entity: 'service', id: s.id, label: label('change.teach_service_added', { service: ch.name }), before: null, after: await snapshot(tx, 'service', s.id), by: userId, source: 'teach' }));
      } else if (ch.type === 'staff_leave' && ch.staffId) {
        const before = await snapshot(tx, 'staff', ch.staffId);
        const leave = [...((before?.leave as { from: string; to: string }[]) ?? []), { from: ch.from, to: ch.to ?? ch.from }];
        await tx.q(`UPDATE staff SET leave = $2, updated_at = now() WHERE id = $1`, [ch.staffId, JSON.stringify(leave)]);
        add(await recordVersion(tx, { entity: 'staff', id: ch.staffId, label: label('change.teach_leave', { staff: ch.staff }), before, after: await snapshot(tx, 'staff', ch.staffId), by: userId, source: 'teach' }));
      } else if (ch.type === 'add_faq' || ch.type === 'update_policy') {
        const k = await tx.one(
          `INSERT INTO knowledge_items (type, title, content, active, source, created_by) VALUES ($1, $2, $3, true, 'teach', $4) RETURNING id`,
          [ch.type === 'add_faq' ? 'faq' : 'policy', ch.type === 'add_faq' ? ch.question : ch.title, ch.type === 'add_faq' ? ch.answer : ch.content, userId],
        );
        add(await recordVersion(tx, { entity: 'knowledge_item', id: k.id, label: label('change.teach_knowledge', { title: ch.type === 'add_faq' ? ch.question : ch.title }), before: null, after: await snapshot(tx, 'knowledge_item', k.id), by: userId, source: 'teach' }));
      }
    }

    // Customers on days that changed: tell the ones the owner chose to tell (held, so Undo still works).
    let messaged = 0;
    const affected = (r.affected?.affected ?? []) as TeachAffected[];
    for (const a of affected) {
      if ((choices[a.bookingId] ?? 'keep') !== 'message') continue;
      const b = await tx.one(`SELECT bk.customer_id, c.name, c.phone, c.language FROM bookings bk JOIN customers c ON c.id = bk.customer_id WHERE bk.id = $1`, [a.bookingId]);
      if (!b?.customer_id) continue;
      const lang = ['en', 'hi', 'kn'].includes(b.language) ? b.language : 'en';
      const when = new Intl.DateTimeFormat(lang === 'en' ? 'en-IN' : `${lang}-IN`, { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZone: ctx.tz }).format(new Date(a.start));
      const textOut = translate(lang, `teach.msg.${a.reason === 'leave' ? 'leave' : 'closed'}`, { name: firstName(b), business: ctx.name, when, service: a.service, staff: a.staff ?? '' });
      await this.hold.hold(tx, {
        agent: 'orbit', type: 'message', audience: 1, createdBy: userId,
        summary: { key: 'held.message', params: { agent: await agentName(tx, 'orbit'), customer: firstName(b) } },
        payload: { kind: 'message', customerId: b.customer_id, text: textOut },
        trace: {
          agent: 'orbit', customerId: b.customer_id, action: { key: 'why.action.orbit.teach_message', params: { customer: firstName(b) } },
          trigger: { kind: 'owner_command', text: r.text }, approver: { kind: 'owner' },
          facts: [fact('booking', 'why.fact.teach_booking', { when: `~dt:${a.start}` }, { type: 'booking', id: a.bookingId })],
        },
      });
      messaged++;
    }

    const feed = await postFeed(tx, 'orbit', 'teach_applied', { key: 'feed.orbit.teach', params: { count: changes.length } }, {
      entityType: 'teach_request', entityId: r.id, minutesSaved: 2 * changes.length,
      trace: {
        agent: 'orbit', action: { key: 'why.action.orbit.teach', params: { count: changes.length } },
        trigger: { kind: 'owner_command', text: r.text }, approver: { kind: 'owner' },
        facts: (r.affected?.lines ?? []).slice(0, 4).map((l: TeachPreviewLine) => ({ code: 'teach_change', text: l.after })),
      },
    });
    const row = await tx.one(`UPDATE teach_requests SET status = 'applied', applied_at = now(), version_ids = $2 WHERE id = $1 RETURNING *`, [r.id, versionIds]);
    liveToBusiness(tx, { type: 'changes.updated' });
    return { ...row, messaged, traceId: feed.traceId };
  }

  private async bizId(tx: Tx): Promise<string> {
    return (await tx.one(`SELECT app_current_business() AS id`)).id;
  }

  /** Hours that start on a later date: on that date they become the regular hours (Aria and the booking page already use them). */
  async applyDueHours(now = new Date()) {
    const rows = await this.db.adminTx((tx) => tx.q<{ id: string }>(`SELECT b.id FROM businesses b JOIN business_profiles p ON p.business_id = b.id WHERE jsonb_array_length(p.hours_changes) > 0`));
    let n = 0;
    for (const { id } of rows) {
      await this.db.withTenant(id, async (tx) => {
        const c = await this.context(tx, now);
        const due = c.hoursChanges.filter((x) => x.from <= c.today).sort((a, b) => (a.from < b.from ? -1 : 1));
        if (!due.length) return;
        const hours = due[due.length - 1].hours;
        await tx.q(`UPDATE business_profiles SET hours = $1, hours_changes = $2 WHERE business_id = app_current_business()`, [JSON.stringify(hours), JSON.stringify(c.hoursChanges.filter((x) => x.from > c.today))]);
        n++;
      }).catch((e) => logger.error(`teach hours failed: ${e.message}`, e.stack, 'Teach'));
    }
    return n;
  }
}

export const _test = { byName, teachPrompt, dateRange };
