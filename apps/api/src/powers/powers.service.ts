import { Controller, Delete, Get, Injectable, Module, OnModuleInit, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import { planAllowsPower, type PlanFeatures } from '@orbit/shared';
import { DbService, Tx } from '../db/db.service';
import { JobsService } from '../jobs/jobs.service';
import { ChannelsService, type OutboundMessage } from '../channels/channels.service';
import { BookingsService } from '../bookings/bookings.service';
import { AriaService } from '../ai/aria.service';
import { ConversationsService } from '../inbox/conversations.service';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant, Public, Roles, TenantGuard } from '../auth/guards';
import type { Tenant } from '../auth/types';
import { badRequest, notFound } from '../common/errors';
import { postFeed } from '../common/feed';
import { liveToBusiness } from '../realtime/live';
import { runtime } from '../config';
import { logger } from '../logger';
import { open, seal } from './crypto';
import * as google from './google';

export const POWER_CATALOGUE: { type: string; group: string; oauth: 'google' | null }[] = [
  { type: 'google_calendar', group: 'calendar', oauth: 'google' },
  { type: 'gmail', group: 'messaging', oauth: 'google' },
  { type: 'whatsapp', group: 'messaging', oauth: null },
  { type: 'instagram', group: 'messaging', oauth: null },
  { type: 'messenger', group: 'messaging', oauth: null },
  { type: 'outlook', group: 'messaging', oauth: null },
  { type: 'sms', group: 'messaging', oauth: null },
  { type: 'phone', group: 'messaging', oauth: null },
  { type: 'outlook_calendar', group: 'calendar', oauth: null },
  { type: 'razorpay', group: 'payments', oauth: null },
  { type: 'google_sheets', group: 'records', oauth: null },
  { type: 'google_business_profile', group: 'presence', oauth: null },
];

/**
 * Powers: connected services. Tokens are encrypted per business and never
 * leave the business's context. Every action through a Power is logged in the Feed.
 */
@Injectable()
export class PowersService implements OnModuleInit {
  private busyCache = new Map<string, { at: number; intervals: { start: Date; end: Date }[] }>();

  constructor(
    private readonly db: DbService,
    private readonly jobs: JobsService,
    private readonly channels: ChannelsService,
    private readonly bookings: BookingsService,
    private readonly aria: AriaService,
    private readonly conversations: ConversationsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.bookings.setBusyProvider({
      busy: (tx, from, to) => this.calendarBusy(tx, from, to),
      onBookingChanged: (tx, bookingId, change) => {
        const businessId = tx.businessId!;
        tx.afterCommit(() => this.jobs.enqueue('powers.calendar_sync', { businessId, bookingId, change }).catch(() => undefined));
      },
    });
    this.channels.register('gmail', {
      canReach: async (tx, m) => !!m.customer.email && !!(await this.connection(tx, 'gmail')),
      send: (tx, m) => this.sendEmail(tx, m),
    });
    this.jobs.register('powers.calendar_sync', (d) => this.syncBooking(d.businessId, d.bookingId, d.change));
    this.jobs.register('powers.gmail_poll', () => this.pollAllGmail());
    this.jobs.register('powers.deliver', (d) => this.deliver(d.businessId, d.messageId));
  }

  // ---------- connections & tokens ----------

  async connection(tx: Tx, type: string) {
    return tx.one(`SELECT * FROM power_connections WHERE power_type = $1 AND status = 'connected'`, [type]);
  }

  /** A valid access token; refreshes when needed. Expired grants pause the Power and tell the owner. */
  async accessToken(tx: Tx, conn: any): Promise<string | null> {
    const tokens = open<google.GoogleTokens>(conn.encrypted_tokens);
    if (!tokens) return null;
    if (tokens.expires_at > Date.now() + 60_000) return tokens.access_token;
    if (!tokens.refresh_token) return this.markBroken(tx, conn, 'token_expired');
    try {
      const fresh = await google.refreshTokens(tokens.refresh_token);
      await tx.q(`UPDATE power_connections SET encrypted_tokens = $2, token_expires_at = $3 WHERE id = $1`, [conn.id, seal(fresh), new Date(fresh.expires_at)]);
      return fresh.access_token;
    } catch (e) {
      if (e instanceof google.GoogleError && (e.status === 400 || e.status === 401)) return this.markBroken(tx, conn, 'token_expired');
      throw e;
    }
  }

  private async markBroken(tx: Tx, conn: any, reason: string) {
    await tx.q(`UPDATE power_connections SET status = 'error', error = $2 WHERE id = $1`, [conn.id, reason]);
    await tx.q(`INSERT INTO notifications (user_id, type, title, link) VALUES (NULL, 'power_disconnected', $1, '/bridge?view=powers')`, [
      JSON.stringify({ key: 'notify.power_broken', params: { power: `@power.${conn.power_type}` } }),
    ]);
    liveToBusiness(tx, { type: 'notification.new' });
    return null;
  }

