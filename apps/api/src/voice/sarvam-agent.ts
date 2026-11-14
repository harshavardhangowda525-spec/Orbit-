import { Body, Controller, Delete, Get, Headers, HttpCode, Injectable, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { randomBytes } from 'node:crypto';
import { DbService, type Tx } from '../db/db.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { BookingsService } from '../bookings/bookings.service';
import { NudgeService } from '../nudge/nudge.service';
import { ConversationsService } from '../inbox/conversations.service';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant, Public, Roles, TenantGuard } from '../auth/guards';
import type { Tenant } from '../auth/types';
import { runTool, type ToolContext } from '../ai/tools';
import { postFeed } from '../common/feed';
import { liveToBusiness } from '../realtime/live';
import { hashToken } from '../realtime/hash';
import { logger } from '../logger';
import { callerE164 } from './voice.service';

/**
 * A voice agent built on Sarvam's platform (Voice Agents / Samvaad) answers the
 * business's phone line; during the call it uses these endpoints as "API tools"
 * to see real free times and to book, move or cancel appointments in Orbit, and
 * after the call it sends the transcript here so the call shows up in the inbox
 * and the Crew feed. Each business gets its own secret key (only its hash is stored).
 */

const ROUTE = 'sarvam_agent';
const LANGS = ['en', 'hi', 'kn'];

type Body = Record<string, any>;
const str = (v: unknown, max = 300) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, max) : '');

/** Loose name matching for what a caller says ("hair cut" -> "Haircut (women)"). */
export function matchByName<T extends { name: string }>(rows: T[], q: string): T | null {
  const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const want = norm(q);
  if (!want) return null;
  const squash = (s: string) => norm(s).replace(/ /g, '');
  const exact = rows.find((r) => norm(r.name) === want || squash(r.name) === want.replace(/ /g, ''));
  if (exact) return exact;
  const contains = rows.filter((r) => squash(r.name).includes(want.replace(/ /g, '')) || want.replace(/ /g, '').includes(squash(r.name)));
  if (contains.length) return contains.sort((a, b) => a.name.length - b.name.length)[0];
  const words = want.split(' ').filter((w) => w.length > 2);
  let best: T | null = null;
  let score = 0;
  for (const r of rows) {
    const n = norm(r.name);
    const s = words.filter((w) => n.includes(w)).length;
    if (s > score) [best, score] = [r, s];
  }
  return best;
}

