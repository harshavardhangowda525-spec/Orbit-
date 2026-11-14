import { Injectable, OnModuleInit } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { planAllowsPower, translate, type PlanFeatures } from '@orbit/shared';
import { DbService } from '../db/db.service';
import { AriaService } from '../ai/aria.service';
import { BookingsService } from '../bookings/bookings.service';
import { ConversationsService } from '../inbox/conversations.service';
import { AuditService } from '../audit/audit.service';
import { JwtAuthGuard } from '../auth/guards';
import type { Tenant } from '../auth/types';
import { badRequest } from '../common/errors';
import { postFeed } from '../common/feed';
import { liveToBusiness } from '../realtime/live';
import { logger } from '../logger';
import { open, seal } from '../powers/crypto';
import { chunks, Endpointer, msOf } from './audio';
import { speechFromEnv, type SpeechProvider } from './speech';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CALL_MS = 15 * 60_000;
const TEST_CALL_MS = 5 * 60_000;
const LANGS = ['en', 'hi', 'kn'];

export interface ExotelCreds {
  apiKey: string;
  apiToken: string;
}

const ExotelConnect = z.object({
  accountSid: z.string().trim().min(3).max(100).regex(/^[\w-]+$/, 'The Account SID is letters and numbers, like glowstudio1.'),
  apiKey: z.string().trim().min(10).max(200),
  apiToken: z.string().trim().min(10).max(200),
  exophone: z.string().trim().regex(/^\+?\d[\d\s-]{6,18}$/, 'The ExoPhone is the number customers call, like 080 4718 0000.'),
  region: z.enum(['in', 'sg']).default('in'),
  appId: z.string().trim().regex(/^\d{3,12}$/, 'The flow (app) ID is a number from the Exotel App Bazaar URL.').optional().or(z.literal('').transform(() => undefined)),
});

/** What a call's audio goes through: Exotel's media stream or the owner's browser. */
interface Transport {
  play(pcm: Buffer): void;
  clear(): void;
  hangup(): void;
  note?(e: Record<string, unknown>): void;
}

export class ExotelError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Exotel's API host for the account's region. */
const exotelHost = (region: string) => (region === 'sg' ? 'api.exotel.com' : 'api.in.exotel.com');

/** India-first phone normalisation for caller ids like "09876543210" or "919876543210". */
export function callerE164(raw: string | null | undefined): string | null {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 10) return `+91${d}`;
  if (d.length === 11 && d.startsWith('0')) return `+91${d.slice(1)}`;
  if (d.length >= 11 && d.length <= 15) return `+${d}`;
  return null;
}

/**
 * Vox answers the phone. A call is a conversation on the "phone" channel:
 * the caller's speech is transcribed (Sarvam), answered by the same agent loop
 * as chat with Vox's tools and phone rules, and spoken back. Exotel streams the
 * call audio over a WebSocket (Voicebot applet); owners can also try Vox from
 * their browser. If Vox cannot take a call (plan, switched off, minutes used up),
 * the stream closes at once and Exotel moves on to the next applet in the flow,
 * normally "Connect" to the team.
 */
@Injectable()
export class VoiceService implements OnModuleInit {
  readonly speech: SpeechProvider | null = speechFromEnv();
  private wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  private live = new Set<CallSession>();

  constructor(
    private readonly db: DbService,
    private readonly aria: AriaService,
    private readonly bookings: BookingsService,
    private readonly conversations: ConversationsService,
    private readonly audit: AuditService,
    private readonly guard: JwtAuthGuard,
  ) {}