  async list(tx: Tx) {
    const plan = await tx.one<{ features: PlanFeatures }>(`SELECT p.features FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.id = app_current_business()`);
    const rows = await tx.q(`SELECT id, power_type, account_label, status, error, scopes, last_sync_at, created_at FROM power_connections WHERE status <> 'disconnected'`);
    return POWER_CATALOGUE.map((p) => {
      const c = rows.find((r) => r.power_type === p.type);
      return {
        type: p.type,
        group: p.group,
        available: p.oauth !== null && google.googleConfigured(),
        onPlan: planAllowsPower(plan!.features, p.type),
        connection: c ? { id: c.id, status: c.status, account: c.account_label, error: c.error, scopes: c.scopes, lastSyncAt: c.last_sync_at } : null,
      };
    });
  }

  async startConnect(t: Tenant, type: string) {
    const def = POWER_CATALOGUE.find((p) => p.type === type);
    if (!def) throw notFound();
    if (def.oauth !== 'google') throw badRequest('power_coming_soon', 'This Power is coming soon.');
    if (!google.googleConfigured()) throw badRequest('power_not_configured', 'Google connections are not set up on this server yet.');
    const plan = await this.db.one<{ features: PlanFeatures }>(`SELECT p.features FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.id = $1`, [t.businessId]);
    if (!planAllowsPower(plan!.features, type)) throw badRequest('upgrade_needed', 'This Power is not on your plan. Upgrade to use it.');
    const state = randomBytes(24).toString('base64url');
    await this.db.q(`INSERT INTO oauth_states (state, business_id, user_id, power_type, expires_at) VALUES ($1, $2, $3, $4, now() + interval '10 minutes')`, [state, t.businessId, t.userId, type]);
    return { url: google.authUrl(type, state) };
  }

  /** OAuth callback (public). Stores encrypted tokens for the business that started the flow. */
  async finishConnect(state: string, code: string | undefined, error: string | undefined) {
    const s = await this.db.one(`DELETE FROM oauth_states WHERE state = $1 AND expires_at > now() RETURNING *`, [state]);
    if (!s) return { ok: false, reason: 'expired' };
    if (error || !code) return { ok: false, reason: 'declined', power: s.power_type };
    const tokens = await google.exchangeCode(code);
    const granted = (tokens.scope ?? '').split(' ');
    const missing = google.GOOGLE_SCOPES[s.power_type].filter((x) => x.startsWith('https://') && !granted.includes(x));
    if (missing.length) {
      await google.revoke(tokens.access_token);
      return { ok: false, reason: 'permissions', power: s.power_type };
    }
    const email = await google.userEmail(tokens.access_token).catch(() => null);
    await this.db.withTenant(s.business_id, async (tx) => {
      await tx.q(`UPDATE power_connections SET status = 'disconnected', encrypted_tokens = NULL WHERE power_type = $1 AND status <> 'disconnected'`, [s.power_type]);
      const c = await tx.one(
        `INSERT INTO power_connections (power_type, account_label, external_account, encrypted_tokens, scopes, status, connected_by, token_expires_at, last_sync_at)
         VALUES ($1, $2, $2, $3, $4, 'connected', $5, $6, now()) RETURNING id`,
        [s.power_type, email, seal(tokens), granted, s.user_id, new Date(tokens.expires_at)],
      );
      if (s.power_type === 'google_calendar') await tx.q(`UPDATE businesses SET calendar_mode = 'google' WHERE id = $1`, [s.business_id]);
      await postFeed(tx, 'orbit', 'power_connected', { key: 'feed.orbit.power_connected', params: { power: `@power.${s.power_type}` } }, { entityType: 'power', entityId: c.id });
    }, s.user_id);
    await this.audit.write({ businessId: s.business_id, actorId: s.user_id, action: 'power.connect', entity: 'power', after: { type: s.power_type, account: email } });
    return { ok: true, power: s.power_type };
  }

  async disconnect(t: Tenant, id: string) {
    const conn = await this.db.withTenant(t.businessId, (tx) => tx.one(`SELECT * FROM power_connections WHERE id = $1 AND status <> 'disconnected'`, [id]));
    if (!conn) throw notFound();
    const tokens = open<google.GoogleTokens>(conn.encrypted_tokens);
    if (tokens) await google.revoke(tokens.refresh_token ?? tokens.access_token);
    await this.db.withTenant(t.businessId, async (tx) => {
      await tx.q(`UPDATE power_connections SET status = 'disconnected', encrypted_tokens = NULL WHERE id = $1`, [id]);
      if (conn.power_type === 'google_calendar') await tx.q(`UPDATE businesses SET calendar_mode = 'builtin' WHERE id = $1`, [t.businessId]);
      await postFeed(tx, 'orbit', 'power_disconnected', { key: 'feed.orbit.power_disconnected', params: { power: `@power.${conn.power_type}` } }, { entityType: 'power', entityId: id });
    }, t.userId);
    await this.audit.write({ businessId: t.businessId, actorId: t.userId, action: 'power.disconnect', entity: 'power', entityId: id });
    return { ok: true };
  }