@Injectable()
export class SarvamAgentService {
  constructor(
    private readonly db: DbService,
    private readonly knowledge: KnowledgeService,
    private readonly bookings: BookingsService,
    private readonly nudge: NudgeService,
    private readonly conversations: ConversationsService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------- owner setup

  async status(t: Tenant) {
    return this.db.withTenant(t.businessId, async (tx) => {
      const c = await tx.one(`SELECT id, created_at, last_sync_at FROM power_connections WHERE power_type = $1 AND status = 'connected' ORDER BY created_at DESC LIMIT 1`, [ROUTE]);
      return { connected: !!c, since: c?.created_at ?? null, lastUsed: c?.last_sync_at ?? null };
    });
  }

  /** New key (shown once); any older key stops working. */
  async createKey(t: Tenant) {
    const key = `orbit_sv_${randomBytes(24).toString('base64url')}`;
    const id = await this.db.withTenant(t.businessId, async (tx) => {
      const old = await tx.q(`UPDATE power_connections SET status = 'disconnected' WHERE power_type = $1 AND status <> 'disconnected' RETURNING id`, [ROUTE]);
      if (old.length) await tx.q(`DELETE FROM channel_routes WHERE power_connection_id = ANY($1::uuid[])`, [old.map((o) => o.id)]);
      const c = await tx.one(
        `INSERT INTO power_connections (power_type, account_label, status, connected_by) VALUES ($1, 'Sarvam voice agent', 'connected', $2) RETURNING id`,
        [ROUTE, t.userId],
      );
      await tx.q(`INSERT INTO channel_routes (channel, external_id, business_id, power_connection_id) VALUES ($1, $2, app_current_business(), $3)`, [ROUTE, hashToken(key), c.id]);
      return c.id as string;
    }, t.userId);
    await this.audit.write({ businessId: t.businessId, actorId: t.userId, action: 'power.connect', entity: 'power', entityId: id, after: { type: ROUTE } });
    return { key };
  }

  async revoke(t: Tenant) {
    await this.db.withTenant(t.businessId, async (tx) => {
      const old = await tx.q(`UPDATE power_connections SET status = 'disconnected' WHERE power_type = $1 AND status <> 'disconnected' RETURNING id`, [ROUTE]);
      if (old.length) await tx.q(`DELETE FROM channel_routes WHERE power_connection_id = ANY($1::uuid[])`, [old.map((o) => o.id)]);
    }, t.userId);
    return { ok: true };
  }

  // ---------------------------------------------------------- calls from Sarvam

  /** The business behind a key ("Authorization: Bearer <key>" or "x-api-key"). */
  async businessFor(auth: string | undefined, apiKey: string | undefined) {
    const key = (apiKey || (auth ?? '').replace(/^Bearer\s+/i, '')).trim();
    if (!/^orbit_sv_[\w-]{20,}$/.test(key)) throw new UnauthorizedException('A valid Orbit key is required.');
    const r = await this.db.one<{ business_id: string; power_connection_id: string }>(`SELECT business_id, power_connection_id FROM channel_routes WHERE channel = $1 AND external_id = $2`, [ROUTE, hashToken(key)]);
    if (!r) throw new UnauthorizedException('This Orbit key is not valid any more. Create a new one in Orbit → Powers.');
    return r;
  }

  /** Runs one step of a call inside the business's data: the call's conversation, the caller, and Vox's tools. */
  private async inCall<T>(auth: { business_id: string; power_connection_id: string }, b: Body, fn: (tx: Tx, ctx: ToolContext, call: { conversationId: string; customerId: string | null; caller: string | null }) => Promise<T>) {
    return this.db.withTenant(auth.business_id, async (tx) => {
      const biz = await tx.one(`SELECT default_language, status FROM businesses WHERE id = app_current_business()`);
      const lang = str(b.language, 10).toLowerCase().slice(0, 2);
      const language = LANGS.includes(lang) ? lang : LANGS.includes(biz.default_language) ? biz.default_language : 'en';
      const call = await this.openCall(tx, b, language);
      await tx.q(`UPDATE power_connections SET last_sync_at = now() WHERE id = $1`, [auth.power_connection_id]);
      const ctx: ToolContext = {
        tx, agent: 'vox', conversationId: call.conversationId, channel: 'phone', language, now: new Date(),
        services: { knowledge: this.knowledge, bookings: this.bookings, nudge: this.nudge },
        effects: { quotedAmounts: [], customerId: call.customerId },
      };
      return fn(tx, ctx, call);
    });
  }

  /** One conversation and one call record per Sarvam call (by its interaction id; else caller + day). */
  private async openCall(tx: Tx, b: Body, language: string) {
    const caller = callerE164(str(b.caller ?? b.phone_number ?? b.user_identifier, 20));
    const callId = str(b.call_id ?? b.interaction_id, 100) || `${caller ?? 'unknown'}:${new Date().toISOString().slice(0, 10)}`;
    const thread = `sarvam:${callId}`;
    const found = await tx.one(`SELECT id, customer_id FROM conversations WHERE channel = 'phone' AND external_thread_id = $1`, [thread]);
    if (found) return { conversationId: found.id as string, customerId: (found.customer_id as string) ?? null, thread, caller };
    const customer = caller ? await this.bookings.upsertCustomer(tx, { phone: caller, language }, 'phone').catch(() => null) : null;
    const conv = await tx.one(
      `INSERT INTO conversations (customer_id, channel, status, handled_by, external_thread_id, language, last_message_at) VALUES ($1, 'phone', 'open', 'aria', $2, $3, now()) RETURNING id`,
      [customer?.id ?? null, thread, language],
    );
    await tx.q(
      `INSERT INTO calls (customer_id, direction, from_number, call_sid, conversation_id, purpose, status, language, handled_by) VALUES ($1, 'in', $2, $3, $4, 'inbound', 'in_progress', $5, 'vox')
       ON CONFLICT DO NOTHING`,
      [customer?.id ?? null, caller, thread, conv.id, language],
    );
    liveToBusiness(tx, { type: 'call.started', data: { conversationId: conv.id } });
    return { conversationId: conv.id as string, customerId: (customer?.id as string) ?? null, thread, caller };
  }

  private async tool(ctx: ToolContext, name: string, input: unknown) {
    const r = await runTool(ctx, name, input);
    return JSON.parse(r.content);
  }

  private services(tx: Tx) {
    return tx.q<{ id: string; name: string; duration_min: number }>(`SELECT id, name, duration_min FROM services WHERE active AND deleted_at IS NULL ORDER BY sort_order`);
  }

  private async staffId(tx: Tx, name: string) {
    if (!name) return undefined;
    const staff = await tx.q<{ id: string; name: string }>(`SELECT id, name FROM staff WHERE active AND deleted_at IS NULL`);
    return matchByName(staff, name)?.id;
  }

  /** Business facts for the start of a call: services with prices, hours, team, and whether the caller is known. */
  async info(auth: any, b: Body) {
    return this.inCall(auth, b, async (tx, ctx, call) => {
      const biz = await tx.one(`SELECT b.name, b.timezone, p.address, p.phone, p.hours, p.description FROM businesses b JOIN business_profiles p ON p.business_id = b.id WHERE b.id = app_current_business()`);
      const services = await this.tool(ctx, 'send_service_info', {});
      const staff = await tx.q(`SELECT name FROM staff WHERE active AND deleted_at IS NULL ORDER BY created_at`);
      const customer = call.customerId ? await this.tool(ctx, 'get_customer', {}) : { known: false };
      return {
        business: biz.name, address: biz.address, about: biz.description, timezone: biz.timezone, opening_hours: biz.hours,
        services: services.services.map((s: any) => ({ name: s.name, minutes: s.minutes, price: s.price })),
        team: staff.map((s) => s.name),
        caller: customer.known ? { name: customer.name ?? null, upcoming_bookings: customer.upcoming } : null,
      };
    });
  }

  async availability(auth: any, b: Body) {
    return this.inCall(auth, b, async (tx, ctx) => {
      const all = await this.services(tx);
      const svc = matchByName(all, str(b.service));
      if (!svc) return { ok: false, error: 'I could not find that service.', services: all.map((s) => s.name) };
      const date = /^\d{4}-\d{2}-\d{2}$/.test(str(b.date)) ? str(b.date) : undefined;
      const r = await this.tool(ctx, 'check_availability', { service_id: svc.id, staff_id: await this.staffId(tx, str(b.staff)), date });
      if (r.error) return { ok: false, error: r.error };
      return {
        ok: true, service: svc.name,
        slots: [...(r.slots ?? []), ...(r.more ?? [])].slice(0, 6).map((s: any) => ({ when: s.label, start: s.start })),
        note: r.slots?.length ? 'Offer up to three of these. To book, send the chosen "start" value exactly as given.' : 'No free times found. Offer another day, or take a message.',
      };
    });
  }

  async book(auth: any, b: Body) {
    return this.inCall(auth, b, async (tx, ctx, call) => {
      const all = await this.services(tx);
      const svc = matchByName(all, str(b.service));
      if (!svc) return { ok: false, error: 'I could not find that service.', services: all.map((s) => s.name) };
      const phone = callerE164(str(b.phone, 20)) ?? call.caller;
      if (!phone) return { ok: false, error: "Ask for the caller's mobile number." };
      const name = str(b.name, 80);
      if (!name) return { ok: false, error: "Ask for the caller's name." };
      const r = await this.tool(ctx, 'create_booking', { service_id: svc.id, start: str(b.start, 40), staff_id: (await this.staffId(tx, str(b.staff))) ?? null, name, phone });
      if (!r.ok) return { ok: false, error: r.error ?? 'That time could not be booked. Check availability again.' };
      await tx.q(`UPDATE conversations SET customer_id = COALESCE(customer_id, (SELECT customer_id FROM bookings WHERE id = $2)) WHERE id = $1`, [call.conversationId, r.booking_id]);
      await tx.q(`UPDATE calls SET customer_id = COALESCE(customer_id, (SELECT customer_id FROM bookings WHERE id = $2)), outcome = 'booked' WHERE conversation_id = $1`, [call.conversationId, r.booking_id]);
      return {
        ok: true, booking_id: r.booking_id, service: r.service, when: r.when, with: r.with ?? null,
        deposit: r.deposit_amount ? { amount: r.deposit_amount, pay_by: r.pay_by } : null,
        note: r.deposit_amount ? 'Tell the caller the slot is held until the deposit is paid; the payment link is sent by message.' : 'Confirm the day and time. A confirmation message is sent automatically.',
      };
    });
  }

  async myBookings(auth: any, b: Body) {
    return this.inCall(auth, b, async (tx, ctx, call) => {
      const phone = callerE164(str(b.phone, 20));
      if (phone && phone !== call.caller) {
        const c = await tx.one(`SELECT id FROM customers WHERE phone = $1 AND deleted_at IS NULL`, [phone]);
        if (c) {
          await tx.q(`UPDATE conversations SET customer_id = $2 WHERE id = $1`, [call.conversationId, c.id]);
          ctx.effects.customerId = c.id;
        }
      }
      const r = await this.tool(ctx, 'get_customer', {});
      if (!r.known) return { ok: true, bookings: [], note: 'No bookings found for this number. Ask which number they booked with.' };
      return { ok: true, name: r.name ?? null, bookings: (r.upcoming ?? []).map((u: any) => ({ booking_id: u.booking_id, service: u.service, when: u.when })) };
    });
  }

  async reschedule(auth: any, b: Body) {
    return this.inCall(auth, b, (_tx, ctx) => this.tool(ctx, 'reschedule_booking', { booking_id: str(b.booking_id, 40), start: str(b.start, 40) }));
  }

  async cancel(auth: any, b: Body) {
    return this.inCall(auth, b, async (tx, ctx, call) => {
      const r = await this.tool(ctx, 'cancel_booking', { booking_id: str(b.booking_id, 40) });
      if (r.ok) await tx.q(`UPDATE calls SET outcome = 'cancelled' WHERE conversation_id = $1`, [call.conversationId]);
      return r;
    });
  }

  /** The caller leaves a message for the team (callback, bridal enquiry, complaint...). */
  async message(auth: any, b: Body) {
    return this.inCall(auth, b, async (tx, ctx, call) => {
      const text = str(b.message, 500);
      if (!text) return { ok: false, error: 'What is the message?' };
      const name = str(b.name, 80) || null;
      const phone = callerE164(str(b.phone, 20)) ?? call.caller;
      const lead = await this.tool(ctx, 'create_lead', { interest: text.slice(0, 200), name: name ?? undefined, phone: phone ?? undefined });
      await tx.q(`INSERT INTO notifications (user_id, type, title, link) VALUES (NULL, 'vox_message', $1, $2)`, [
        JSON.stringify({ key: 'notify.vox_message', params: { customer: name ?? phone ?? '—', message: text.slice(0, 120) } }),
        `/inbox/${call.conversationId}`,
      ]);
      await tx.q(`UPDATE calls SET outcome = 'message' WHERE conversation_id = $1`, [call.conversationId]);
      liveToBusiness(tx, { type: 'notification.new' });
      return { ok: lead.ok !== false, note: 'Tell the caller the team will call them back.' };
    });
  }

  /** After the call (Sarvam's on-end hook): transcript into the inbox, the call record closed, a line in the feed. */
  async ended(auth: any, b: Body) {
    return this.inCall(auth, b, async (tx, _ctx, call) => {
      const existing = await tx.one(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1`, [call.conversationId]);
      const lines = transcriptLines(b.transcript ?? b.call_transcript);
      if (!existing.n) {
        // One transaction gives every row the same now(): space the lines a millisecond apart so they keep their order.
        for (const [i, l] of lines.slice(0, 200).entries()) {
          const m = await this.conversations.addMessage(tx, call.conversationId, { direction: l.who === 'caller' ? 'in' : 'out', sender: l.who === 'caller' ? 'customer' : 'vox', body: l.text, meta: { fromTranscript: true } });
          await tx.q(`UPDATE messages SET created_at = created_at + make_interval(secs => $2::float / 1000) WHERE id = $1`, [m.id, i]);
        }
      }
      const seconds = durationSeconds(b.duration_sec ?? b.call_length ?? b.duration);
      const text = lines.map((l) => `${l.who === 'caller' ? 'Caller' : 'Vox'}: ${l.text}`).join('\n');
      const row = await tx.one(
        `UPDATE calls SET ended_at = COALESCE(ended_at, now()), duration_sec = COALESCE(NULLIF($2, 0), duration_sec), transcript = COALESCE(NULLIF($3, ''), transcript),
           summary = COALESCE(NULLIF($4, ''), summary), outcome = COALESCE(outcome, NULLIF($5, ''), 'completed'), status = 'completed'
         WHERE conversation_id = $1 RETURNING id, customer_id, outcome`,
        [call.conversationId, seconds, text.slice(0, 20_000), str(b.summary, 1000), str(b.outcome ?? b.disposition, 60)],
      );
      await tx.q(`UPDATE conversations SET status = 'closed' WHERE id = $1 AND handled_by = 'aria'`, [call.conversationId]);
      const feedDone = await tx.one(`SELECT 1 FROM feed_events WHERE event_type = 'call_handled' AND entity_id = $1`, [row?.id ?? null]);
      if (row && !feedDone) {
        const c = row.customer_id ? await tx.one(`SELECT name, phone FROM customers WHERE id = $1`, [row.customer_id]) : null;
        await postFeed(tx, 'vox', 'call_handled', { key: 'feed.vox.call', params: { customer: (c?.name ?? '').split(' ')[0] || c?.phone || call.caller || '—', minutes: Math.max(1, Math.round(seconds / 60)) } }, {
          entityType: 'call', entityId: row.id, minutesSaved: Math.max(2, Math.ceil(seconds / 60)), channel: 'phone',
        });
      }
      liveToBusiness(tx, { type: 'call.ended', data: { conversationId: call.conversationId } });
      return { ok: true };
    });
  }
}

/** "95", 95, "95s", "1:35" or "00:01:35" -> seconds. */
export function durationSeconds(v: unknown): number {
  const t = str(v, 20).replace(/s(ec(onds)?)?$/i, '');
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t));
  if (/^\d+(:\d{1,2}){1,2}$/.test(t)) return t.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
  return 0;
}

/** Sarvam transcripts arrive as text ("User: …\nAgent: …") or as a list of turns; both become caller/agent lines. */
export function transcriptLines(t: unknown): { who: 'caller' | 'agent'; text: string }[] {
  const who = (r: string) => (/^(user|caller|customer|human)$/i.test(r.trim()) ? 'caller' : 'agent') as 'caller' | 'agent';
  if (Array.isArray(t)) {
    return t
      .map((x: any) => ({ who: who(String(x?.role ?? x?.speaker ?? x?.from ?? 'agent')), text: str(x?.content ?? x?.text ?? x?.message, 2000) }))
      .filter((l) => l.text);
  }
  if (typeof t === 'string') {
    const out: { who: 'caller' | 'agent'; text: string }[] = [];
    for (const line of t.split(/\r?\n/)) {
      const m = line.match(/^\s*(user|caller|customer|human|agent|assistant|bot|vox)\s*:\s*(.+)$/i);
      if (m) out.push({ who: who(m[1]), text: m[2].trim().slice(0, 2000) });
      else if (line.trim() && out.length) out[out.length - 1].text += ` ${line.trim()}`;
    }
    return out.length ? out : t.trim() ? [{ who: 'agent', text: t.trim().slice(0, 4000) }] : [];
  }
  return [];
}

/** Endpoints Sarvam's agent calls (API tools and the on-end hook). Authenticated by the business's Orbit key. */
@Controller('integrations/sarvam')
export class SarvamAgentController {
  constructor(private readonly svc: SarvamAgentService) {}

  private async run(auth: string | undefined, key: string | undefined, label: string, fn: (a: any) => Promise<unknown>) {
    const a = await this.svc.businessFor(auth, key);
    try {
      return await fn(a);
    } catch (e) {
      logger.error(`sarvam ${label} failed: ${(e as Error).message}`, (e as Error).stack, 'Vox');
      return { ok: false, error: 'Something went wrong. Offer to take a message for the team.' };
    }
  }

  @Public() @Post('info') @HttpCode(200)
  info(@Headers('authorization') h: string, @Headers('x-api-key') k: string, @Body() b: Body) {
    return this.run(h, k, 'info', (a) => this.svc.info(a, b ?? {}));
  }

  @Public() @Post('availability') @HttpCode(200)
  availability(@Headers('authorization') h: string, @Headers('x-api-key') k: string, @Body() b: Body) {
    return this.run(h, k, 'availability', (a) => this.svc.availability(a, b ?? {}));
  }

  @Public() @Post('book') @HttpCode(200)
  book(@Headers('authorization') h: string, @Headers('x-api-key') k: string, @Body() b: Body) {
    return this.run(h, k, 'book', (a) => this.svc.book(a, b ?? {}));
  }

  @Public() @Post('my-bookings') @HttpCode(200)
  myBookings(@Headers('authorization') h: string, @Headers('x-api-key') k: string, @Body() b: Body) {
    return this.run(h, k, 'my-bookings', (a) => this.svc.myBookings(a, b ?? {}));
  }

  @Public() @Post('reschedule') @HttpCode(200)
  reschedule(@Headers('authorization') h: string, @Headers('x-api-key') k: string, @Body() b: Body) {
    return this.run(h, k, 'reschedule', (a) => this.svc.reschedule(a, b ?? {}));
  }

  @Public() @Post('cancel') @HttpCode(200)
  cancel(@Headers('authorization') h: string, @Headers('x-api-key') k: string, @Body() b: Body) {
    return this.run(h, k, 'cancel', (a) => this.svc.cancel(a, b ?? {}));
  }

  @Public() @Post('message') @HttpCode(200)
  message(@Headers('authorization') h: string, @Headers('x-api-key') k: string, @Body() b: Body) {
    return this.run(h, k, 'message', (a) => this.svc.message(a, b ?? {}));
  }

  @Public() @Post('call-ended') @HttpCode(200)
  ended(@Headers('authorization') h: string, @Headers('x-api-key') k: string, @Body() b: Body) {
    return this.run(h, k, 'call-ended', (a) => this.svc.ended(a, b ?? {}));
  }
}

/** Owner side: create or revoke the key Sarvam uses. */
@UseGuards(TenantGuard)
@Controller('voice/sarvam')
export class SarvamKeyController {
  constructor(private readonly svc: SarvamAgentService) {}

  @Roles('owner', 'manager') @Get()
  status(@CurrentTenant() t: Tenant) {
    return this.svc.status(t);
  }

  @Roles('owner') @Post('key')
  key(@CurrentTenant() t: Tenant, @Req() _r: Request) {
    return this.svc.createKey(t);
  }

  @Roles('owner') @Delete('key')
  revoke(@CurrentTenant() t: Tenant) {
    return this.svc.revoke(t);
  }
}