  onModuleInit() {
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const route = url.pathname.startsWith('/voice/exotel') ? this.exotel(ws, url) : this.browser(ws, url);
      route.catch((e) => {
        logger.error(`voice socket failed: ${e.message}`, e.stack, 'Vox');
        ws.close(1011, 'error');
      });
    });
  }

  /** Upgrades for /voice/exotel/<key> and /voice/web (called by the HTTP server's upgrade router). */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  }

  /** End every open call socket (server shutdown). */
  closeAll() {
    for (const c of this.wss.clients) c.terminate();
  }

  /** Calls in progress (tests and graceful shutdown). */
  get activeCalls() {
    return this.live.size;
  }

  // ------------------------------------------------------------ setup

  async status(t: Tenant) {
    return this.db.withTenant(t.businessId, async (tx) => {
      const conn = await tx.one(`SELECT id, account_label, settings, last_sync_at FROM power_connections WHERE power_type = 'phone' AND status = 'connected' ORDER BY created_at DESC LIMIT 1`);
      const route = conn ? await tx.one(`SELECT external_id FROM channel_routes WHERE power_connection_id = $1`, [conn.id]) : null;
      const vox = await tx.one(`SELECT display_name, enabled FROM agents WHERE agent_key = 'vox'`);
      const plan = await tx.one(
        `SELECT p.features, (p.limits->>'callMinutesPerMonth')::int AS cap, COALESCE(p.limits->>'overage', 'block') AS overage FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.id = app_current_business()`,
      );
      const used = await tx.one(`SELECT COALESCE(sum(minutes_billed), 0)::int AS n FROM calls WHERE started_at >= date_trunc('month', now())`);
      const calls = await tx.q(
        `SELECT cl.id, cl.direction, cl.purpose, cl.status, cl.from_number, cl.to_number, cl.duration_sec, cl.outcome, cl.summary, cl.started_at, cl.conversation_id, c.name AS customer
         FROM calls cl LEFT JOIN customers c ON c.id = cl.customer_id ORDER BY cl.started_at DESC LIMIT 10`,
      );
      return {
        speechReady: !!this.speech,
        onPlan: planAllowsPower(plan.features as PlanFeatures, 'phone') && (plan.features as PlanFeatures).agents.includes('vox'),
        vox: { name: vox?.display_name ?? 'Vox', enabled: !!vox?.enabled },
        minutes: { used: used.n, cap: plan.cap, overage: plan.overage },
        exotel: conn ? { account: conn.account_label, exophone: conn.settings.exophone, outbound: !!conn.settings.appId, streamPath: route ? `/voice/exotel/${route.external_id}` : null } : null,
        calls,
      };
    });
  }

  /** Save the business's Exotel account; returns the stream address to paste into the Voicebot applet. */
  async connectExotel(t: Tenant, raw: unknown) {
    const b = ExotelConnect.safeParse(raw);
    if (!b.success) throw badRequest('invalid_input', b.error.issues[0]?.message ?? 'Please check the details.');
    const plan = await this.db.one<{ features: PlanFeatures }>(`SELECT p.features FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.id = $1`, [t.businessId]);
    if (!planAllowsPower(plan!.features, 'phone')) throw badRequest('upgrade_needed', 'Phone calls are not on your plan. Upgrade to use Vox.');
    const d = b.data;
    // Check the keys before saving: a bad key would only show up when a customer calls.
    const res = await fetch(`https://${exotelHost(d.region)}/v1/Accounts/${encodeURIComponent(d.accountSid)}.json`, {
      headers: { authorization: `Basic ${Buffer.from(`${d.apiKey}:${d.apiToken}`).toString('base64')}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (res && (res.status === 401 || res.status === 403 || res.status === 404)) throw badRequest('exotel_rejected', 'Exotel did not accept these details. Check the Account SID, API key and API token in Exotel → API settings.');
    const exophone = callerE164(d.exophone) ?? d.exophone;
    const key = randomBytes(18).toString('base64url');
    const label = `${exophone} · Exotel`;
    const id = await this.db.withTenant(t.businessId, async (tx) => {
      const old = await tx.q(`UPDATE power_connections SET status = 'disconnected', encrypted_tokens = NULL WHERE power_type = 'phone' AND status <> 'disconnected' RETURNING id`);
      if (old.length) await tx.q(`DELETE FROM channel_routes WHERE power_connection_id = ANY($1::uuid[])`, [old.map((o) => o.id)]);
      const c = await tx.one(
        `INSERT INTO power_connections (power_type, account_label, external_account, encrypted_tokens, settings, status, connected_by, last_sync_at)
         VALUES ('phone', $1, $2, $3, $4, 'connected', $5, now()) RETURNING id`,
        [label, d.accountSid, seal({ apiKey: d.apiKey, apiToken: d.apiToken } satisfies ExotelCreds), JSON.stringify({ exophone, region: d.region, appId: d.appId ?? null }), t.userId],
      );
      await tx.q(`INSERT INTO channel_routes (channel, external_id, business_id, power_connection_id) VALUES ('exotel', $1, app_current_business(), $2)`, [key, c.id]);
      await postFeed(tx, 'orbit', 'power_connected', { key: 'feed.orbit.power_connected', params: { power: '@power.phone' } }, { entityType: 'power', entityId: c.id });
      liveToBusiness(tx, { type: 'notification.new' });
      return c.id as string;
    }, t.userId);
    await this.audit.write({ businessId: t.businessId, actorId: t.userId, action: 'power.connect', entity: 'power', entityId: id, after: { type: 'phone', account: label } });
    return { ok: true, id, account: label, streamPath: `/voice/exotel/${key}` };
  }

  /** Vox rings a number (the owner's, to try it): Exotel dials it and runs the Voicebot flow. */
  async testCall(t: Tenant, rawPhone: unknown) {
    const phone = callerE164(typeof rawPhone === 'string' ? rawPhone : '');
    if (!phone) throw badRequest('invalid_phone', 'That phone number does not look right. Please check it.');
    const ready = await this.canTakeCall(t.businessId, 'test');
    if (!ready.ok) throw badRequest(ready.reason!, ready.message!);
    const conn = await this.db.withTenant(t.businessId, (tx) => tx.one(`SELECT * FROM power_connections WHERE power_type = 'phone' AND status = 'connected' ORDER BY created_at DESC LIMIT 1`));
    const creds = conn && open<ExotelCreds>(conn.encrypted_tokens);
    if (!conn || !creds) throw badRequest('not_connected', 'Connect Exotel first.');
    if (!conn.settings.appId) throw badRequest('no_flow', 'Add the Exotel flow (app) ID that holds the Voicebot applet to make outgoing calls.');
    const call = await this.db.withTenant(t.businessId, (tx) =>
      tx.one(`INSERT INTO calls (direction, from_number, to_number, purpose, status, handled_by, created_by) VALUES ('out', $1, $2, 'test', 'queued', 'vox', $3) RETURNING id`, [conn.settings.exophone, phone, t.userId]),
    );
    const form = new URLSearchParams({
      From: phone,
      CallerId: conn.settings.exophone,
      Url: `http://my.exotel.com/${conn.external_account}/exoml/start_voice/${conn.settings.appId}`,
      CallType: 'trans',
      TimeLimit: String(TEST_CALL_MS / 1000),
      CustomField: call.id,
    });
    const res = await fetch(`https://${exotelHost(conn.settings.region)}/v1/Accounts/${encodeURIComponent(conn.external_account)}/Calls/connect.json`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${creds.apiKey}:${creds.apiToken}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(15_000),
    }).catch((e) => {
      throw new ExotelError(502, `Could not reach Exotel: ${e.message}`);
    });
    const d: any = await res.json().catch(() => ({}));
    if (!res.ok || !d?.Call?.Sid) {
      await this.db.withTenant(t.businessId, (tx) => tx.q(`UPDATE calls SET status = 'failed', outcome = $2 WHERE id = $1`, [call.id, String(d?.RestException?.Message ?? res.status).slice(0, 200)]));
      throw badRequest('exotel_failed', d?.RestException?.Message ?? `Exotel could not place the call (${res.status}).`);
    }
    await this.db.withTenant(t.businessId, (tx) => tx.q(`UPDATE calls SET call_sid = $2 WHERE id = $1`, [call.id, d.Call.Sid]));
    return { ok: true, callId: call.id as string };
  }

  // ------------------------------------------------------------ permission to talk

  /** Vox may take a call when speech is set up, Vox is on and on the plan, and minutes are left. */
  async canTakeCall(businessId: string, purpose: 'inbound' | 'test'): Promise<{ ok: boolean; reason?: string; message?: string }> {
    if (!this.speech) return { ok: false, reason: 'speech_not_configured', message: 'Phone calls are not switched on for Orbit yet. Please ask the Orbit team.' };
    const r = await this.db.withTenant(businessId, (tx) =>
      tx.one(
        `SELECT b.status, p.features, (p.limits->>'callMinutesPerMonth')::int AS cap, COALESCE(p.limits->>'overage', 'block') AS overage,
                (SELECT enabled FROM agents WHERE agent_key = 'vox') AS vox,
                (SELECT COALESCE(sum(minutes_billed), 0)::int FROM calls WHERE started_at >= date_trunc('month', now())) AS used
         FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.id = app_current_business()`,
      ),
    );
    if (!r || r.status === 'suspended' || r.status === 'paused') return { ok: false, reason: 'paused', message: 'This business is paused.' };
    if (!(r.features as PlanFeatures).agents.includes('vox')) return { ok: false, reason: 'upgrade_needed', message: 'Vox is not on your plan. Upgrade to use phone calls.' };
    if (!r.vox) return { ok: false, reason: 'vox_off', message: 'Vox is switched off. Turn Vox on in Crew.' };
    if (purpose === 'inbound' && r.cap !== null && r.overage !== 'charge' && r.used >= r.cap) return { ok: false, reason: 'minutes_used', message: "This month's call minutes are used up." };
    return { ok: true };
  }

  // ------------------------------------------------------------ transports

  /** Exotel Voicebot stream: JSON events, base64 PCM16 8 kHz audio. */
  private async exotel(ws: WebSocket, url: URL) {
    const key = url.pathname.split('/')[3] || url.searchParams.get('key') || '';
    // Listen at once (Exotel sends "start" right after connecting); the line is looked up meanwhile.
    const lookup = /^[\w-]{10,64}$/.test(key) ? this.db.one<{ business_id: string }>(`SELECT business_id FROM channel_routes WHERE channel = 'exotel' AND external_id = $1`, [key]) : Promise.resolve(null);
    let streamSid = '';
    let session: CallSession | null = null;
    const pending: Buffer[] = [];
    const send = (o: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(o));
    const transport: Transport = {
      play: (pcm) => {
        for (const c of chunks(pcm)) send({ event: 'media', stream_sid: streamSid, media: { payload: c.toString('base64') } });
        send({ event: 'mark', stream_sid: streamSid, mark: { name: `said-${Date.now()}` } });
      },
      clear: () => send({ event: 'clear', stream_sid: streamSid }),
      hangup: () => ws.readyState === ws.OPEN && ws.close(1000, 'done'),
    };
    ws.on('message', async (raw, binary) => {
      if (binary) return;
      let m: any;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m.event === 'start' && !session) {
        const route = await lookup;
        if (!route || session) return;
        const s = m.start ?? {};
        streamSid = String(m.stream_sid ?? s.stream_sid ?? '');
        const custom = s.custom_parameters ?? s.customParameters ?? {};
        session = new CallSession(this, transport, route.business_id);
        try {
          const ok = await session.begin({ callSid: String(s.call_sid ?? s.callSid ?? '') || null, from: s.from ?? null, to: s.to ?? null, callId: UUID_RE.test(custom.CustomField ?? custom.call ?? '') ? custom.CustomField ?? custom.call : null });
          if (!ok) return transport.hangup();
          for (const p of pending.splice(0)) session.audio(p);
        } catch (e) {
          logger.error(`call start failed: ${(e as Error).message}`, (e as Error).stack, 'Vox');
          transport.hangup();
        }
      } else if (m.event === 'media' && m.media?.payload) {
        const pcm = Buffer.from(m.media.payload, 'base64');
        if (session?.ready) session.audio(pcm);
        else if (pending.length < 100) pending.push(pcm);
      } else if (m.event === 'stop') {
        transport.hangup();
      }
    });
    ws.on('close', () => session?.end('caller'));
    if (!(await lookup)) ws.close(4404, 'unknown line');
  }

  /** Owners try Vox from the browser: binary PCM16 8 kHz both ways, JSON notes for the transcript. */
  private async browser(ws: WebSocket, url: URL) {
    const q = url.searchParams;
    const businessId = q.get('business') ?? '';
    const p = UUID_RE.test(businessId) ? await this.guard.resolve(q.get('token') ?? '').catch(() => null) : null;
    const member = p
      ? p.impersonation
        ? p.impersonation.businessId === businessId
        : !!(await this.db.one(`SELECT 1 FROM memberships WHERE user_id = $1 AND business_id = $2 AND status = 'active' AND role IN ('owner', 'manager')`, [p.id, businessId]))
      : false;
    if (!member) {
      ws.close(4401, 'unauthorized');
      return;
    }
    const send = (o: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(o));
    const transport: Transport = {
      play: (pcm) => ws.readyState === ws.OPEN && ws.send(pcm),
      clear: () => send({ type: 'clear' }),
      hangup: () => {
        send({ type: 'end' });
        setTimeout(() => ws.readyState === ws.OPEN && ws.close(1000, 'done'), 50);
      },
      note: (e) => send(e),
    };
    const ready = await this.canTakeCall(businessId, 'test');
    if (!ready.ok) {
      send({ type: 'error', reason: ready.reason, message: ready.message });
      ws.close(4403, ready.reason);
      return;
    }
    const session = new CallSession(this, transport, businessId, { purpose: 'test', userId: p!.id, maxMs: TEST_CALL_MS });
    ws.on('message', (raw, binary) => {
      if (binary && session.ready) session.audio(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer));
      else if (!binary && String(raw) === '{"type":"hangup"}') transport.hangup();
    });
    ws.on('close', () => session.end('caller'));
    if (!(await session.begin({ callSid: null, from: 'browser', to: null, callId: null }))) transport.hangup();
  }

  // ------------------------------------------------------------ call records (used by CallSession)

  register(s: CallSession) {
    this.live.add(s);
  }

  unregister(s: CallSession) {
    this.live.delete(s);
  }

  /** Start (or pick up) the call record and its phone conversation. */
  async openCall(businessId: string, o: { callSid: string | null; from: string | null; to: string | null; callId: string | null; purpose: 'inbound' | 'test'; userId?: string }) {
    return this.db.withTenant(businessId, async (tx) => {
      const biz = await tx.one(`SELECT name, default_language FROM businesses WHERE id = app_current_business()`);
      // Outgoing calls Orbit placed: matched by our id (CustomField) or Exotel's call sid.
      let call =
        (o.callId && (await tx.one(`SELECT * FROM calls WHERE id = $1 AND status = 'queued'`, [o.callId]))) ||
        (o.callSid && (await tx.one(`SELECT * FROM calls WHERE call_sid = $1 AND status = 'queued'`, [o.callSid]))) ||
        null;
      const outbound = !!call;
      const customerNumber = callerE164(outbound ? call.to_number : o.from);
      let customer: any = null;
      if (customerNumber && o.purpose === 'inbound' && !outbound) {
        customer = await this.bookings.upsertCustomer(tx, { phone: customerNumber }, 'phone').catch(() => null);
        if (customer) await tx.q(`UPDATE customers SET consent = consent || '{"calls": true}' WHERE id = $1`, [customer.id]);
      }
      const language = LANGS.includes(customer?.language) ? customer.language : LANGS.includes(biz.default_language) ? biz.default_language : 'en';
      const conv = await tx.one(
        `INSERT INTO conversations (customer_id, channel, status, handled_by, external_thread_id, language, last_message_at) VALUES ($1, 'phone', 'open', 'aria', $2, $3, now()) RETURNING id`,
        [customer?.id ?? null, o.callSid ?? null, language],
      );
      if (call) {
        call = await tx.one(`UPDATE calls SET status = 'in_progress', started_at = now(), conversation_id = $2, call_sid = COALESCE(call_sid, $3) WHERE id = $1 RETURNING *`, [call.id, conv.id, o.callSid]);
      } else {
        call = await tx.one(
          `INSERT INTO calls (customer_id, direction, from_number, to_number, call_sid, conversation_id, purpose, status, language, handled_by, created_by)
           VALUES ($1, 'in', $2, $3, $4, $5, $6, 'in_progress', $7, 'vox', $8) RETURNING *`,
          [customer?.id ?? null, customerNumber ?? o.from, o.to, o.callSid, conv.id, o.purpose, language, o.userId ?? null],
        );
      }
      const vox = await tx.one(`SELECT display_name FROM agents WHERE agent_key = 'vox'`);
      const firstName = customer?.name?.split(' ')[0] ?? '';
      const greeting =
        call.script ||
        translate(language as any, firstName ? 'vox.greeting_known' : 'vox.greeting', { business: biz.name, agent: vox?.display_name ?? 'Vox', name: firstName });
      await this.conversations.addMessage(tx, conv.id, { direction: 'out', sender: 'vox', body: greeting, language });
      liveToBusiness(tx, { type: 'call.started', data: { id: call.id, conversationId: conv.id } });
      return { callId: call.id as string, conversationId: conv.id as string, language, greeting, purpose: call.purpose as string, businessName: biz.name as string };
    });
  }

  async hear(businessId: string, conversationId: string, text: string, language: string) {
    await this.db.withTenant(businessId, async (tx) => {
      await this.conversations.addMessage(tx, conversationId, { direction: 'in', sender: 'customer', body: text, language });
      if (LANGS.includes(language)) await tx.q(`UPDATE conversations SET language = $2 WHERE id = $1`, [conversationId, language]);
    });
    return this.aria.reply(businessId, conversationId);
  }

  async said(businessId: string, conversationId: string, text: string, language: string) {
    await this.db.withTenant(businessId, (tx) => this.conversations.addMessage(tx, conversationId, { direction: 'out', sender: 'vox', body: text, language }));
  }

  /** Close the record: duration, minutes, transcript, and a line in the feed. */
  async closeCall(businessId: string, callId: string, o: { seconds: number; outcome: string; handedOver: boolean }) {
    await this.db.withTenant(businessId, async (tx) => {
      const call = await tx.one(`SELECT * FROM calls WHERE id = $1`, [callId]);
      if (!call || call.ended_at) return;
      const lines = call.conversation_id
        ? await tx.q(`SELECT sender, body FROM messages WHERE conversation_id = $1 ORDER BY created_at, id`, [call.conversation_id])
        : [];
      const transcript = lines.map((l) => `${l.sender === 'customer' ? 'Caller' : l.sender === 'vox' ? 'Vox' : l.sender}: ${l.body}`).join('\n');
      const minutes = call.purpose === 'test' ? 0 : Math.max(1, Math.ceil(o.seconds / 60));
      const spoke = lines.some((l) => l.sender === 'customer');
      await tx.q(
        `UPDATE calls SET ended_at = now(), duration_sec = $2, minutes_billed = $3, transcript = $4, outcome = COALESCE(outcome, $5), status = $6 WHERE id = $1`,
        [callId, Math.round(o.seconds), minutes, transcript.slice(0, 20_000), o.outcome, spoke || o.seconds > 5 ? 'completed' : 'no_answer'],
      );
      if (call.conversation_id && !o.handedOver) await tx.q(`UPDATE conversations SET status = 'closed' WHERE id = $1 AND handled_by = 'aria'`, [call.conversation_id]);
      if (call.purpose !== 'test' && spoke) {
        const c = call.customer_id ? await tx.one(`SELECT name, phone FROM customers WHERE id = $1`, [call.customer_id]) : null;
        await postFeed(
          tx,
          'vox',
          'call_handled',
          { key: o.handedOver ? 'feed.vox.call_transferred' : 'feed.vox.call', params: { customer: (c?.name ?? '').split(' ')[0] || c?.phone || call.from_number || '—', minutes: Math.max(1, Math.round(o.seconds / 60)) } },
          { entityType: 'call', entityId: callId, minutesSaved: Math.max(2, Math.ceil(o.seconds / 60)), channel: 'phone' },
        );
      }
      liveToBusiness(tx, { type: 'call.ended', data: { id: callId } });
    });
  }
}