  // ---------- Google Calendar ----------

  /** Busy times on the owner's Google Calendar. On failure, Orbit falls back to its own calendar and warns the owner. */
  private async calendarBusy(tx: Tx, from: Date, to: Date) {
    const conn = await this.connection(tx, 'google_calendar');
    if (!conn) return null;
    const key = `${tx.businessId}:${from.toISOString()}:${to.toISOString()}`;
    const hit = this.busyCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return { staffId: null, intervals: hit.intervals };
    try {
      const access = await this.accessToken(tx, conn);
      if (!access) return null;
      const intervals = await google.calendar.freeBusy(access, from, to);
      this.busyCache.set(key, { at: Date.now(), intervals });
      if (this.busyCache.size > 500) this.busyCache.clear();
      return { staffId: null, intervals };
    } catch (e) {
      logger.warn(`calendar busy failed: ${(e as Error).message}`, 'Powers');
      await tx.q(`UPDATE power_connections SET error = 'sync_failed' WHERE id = $1`, [conn.id]);
      return null;
    }
  }

  async syncBooking(businessId: string, bookingId: string, change: 'created' | 'moved' | 'cancelled') {
    await this.db.withTenant(businessId, async (tx) => {
      const conn = await this.connection(tx, 'google_calendar');
      if (!conn) return;
      const access = await this.accessToken(tx, conn);
      if (!access) return;
      const bk = await tx.one(
        `SELECT bk.*, s.name AS service, c.name AS customer, c.phone, st.name AS staff FROM bookings bk JOIN services s ON s.id = bk.service_id
         LEFT JOIN customers c ON c.id = bk.customer_id LEFT JOIN staff st ON st.id = bk.staff_id WHERE bk.id = $1`,
        [bookingId],
      );
      if (!bk) return;
      const event = {
        summary: `${bk.service} — ${bk.customer ?? 'Customer'}`,
        description: `Booked by Orbit${bk.staff ? ` with ${bk.staff}` : ''}. ${bk.phone ?? ''}`.trim(),
        start: { dateTime: new Date(bk.start_at).toISOString() },
        end: { dateTime: new Date(bk.end_at).toISOString() },
        extendedProperties: { private: { orbitBookingId: bk.id } },
      };
      if (change === 'cancelled' || bk.status === 'cancelled') {
        if (bk.external_calendar_event_id) await google.calendar.remove(access, bk.external_calendar_event_id);
      } else if (bk.external_calendar_event_id) {
        await google.calendar.patch(access, bk.external_calendar_event_id, event);
      } else {
        const ev = await google.calendar.insert(access, event);
        await tx.q(`UPDATE bookings SET external_calendar_event_id = $2 WHERE id = $1`, [bk.id, ev.id]);
      }
      await tx.q(`UPDATE power_connections SET last_sync_at = now(), error = NULL WHERE id = $1`, [conn.id]);
    });
  }

  // ---------- Gmail ----------

  /** Every 5 minutes: read new enquiry emails for each business with Gmail connected. */
  async pollAllGmail() {
    // The scheduler only needs WHICH businesses have Gmail; everything else runs inside each business's own context.
    const ids = await this.db.adminTx((tx) => tx.q<{ business_id: string }>(`SELECT DISTINCT business_id FROM power_connections WHERE power_type = 'gmail' AND status = 'connected'`));
    for (const { business_id } of ids) await this.pollGmail(business_id).catch((e) => logger.error(`gmail poll failed: ${e.message}`, e.stack, 'Powers'));
  }

