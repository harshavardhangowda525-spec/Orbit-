import { z } from 'zod';
import { agentMayUseTool, formatMoney, formatTime, localParts, spreadSlots, type AgentKey } from '@orbit/shared';
import type { Tx } from '../db/db.service';
import type { AiTool } from './provider';
import type { KnowledgeService } from '../knowledge/knowledge.service';
import type { BookingsService } from '../bookings/bookings.service';
import type { NudgeService } from '../nudge/nudge.service';
import { postFeed } from '../common/feed';
import { liveToBusiness } from '../realtime/live';
import { AppError } from '../common/errors';

/** Everything a tool may touch. All DB access goes through `tx`, which is scoped to one business by RLS. */
export interface ToolContext {
  tx: Tx;
  agent: AgentKey;
  conversationId: string | null;
  channel: string;
  language: string;
  now: Date;
  services: { knowledge: KnowledgeService; bookings: BookingsService; nudge: NudgeService };
  /** Set by tools; read by the runner after the turn. */
  effects: { handover?: { reason: string }; customerId?: string | null; quotedAmounts: number[] };
}

interface ToolDef<S extends z.ZodTypeAny> {
  description: string;
  input: S;
  schema: Record<string, unknown>;
  run(ctx: ToolContext, input: z.infer<S>): Promise<unknown>;
}

const uuid = { type: 'string', format: 'uuid' };
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const def = <S extends z.ZodTypeAny>(d: ToolDef<S>) => d;

async function currentCustomer(ctx: ToolContext) {
  if (ctx.effects.customerId) return ctx.effects.customerId;
  if (!ctx.conversationId) return null;
  const c = await ctx.tx.one(`SELECT customer_id FROM conversations WHERE id = $1`, [ctx.conversationId]);
  return c?.customer_id ?? null;
}

async function localLabel(ctx: ToolContext, start: Date) {
  const b = await ctx.tx.one(`SELECT timezone FROM businesses WHERE id = app_current_business()`);
  const day = new Intl.DateTimeFormat(ctx.language === 'en' ? 'en-IN' : `${ctx.language}-IN`, { weekday: 'short', day: 'numeric', month: 'short', timeZone: b.timezone }).format(start);
  return `${day}, ${formatTime(ctx.language, start, b.timezone)}`;
}