/**
 * One phone call: listens, takes turns, speaks. Speech is processed one
 * sentence at a time; when the caller talks over Vox, Vox stops (barge-in).
 */
export class CallSession {
  ready = false;
  private callId = '';
  private conversationId = '';
  private language = 'en';
  private started = Date.now();
  private playingUntil = 0;
  private turn: Promise<void> = Promise.resolve();
  private busy = false;
  private ended = false;
  private handedOver = false;
  private closing = false;
  private misses = 0;
  private outcome = 'completed';
  private idle: NodeJS.Timeout | null = null;
  private limit: NodeJS.Timeout | null = null;
  private readonly ep: Endpointer;

  constructor(
    private readonly svc: VoiceService,
    private readonly t: Transport,
    private readonly businessId: string,
    private readonly o: { purpose: 'inbound' | 'test'; userId?: string; maxMs: number } = { purpose: 'inbound', maxMs: MAX_CALL_MS },
  ) {
    this.ep = new Endpointer(
      (pcm) => {
        this.turn = this.turn.then(() => this.take(pcm)).catch((e) => logger.error(`turn failed: ${e.message}`, e.stack, 'Vox'));
      },
      () => {
        // Barge-in: the caller started talking while Vox was speaking.
        if (Date.now() < this.playingUntil) {
          this.t.clear();
          this.playingUntil = 0;
        }
        this.stopIdle();
      },
    );
  }