  async pollGmail(businessId: string) {
    const fresh = await this.db.withTenant(businessId, async (tx) => {
      const conn = await this.connection(tx, 'gmail');
      if (!conn) return [];
      const access = await this.accessToken(tx, conn);
      if (!access) return [];
      const out: string[] = [];
      for (const ref of await google.gmail.listUnread(access)) {
        if (await tx.one(`SELECT 1 FROM messages WHERE channel_message_id = $1`, [`gmail:${ref.id}`])) continue;
        const m = google.parseGmail(await google.gmail.get(access, ref.id));
        await google.gmail.markRead(access, ref.id).catch(() => undefined);
        if (!m.email || m.email === conn.external_account || m.autoReply || !m.body) continue;
        const customer = await this.bookings.upsertCustomer(tx, { name: m.name, email: m.email }, 'gmail');
        let conv = await tx.one(`SELECT id FROM conversations WHERE channel = 'gmail' AND external_thread_id = $1`, [m.threadId]);
        if (!conv) {
          conv = await tx.one(`INSERT INTO conversations (customer_id, channel, status, handled_by, external_thread_id, subject) VALUES ($1, 'gmail', 'open', 'aria', $2, $3) RETURNING id`, [customer.id, m.threadId, m.subject]);
        }
        await this.conversations.addMessage(tx, conv.id, { direction: 'in', sender: 'customer', body: m.body, channelMessageId: `gmail:${ref.id}`, meta: { messageId: m.messageId, subject: m.subject } });
        out.push(conv.id);
      }
      await tx.q(`UPDATE power_connections SET last_sync_at = now() WHERE id = $1`, [conn.id]);
      return [...new Set(out)];
    });
    // Aria answers; her reply is sent by the powers.deliver job like any other outbound email.
    for (const convId of fresh) await this.aria.reply(businessId, convId);
    return fresh.length;
  }

  /** Job: deliver one outbound message on its conversation's channel (email today; more channels in Phase 3). */
  async deliver(businessId: string, messageId: string) {
    await this.db.withTenant(businessId, async (tx) => {
      const m = await tx.one(
        `SELECT ms.*, cv.channel, cv.external_thread_id, cv.subject, c.email FROM messages ms JOIN conversations cv ON cv.id = ms.conversation_id
         LEFT JOIN customers c ON c.id = cv.customer_id WHERE ms.id = $1 FOR UPDATE OF ms`,
        [messageId],
      );
      if (!m || m.direction !== 'out' || m.channel !== 'gmail' || m.channel_message_id) return;
      const conn = await this.connection(tx, 'gmail');
      const access = conn && (await this.accessToken(tx, conn));
      if (!access || !m.email) {
        await tx.q(`UPDATE messages SET delivery_status = 'failed' WHERE id = $1`, [m.id]);
        return;
      }
      const lastIn = await tx.one(`SELECT meta FROM messages WHERE conversation_id = $1 AND direction = 'in' ORDER BY created_at DESC LIMIT 1`, [m.conversation_id]);
      const sent = await google.gmail.send(access, google.buildReply({ to: m.email, subject: m.subject ?? '', inReplyTo: lastIn?.meta?.messageId, body: m.body }), m.external_thread_id ?? undefined);
      await tx.q(`UPDATE messages SET delivery_status = 'sent', channel_message_id = $2 WHERE id = $1`, [m.id, `gmail:${sent.id}`]);
    });
  }

  /** Nudge and other agents emailing a customer (new thread). */
  private async sendEmail(tx: Tx, m: OutboundMessage) {
    const conn = await this.connection(tx, 'gmail');
    const access = await this.accessToken(tx, conn);
    if (!access) throw new Error('gmail not available');
    const biz = await tx.one(`SELECT name FROM businesses WHERE id = app_current_business()`);
    await google.gmail.send(access, google.buildReply({ to: m.customer.email!, subject: m.subject ?? `A message from ${biz.name}`, body: m.body }));
    return {};
  }
}

@UseGuards(TenantGuard)
@Controller('powers')
export class PowersController {
  constructor(private readonly db: DbService, private readonly powers: PowersService) {}

  @Get()
  list(@CurrentTenant() t: Tenant) {
    return this.db.withTenant(t.businessId, (tx) => this.powers.list(tx));
  }

  @Roles('owner', 'manager')
  @Post(':type/connect')
  connect(@CurrentTenant() t: Tenant, @Param('type') type: string) {
    return this.powers.startConnect(t, type);
  }

  @Roles('owner', 'manager')
  @Delete(':id')
  disconnect(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.powers.disconnect(t, id);
  }
}

@Controller('powers/oauth')
export class PowersOAuthController {
  constructor(private readonly powers: PowersService) {}

  @Public()
  @Get('callback')
  async callback(@Query('state') state: string, @Query('code') code: string | undefined, @Query('error') error: string | undefined, @Res() res: Response) {
    const r = await this.powers.finishConnect(String(state ?? ''), code, error).catch((e) => {
      logger.error(`oauth callback failed: ${e.message}`, e.stack, 'Powers');
      return { ok: false, reason: 'failed', power: undefined as string | undefined };
    });
    const q = new URLSearchParams({ view: 'powers', power: r.power ?? '', result: r.ok ? 'connected' : r.reason ?? 'failed' });
    res.redirect(302, `${runtime.webBaseUrl}/bridge?${q}`);
  }
}

@Module({ controllers: [PowersController, PowersOAuthController], providers: [PowersService], exports: [PowersService] })
export class PowersModule {}
