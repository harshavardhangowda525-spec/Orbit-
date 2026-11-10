import { Body, Controller, Get, Injectable, Module, OnModuleInit, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { planAllowsPower, type PlanFeatures } from '@orbit/shared';
import { DbService, type Tx } from '../db/db.service';
import { JobsService } from '../jobs/jobs.service';
import { BookingsService } from '../bookings/bookings.service';
import { AriaService } from '../ai/aria.service';
import { ConversationsService } from '../inbox/conversations.service';
import { AuditService } from '../audit/audit.service';
import { CurrentTenant, Public, Roles, TenantGuard } from '../auth/guards';
import type { Tenant } from '../auth/types';
import { badRequest } from '../common/errors';
import { postFeed } from '../common/feed';
import { liveToBusiness } from '../realtime/live';
import { runtime } from '../config';
import { logger } from '../logger';
import { open, seal } from '../powers/crypto';
import { ChannelsService, type OutboundRow } from './channels.service';
import * as ms from './microsoft';

// ---------------------------------------------------------------- SMS (MSG91, DLT)

const MSG91_FLOW = 'https://control.msg91.com/api/v5/flow';
/** DLT allows at most 30 characters per {#var#}. */
const DLT_VAR_MAX = 30;

export class SmsError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Fill the DLT template's variables with the message (30 characters each, in order). */
export function smsVariables(text: string, count: number): Record<string, string> {
  const clean = text.replace(/\s+/g, ' ').trim();
  const max = DLT_VAR_MAX * count;
  const body = clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) out[`var${i + 1}`] = body.slice(i * DLT_VAR_MAX, (i + 1) * DLT_VAR_MAX);
  return out;
}

async function sendSms(authKey: string, templateId: string, mobile: string, vars: Record<string, string>) {
  const res = await fetch(MSG91_FLOW, {
    method: 'POST',
    headers: { authkey: authKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ template_id: templateId, short_url: '0', recipients: [{ mobiles: mobile.replace(/\D/g, ''), ...vars }] }),
    signal: AbortSignal.timeout(15_000),
  });
  const d: any = await res.json().catch(() => ({}));
  if (!res.ok || d.type === 'error') throw new SmsError(res.ok ? 400 : res.status, d.message ?? `SMS provider error ${res.status}`);
  return String(d.request_id ?? d.message ?? '');
}

const SmsConnect = z.object({
  authKey: z.string().trim().min(10).max(200),
  templateId: z.string().trim().min(5).max(100),
  senderId: z.string().trim().regex(/^[A-Z]{6}$/i, 'The sender ID (header) is 6 letters, like GLOWST.'),
  variables: z.coerce.number().int().min(1).max(10).default(4),
});

/**
 * Email and SMS channels.
 *
 * Outlook: owners sign in with Microsoft; Orbit reads new enquiries every few
 * minutes, Aria answers in the same thread, and reminders go out by email.
 * SMS (India): messages go through MSG91 on a DLT-approved template whose
 * variables carry the text. SMS is one-way here: customers reply on WhatsApp.
 */