  async begin(o: { callSid: string | null; from: string | null; to: string | null; callId: string | null }) {
    if (o.callId === null && this.o.purpose === 'inbound') {
      const allowed = await this.svc.canTakeCall(this.businessId, 'inbound');
      if (!allowed.ok) {
        logger.log(`call not taken (${allowed.reason}); passing to the next step in the flow`, 'Vox');
        return false;
      }
    }
    if (!this.svc.speech) return false;
    const c = await this.svc.openCall(this.businessId, { ...o, purpose: this.o.purpose, userId: this.o.userId });
    this.callId = c.callId;
    this.conversationId = c.conversationId;
    this.language = c.language;
    this.started = Date.now();
    this.svc.register(this);
    this.limit = setTimeout(() => this.goodbye('time_limit'), this.o.maxMs);
    this.t.note?.({ type: 'call', callId: this.callId, conversationId: this.conversationId });
    await this.say(c.greeting);
    this.ready = true;
    this.armIdle();
    return true;
  }

  audio(pcm: Buffer) {
    if (this.ended || this.closing) return;
    this.ep.push(pcm);
  }

  private async take(pcm: Buffer) {
    if (this.ended || this.closing || msOf(pcm) < 250) return;
    this.busy = true;
    try {
      const heard = await this.svc.speech!.transcribe(pcm);
      const text = heard.text.trim();
      if (!text) {
        if (++this.misses >= 2) {
          this.misses = 0;
          await this.say(translate(this.language as any, 'vox.repeat', {}));
        }
        return;
      }
      this.misses = 0;
      if (heard.language && LANGS.includes(heard.language)) this.language = heard.language;
      this.t.note?.({ type: 'heard', text });
      const r = await this.svc.hear(this.businessId, this.conversationId, text, this.language);
      if (this.ended) return;
      if (r.handover) {
        this.handedOver = true;
        await this.goodbye('transferred', translate(this.language as any, 'vox.transfer', {}));
        return;
      }
      if (r.text) await this.speak(r.text);
    } finally {
      this.busy = false;
      this.armIdle();
    }
  }