export const TOOLS = {
  search_knowledge: def({
    description: "Search the business's own FAQs, policies, notes and price lists. Use before answering any question about the business.",
    input: z.object({ query: z.string().min(1).max(300) }),
    schema: obj({ query: { type: 'string', description: 'What the customer wants to know' } }, ['query']),
    async run(ctx, i) {
      const results = await ctx.services.knowledge.search(ctx.tx, i.query, 4);
      for (const r of results) for (const m of r.content.matchAll(/(?:₹|rs\.?|inr)\s?([\d,]+)/gi)) ctx.effects.quotedAmounts.push(Number(m[1].replace(/,/g, '')));
      return { results: results.map((r) => ({ title: r.title, content: r.content })), note: results.length ? undefined : 'Nothing found. Do not guess; offer to check with the team.' };
    },
  }),
  send_service_info: def({
    description: 'Get the exact details (duration, price) of one service, or of all services when service_id is omitted. Prices must only ever come from here.',
    input: z.object({ service_id: z.string().uuid().optional() }),
    schema: obj({ service_id: { ...uuid, description: 'Omit to list all services' } }, []),
    async run(ctx, i) {
      const b = await ctx.tx.one(`SELECT currency FROM businesses WHERE id = app_current_business()`);
      const rows = await ctx.tx.q(
        `SELECT id, name, description, duration_min, price::float AS price FROM services WHERE active AND deleted_at IS NULL AND ($1::uuid IS NULL OR id = $1) ORDER BY sort_order`,
        [i.service_id ?? null],
      );
      for (const r of rows) if (r.price !== null) ctx.effects.quotedAmounts.push(Number(r.price));
      return {
        services: rows.map((r) => ({
          service_id: r.id,
          name: r.name,
          description: r.description,
          minutes: r.duration_min,
          price: r.price === null ? 'price on request — the team will confirm' : formatMoney(ctx.language, b.currency, r.price),
          bookable_by_time: r.duration_min > 0,
        })),
      };
    },
  }),
  get_customer: def({
    description: 'Get the customer in this conversation (if known): name, upcoming bookings.',
    input: z.object({}),
    schema: obj({}, []),
    async run(ctx) {
      const id = await currentCustomer(ctx);
      if (!id) return { known: false };
      const c = await ctx.tx.one(`SELECT name, phone, email FROM customers WHERE id = $1`, [id]);
      const upcoming = await ctx.tx.q(
        `SELECT bk.id, bk.start_at, s.name AS service FROM bookings bk JOIN services s ON s.id = bk.service_id
         WHERE bk.customer_id = $1 AND bk.status IN ('pending','confirmed') AND bk.start_at > now() ORDER BY bk.start_at LIMIT 5`,
        [id],
      );
      return { known: true, name: c?.name, has_phone: !!c?.phone, upcoming: await Promise.all(upcoming.map(async (u) => ({ booking_id: u.id, service: u.service, when: await localLabel(ctx, new Date(u.start_at)) }))) };
    },
  }),
  upsert_customer: def({
    description: 'Save the customer name / phone / email the customer gave you, and link them to this conversation.',
    input: z.object({ name: z.string().max(80).optional(), phone: z.string().max(20).optional(), email: z.string().email().max(120).optional() }),
    schema: obj({ name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' } }, []),
    async run(ctx, i) {
      if (!i.phone && !i.email) return { ok: false, error: 'Need a phone number or email.' };
      const b = await ctx.tx.one(`SELECT country FROM businesses WHERE id = app_current_business()`);
      const c = await ctx.services.bookings.upsertCustomer(ctx.tx, { ...i, language: ctx.language }, ctx.channel, b.country);
      if (ctx.conversationId) await ctx.tx.q(`UPDATE conversations SET customer_id = $2 WHERE id = $1`, [ctx.conversationId, c.id]);
      ctx.effects.customerId = c.id;
      return { ok: true };
    },
  }),
  check_availability: def({
    description: 'Find real free times for a service. Returns the 3 nearest options spaced apart, plus a few more. Never offer times that are not in this result.',
    input: z.object({ service_id: z.string().uuid(), staff_id: z.string().uuid().optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
    schema: obj({ service_id: uuid, staff_id: { ...uuid, description: 'Only if the customer asked for a person' }, date: { type: 'string', description: 'YYYY-MM-DD local date the customer prefers' } }, ['service_id']),
    async run(ctx, i) {
      const slots = await ctx.services.bookings.slots(ctx.tx, { serviceId: i.service_id, staffId: i.staff_id, fromDate: i.date, days: i.date ? 2 : 7, now: ctx.now, limit: 80 });
      const picked = spreadSlots(slots, 3, 60);
      const more = slots.filter((s) => !picked.includes(s)).slice(0, 6);
      const label = async (s: (typeof slots)[number]) => ({ start: s.start.toISOString(), staff_id: s.staffId, label: await localLabel(ctx, s.start) });
      return { slots: await Promise.all(picked.map(label)), more: await Promise.all(more.map(label)) };
    },
  }),
  create_booking: def({
    description: "Book a confirmed slot. Only call after the customer chose one of the offered times and you have their name and phone number. 'start' must be copied exactly from check_availability.",
    input: z.object({ service_id: z.string().uuid(), start: z.string().datetime({ offset: true }), staff_id: z.string().uuid().nullable().optional(), name: z.string().min(1).max(80), phone: z.string().min(6).max(20) }),
    schema: obj({ service_id: uuid, start: { type: 'string', description: 'ISO start from check_availability' }, staff_id: { type: ['string', 'null'] }, name: { type: 'string' }, phone: { type: 'string' } }, ['service_id', 'start', 'name', 'phone']),
    async run(ctx, i) {
      try {
        const r = await ctx.services.bookings.create(ctx.tx, {
          serviceId: i.service_id, staffId: i.staff_id ?? null, start: new Date(i.start), customer: { name: i.name, phone: i.phone, language: ctx.language },
          source: `${ctx.agent === 'vox' ? 'vox' : 'aria'}:${ctx.channel}`, conversationId: ctx.conversationId,
        }, ctx.now);
        ctx.effects.customerId = r.customer.id;
        if (r.deposit) {
          ctx.effects.quotedAmounts.push(r.deposit.amount);
          return {
            ok: true, booking_id: r.booking.id, service: r.service.name, when: await localLabel(ctx, new Date(r.booking.start_at)), with: r.staffName, manage_link: r.manageUrl,
            status: 'held_until_deposit_paid', deposit_amount: r.deposit.amount, deposit_payment_link: r.deposit.url, pay_by: await localLabel(ctx, r.deposit.payBy),
            note: 'Tell the customer the slot is held and is confirmed once the deposit is paid by the pay_by time, and share the payment link.',
          };
        }
        return { ok: true, booking_id: r.booking.id, service: r.service.name, when: await localLabel(ctx, new Date(r.booking.start_at)), with: r.staffName, manage_link: r.manageUrl };
      } catch (e) {
        if (e instanceof AppError) return { ok: false, error: (e.getResponse() as any).error.message };
        throw e;
      }
    },
  }),
  reschedule_booking: def({
    description: "Move one of this customer's own upcoming bookings to a new free time (from check_availability).",
    input: z.object({ booking_id: z.string().uuid(), start: z.string().datetime({ offset: true }) }),
    schema: obj({ booking_id: uuid, start: { type: 'string' } }, ['booking_id', 'start']),
    async run(ctx, i) {
      const cid = await currentCustomer(ctx);
      const own = cid && (await ctx.tx.one(`SELECT 1 FROM bookings WHERE id = $1 AND customer_id = $2`, [i.booking_id, cid]));
      if (!own) return { ok: false, error: 'That booking does not belong to this customer.' };
      try {
        const r = await ctx.services.bookings.reschedule(ctx.tx, i.booking_id, new Date(i.start), undefined, ctx.now);
        return { ok: true, when: await localLabel(ctx, new Date(r.start_at)) };
      } catch (e) {
        if (e instanceof AppError) return { ok: false, error: (e.getResponse() as any).error.message };
        throw e;
      }
    },
  }),
  cancel_booking: def({
    description: "Cancel one of this customer's own upcoming bookings after they confirm they want to cancel.",
    input: z.object({ booking_id: z.string().uuid() }),
    schema: obj({ booking_id: uuid }, ['booking_id']),
    async run(ctx, i) {
      const cid = await currentCustomer(ctx);
      const own = cid && (await ctx.tx.one(`SELECT 1 FROM bookings WHERE id = $1 AND customer_id = $2`, [i.booking_id, cid]));
      if (!own) return { ok: false, error: 'That booking does not belong to this customer.' };
      try {
        await ctx.services.bookings.cancel(ctx.tx, i.booking_id, 'customer via chat', 'aria');
        return { ok: true };
      } catch (e) {
        if (e instanceof AppError) return { ok: false, error: (e.getResponse() as any).error.message };
        throw e;
      }
    },
  }),
  create_lead: def({
    description: 'Save an enquiry from someone who is interested but not booking now. Needs a name and phone or email.',
    input: z.object({ interest: z.string().min(1).max(200), name: z.string().max(80).optional(), phone: z.string().max(20).optional(), email: z.string().email().optional(), service_id: z.string().uuid().optional(), answers: z.record(z.string()).optional() }),
    schema: obj({ interest: { type: 'string' }, name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }, service_id: uuid, answers: { type: 'object', description: 'Answers to qualifying questions', additionalProperties: { type: 'string' } } }, ['interest']),
    async run(ctx, i) {
      let cid = await currentCustomer(ctx);
      if (!cid) {
        if (!i.phone && !i.email) return { ok: false, error: 'Ask for a phone number or email first.' };
        const b = await ctx.tx.one(`SELECT country FROM businesses WHERE id = app_current_business()`);
        const c = await ctx.services.bookings.upsertCustomer(ctx.tx, { name: i.name, phone: i.phone, email: i.email, language: ctx.language }, ctx.channel, b.country);
        cid = c.id;
        ctx.effects.customerId = cid;
        if (ctx.conversationId) await ctx.tx.q(`UPDATE conversations SET customer_id = $2 WHERE id = $1`, [ctx.conversationId, cid]);
      }
      const open = await ctx.tx.one(`SELECT id FROM leads WHERE customer_id = $1 AND status IN ('new','contacted','qualified')`, [cid]);
      if (open) {
        await ctx.tx.q(`UPDATE leads SET interest = $2, answers = answers || $3::jsonb WHERE id = $1`, [open.id, i.interest, JSON.stringify(i.answers ?? {})]);
        return { ok: true, updated: true };
      }
      const lead = await ctx.tx.one(
        `INSERT INTO leads (customer_id, interest, service_id, source_channel, status, assigned_agent, answers) VALUES ($1,$2,$3,$4,'new','aria',$5) RETURNING id, customer_id, created_at`,
        [cid, i.interest, i.service_id ?? null, ctx.channel, JSON.stringify(i.answers ?? {})],
      );
      const c = await ctx.tx.one(`SELECT name FROM customers WHERE id = $1`, [cid]);
      await postFeed(ctx.tx, 'aria', 'lead_captured', { key: 'feed.aria.lead', params: { customer: (c?.name ?? '').split(' ')[0] || '—', interest: i.interest } }, { entityType: 'lead', entityId: lead.id, minutesSaved: 5, channel: ctx.channel });
      await ctx.services.nudge.onLeadCreated(ctx.tx, lead, ctx.now);
      return { ok: true };
    },
  }),
  handover_to_human: def({
    description: 'Pass the conversation to a person on the team. Use for complaints, anger, refunds, medical/legal/financial questions, discount requests, anything you cannot answer from the tools, or when the customer asks for a person.',
    input: z.object({ reason: z.string().min(1).max(300) }),
    schema: obj({ reason: { type: 'string', description: 'One short sentence for the owner' } }, ['reason']),
    async run(ctx, i) {
      ctx.effects.handover = { reason: i.reason };
      return { ok: true, tell_customer: 'Tell the customer a person from the team will reply here soon.' };
    },
  }),
  request_task: def({
    description: 'Ask Orbit (the manager) to get something done that you cannot do yourself, e.g. a callback. Orbit decides and may ask the owner.',
    input: z.object({ goal: z.string().min(1).max(300) }),
    schema: obj({ goal: { type: 'string' } }, ['goal']),
    async run(ctx, i) {
      const t = await ctx.tx.one(
        `INSERT INTO tasks (agent_key, created_by_kind, goal, inputs, status) VALUES ('orbit', 'agent_request', $1, $2, 'queued') RETURNING id`,
        [i.goal, JSON.stringify({ requestedBy: ctx.agent, conversationId: ctx.conversationId })],
      );
      liveToBusiness(ctx.tx, { type: 'task.status', data: { id: t.id, agent: 'orbit', status: 'queued' } });
      return { ok: true };
    },
  }),
} as const;

export type ToolName = keyof typeof TOOLS;

/** Tool definitions an agent is allowed to see (least privilege). */
export function toolsFor(agent: AgentKey): AiTool[] {
  return (Object.keys(TOOLS) as ToolName[])
    .filter((n) => agentMayUseTool(agent, n))
    .map((n) => ({ name: n, description: TOOLS[n].description, input_schema: TOOLS[n].schema as any }));
}

/** Validate and run one tool call. Returns a JSON string for the tool_result block. */
export async function runTool(ctx: ToolContext, name: string, input: unknown): Promise<{ content: string; isError: boolean }> {
  if (!(name in TOOLS) || !agentMayUseTool(ctx.agent, name)) return { content: JSON.stringify({ error: `Tool ${name} is not allowed.` }), isError: true };
  const def = TOOLS[name as ToolName] as ToolDef<z.ZodTypeAny>;
  const parsed = def.input.safeParse(input ?? {});
  if (!parsed.success) return { content: JSON.stringify({ error: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` }), isError: true };
  const result = await def.run(ctx, parsed.data);
  return { content: JSON.stringify(result), isError: false };
}

export const todayLabel = (now: Date, tz: string) => {
  const p = localParts(now, tz);
  return `${p.date} (${p.weekday}) ${p.hhmm}`;
};