@Injectable()
export class EmailSmsService implements OnModuleInit {
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
    this.channels.registerSender('outlook', (tx, m) => this.sendOutlook(tx, m));
    this.channels.register('outlook', {
      canReach: async (tx, m) => !!m.customer.email && m.customer.consent?.email !== false && !!(await this.connection(tx, 'outlook')),
      send: (tx, m) => this.startThread(tx, 'outlook', m.customer.id, null, m.agent, m.body),
    });
    this.channels.registerSender('sms', (tx, m) => this.sendSmsRow(tx, m));
    this.channels.register('sms', {
      canReach: async (tx, m) => !!m.customer.phone && m.customer.consent?.sms !== false && !!(await this.connection(tx, 'sms')),
      send: (tx, m) => this.startThread(tx, 'sms', m.customer.id, m.customer.phone!.replace(/\D/g, ''), m.agent, m.body),
    });
    this.jobs.register('powers.outlook_poll', () => this.pollAll());
  }

  private connection(tx: Tx, type: string) {
    return tx.one(`SELECT * FROM power_connections WHERE power_type = $1 AND status = 'connected' ORDER BY created_at DESC LIMIT 1`, [type]);
  }

  private async allowed(businessId: string, type: string) {
    const plan = await this.db.one<{ features: PlanFeatures }>(`SELECT p.features FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.id = $1`, [businessId]);
    if (!planAllowsPower(plan!.features, type)) throw badRequest('upgrade_needed', 'This Power is not on your plan. Upgrade to use it.');
  }

  private async save(t: Tenant, type: string, label: string | null, account: string | null, secret: unknown, settings: Record<string, unknown>) {
    const id = await this.db.withTenant(t.businessId, async (tx) => {
      await tx.q(`UPDATE power_connections SET status = 'disconnected', encrypted_tokens = NULL WHERE power_type = $1 AND status <> 'disconnected'`, [type]);
      const c = await tx.one(
        `INSERT INTO power_connections (power_type, account_label, external_account, encrypted_tokens, settings, status, connected_by, last_sync_at)
         VALUES ($1, $2, $3, $4, $5, 'connected', $6, now()) RETURNING id`,
        [type, label, account, seal(secret), JSON.stringify(settings), t.userId],
      );
      await postFeed(tx, 'orbit', 'power_connected', { key: 'feed.orbit.power_connected', params: { power: `@power.${type}` } }, { entityType: 'power', entityId: c.id });
      liveToBusiness(tx, { type: 'notification.new' });
      return c.id as string;
    }, t.userId);
    await this.audit.write({ businessId: t.businessId, actorId: t.userId, action: 'power.connect', entity: 'power', entityId: id, after: { type, account: label } });
    return id;
  }

  /** A thread Orbit starts (reminders, follow-ups, the owner asking Orbit): the delivery job sends it. */
  private async startThread(tx: Tx, channel: string, customerId: string, thread: string | null, agent: string, body: string) {
    let conv = thread ? await tx.one(`SELECT id FROM conversations WHERE channel = $1 AND external_thread_id = $2`, [channel, thread]) : null;
    if (!conv) {
      conv = await tx.one(`INSERT INTO conversations (customer_id, channel, status, handled_by, external_thread_id, last_message_at) VALUES ($1, $2, 'open', 'aria', $3, now()) RETURNING id`, [customerId, channel, thread]);
    }
    await this.conversations.addMessage(tx, conv.id, { direction: 'out', sender: agent, body });
    return { conversationId: conv.id as string };
  }

  // ---------- SMS ----------

  async connectSms(t: Tenant, raw: unknown) {
    await this.allowed(t.businessId, 'sms');
    const b = SmsConnect.safeParse(raw);
    if (!b.success) throw badRequest('invalid_input', b.error.issues[0]?.message ?? 'Please check the details.');
    const sender = b.data.senderId.toUpperCase();
    const id = await this.save(t, 'sms', `${sender} · MSG91`, sender, { authKey: b.data.authKey }, { templateId: b.data.templateId, senderId: sender, variables: b.data.variables });
    return { ok: true, id, account: `${sender} · MSG91` };
  }

  private async sendSmsRow(tx: Tx, m: OutboundRow) {
    const conn = await this.connection(tx, 'sms');
    const secret = conn && open<{ authKey: string }>(conn.encrypted_tokens);
    if (!conn || !secret) throw new SmsError(400, 'SMS is not connected. Connect it in Powers.');
    if (!m.external_thread_id) throw new SmsError(400, 'This conversation has no phone number.');
    const id = await sendSms(secret.authKey, conn.settings.templateId, m.external_thread_id, smsVariables(m.body, Number(conn.settings.variables) || 4));
    return { channelMessageId: `sms:${id || m.id}` };
  }

  // ---------- Outlook ----------

  async startOutlook(t: Tenant) {
    if (!ms.msConfig.ready) throw badRequest('power_not_configured', 'Outlook connections are not set up on this server yet (MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET).');
    await this.allowed(t.businessId, 'outlook');
    const state = randomBytes(24).toString('base64url');
    await this.db.q(`INSERT INTO oauth_states (state, business_id, user_id, power_type, expires_at) VALUES ($1, $2, $3, 'outlook', now() + interval '10 minutes')`, [state, t.businessId, t.userId]);
    return { url: ms.authUrl(state) };
  }

  async finishOutlook(state: string, code: string | undefined, error: string | undefined) {
    const s = await this.db.one(`DELETE FROM oauth_states WHERE state = $1 AND expires_at > now() AND power_type = 'outlook' RETURNING *`, [state]);
    if (!s) return { ok: false, reason: 'expired' };
    if (error || !code) return { ok: false, reason: 'declined' };
    const tokens = await ms.exchangeCode(code);
    const email = await ms.mailbox(tokens.access_token).catch(() => null);
    await this.save({ businessId: s.business_id, userId: s.user_id } as Tenant, 'outlook', email, email, tokens, {});
    return { ok: true };
  }

  private async access(tx: Tx, conn: any): Promise<string | null> {
    const t = open<ms.MsTokens>(conn.encrypted_tokens);
    if (!t) return null;
    if (t.expires_at > Date.now() + 60_000) return t.access_token;
    if (!t.refresh_token) return this.broken(tx, conn);
    try {
      const fresh = await ms.refresh(t.refresh_token);
      await tx.q(`UPDATE power_connections SET encrypted_tokens = $2 WHERE id = $1`, [conn.id, seal(fresh)]);
      return fresh.access_token;
    } catch (e) {
      if (e instanceof ms.MsError && (e.status === 400 || e.status === 401)) return this.broken(tx, conn);
      throw e;
    }
  }

  private async broken(tx: Tx, conn: any) {
    await tx.q(`UPDATE power_connections SET status = 'error', error = 'token_expired' WHERE id = $1`, [conn.id]);
    await tx.q(`INSERT INTO notifications (user_id, type, title, link) VALUES (NULL, 'power_disconnected', $1, '/bridge?view=powers')`, [JSON.stringify({ key: 'notify.power_broken', params: { power: '@power.outlook' } })]);
    liveToBusiness(tx, { type: 'notification.new' });
    return null;
  }

  async pollAll() {
    const ids = await this.db.adminTx((tx) => tx.q<{ business_id: string }>(`SELECT DISTINCT business_id FROM power_connections WHERE power_type = 'outlook' AND status = 'connected'`));
    for (const { business_id } of ids) await this.poll(business_id).catch((e) => logger.error(`outlook poll failed: ${e.message}`, e.stack, 'Channels'));
  }

  /** New enquiries -> inbox (same customer as on other channels, by email) -> Aria answers in the thread. */
  async poll(businessId: string) {
    const fresh = await this.db.withTenant(businessId, async (tx) => {
      const conn = await this.connection(tx, 'outlook');
      if (!conn) return [];
      const access = await this.access(tx, conn);
      if (!access) return [];
      const out: string[] = [];
      for (const m of await ms.unread(access)) {
        if (await tx.one(`SELECT 1 FROM messages WHERE channel_message_id = $1`, [`ol:${m.id}`])) continue;
        await ms.markRead(access, m.id).catch(() => undefined);
        if (!m.email || m.email === conn.external_account || m.autoReply || !m.body) continue;
        const customer = await this.bookings.upsertCustomer(tx, { name: m.name, email: m.email }, 'outlook');
        let conv = await tx.one(`SELECT id FROM conversations WHERE channel = 'outlook' AND external_thread_id = $1`, [m.conversationId]);
        if (!conv) {
          conv = await tx.one(`INSERT INTO conversations (customer_id, channel, status, handled_by, external_thread_id, subject) VALUES ($1, 'outlook', 'open', 'aria', $2, $3) RETURNING id`, [customer.id, m.conversationId, m.subject]);
        }
        await this.conversations.addMessage(tx, conv.id, { direction: 'in', sender: 'customer', body: m.body, channelMessageId: `ol:${m.id}`, meta: { outlookId: m.id, subject: m.subject } });
        out.push(conv.id);
      }
      await tx.q(`UPDATE power_connections SET last_sync_at = now() WHERE id = $1`, [conn.id]);
      return [...new Set(out)];
    });
    for (const convId of fresh) await this.aria.reply(businessId, convId);
    return fresh.length;
  }

  private async sendOutlook(tx: Tx, m: OutboundRow) {
    const conn = await this.connection(tx, 'outlook');
    const access = conn && (await this.access(tx, conn));
    if (!access) throw new ms.MsError(400, 'Outlook is not connected. Connect it in Powers.');
    const lastIn = await tx.one(`SELECT meta FROM messages WHERE conversation_id = $1 AND direction = 'in' AND meta ? 'outlookId' ORDER BY created_at DESC LIMIT 1`, [m.conversation_id]);
    if (lastIn?.meta?.outlookId) await ms.reply(access, lastIn.meta.outlookId, m.body);
    else {
      const c = await tx.one(`SELECT c.email, b.name AS business FROM conversations cv JOIN customers c ON c.id = cv.customer_id, businesses b WHERE cv.id = $1 AND b.id = app_current_business()`, [m.conversation_id]);
      if (!c?.email) throw new ms.MsError(400, 'This customer has no email address.');
      await ms.send(access, c.email, `A message from ${c.business}`, m.body);
    }
    return { channelMessageId: `ol:out:${m.id}` };
  }
}