  /** Speak text that is already in the conversation (Aria's loop saved it). */
  private async speak(text: string) {
    if (this.ended) return;
    const pcm = await this.svc.speech!.speak(text, this.language);
    if (this.ended) return;
    this.t.note?.({ type: 'said', text });
    this.t.play(pcm);
    this.playingUntil = Date.now() + msOf(pcm);
  }

  /** Speak and record a line Vox says on its own (greeting, prompts). */
  private async say(text: string, record = false) {
    if (record) await this.svc.said(this.businessId, this.conversationId, text, this.language);
    await this.speak(text);
  }

  private armIdle() {
    this.stopIdle();
    if (this.ended || this.closing) return;
    const wait = Math.max(0, this.playingUntil - Date.now()) + 12_000;
    this.idle = setTimeout(async () => {
      if (this.busy || this.ep.inSpeech || this.ended) return this.armIdle();
      await this.say(translate(this.language as any, 'vox.still_there', {})).catch(() => undefined);
      this.idle = setTimeout(() => !this.busy && !this.ep.inSpeech && this.goodbye('silence'), Math.max(0, this.playingUntil - Date.now()) + 8_000);
    }, wait);
  }

  private stopIdle() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }

  /** Say a last line, let it play, then end the stream (Exotel moves on to the next applet). */
  private async goodbye(outcome: string, line?: string) {
    if (this.closing || this.ended) return;
    this.closing = true;
    this.stopIdle();
    this.outcome = outcome;
    try {
      await this.say(line ?? translate(this.language as any, 'vox.goodbye', {}), true);
    } catch {
      /* hang up anyway */
    }
    setTimeout(() => this.t.hangup(), Math.max(0, this.playingUntil - Date.now()) + 300);
  }

  async end(_by: string) {
    if (this.ended) return;
    this.ended = true;
    this.stopIdle();
    if (this.limit) clearTimeout(this.limit);
    this.svc.unregister(this);
    if (!this.callId) return;
    await this.turn.catch(() => undefined);
    await this.svc
      .closeCall(this.businessId, this.callId, { seconds: (Date.now() - this.started) / 1000, outcome: this.outcome, handedOver: this.handedOver })
      .catch((e) => logger.error(`closing call failed: ${e.message}`, e.stack, 'Vox'));
  }
}