@UseGuards(TenantGuard)
@Controller('channels')
export class EmailSmsController {
  constructor(private readonly svc: EmailSmsService) {}

  @Roles('owner', 'manager')
  @Post('sms/connect')
  sms(@CurrentTenant() t: Tenant, @Body() body: unknown) {
    return this.svc.connectSms(t, body);
  }

  @Roles('owner', 'manager')
  @Post('outlook/connect')
  outlook(@CurrentTenant() t: Tenant) {
    return this.svc.startOutlook(t);
  }
}

@Controller('powers/oauth/microsoft')
export class MicrosoftOAuthController {
  constructor(private readonly svc: EmailSmsService) {}

  @Public()
  @Get('callback')
  async callback(@Query('state') state: string, @Query('code') code: string | undefined, @Query('error') error: string | undefined, @Res() res: Response) {
    const r = await this.svc.finishOutlook(String(state ?? ''), code, error).catch((e) => {
      logger.error(`microsoft callback failed: ${e.message}`, e.stack, 'Channels');
      return { ok: false, reason: 'failed' };
    });
    const q = new URLSearchParams({ view: 'powers', power: 'outlook', result: r.ok ? 'connected' : (r as any).reason ?? 'failed' });
    res.redirect(302, `${runtime.webBaseUrl}/bridge?${q}`);
  }
}

@Module({ controllers: [EmailSmsController, MicrosoftOAuthController], providers: [EmailSmsService], exports: [EmailSmsService] })
export class EmailSmsModule {}
