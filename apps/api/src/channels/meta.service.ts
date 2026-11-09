import { Body, Controller, Get, Headers, HttpCode, Injectable, Module, OnModuleInit, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
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
import { AppError, badRequest, notFound } from '../common/errors';
import { ZodPipe } from '../common/zod.pipe';
import { postFeed } from '../common/feed';
import { liveToBusiness } from '../realtime/live';
import { logger } from '../logger';
import { open, seal } from '../powers/crypto';
import { ChannelsService, type OutboundRow } from './channels.service';
import * as meta from './meta';
import type { Inbound, MetaChannel, StatusUpdate } from './meta';

const DAY = 24 * 60 * 60 * 1000;
const PREFIX: Record<MetaChannel, string> = { whatsapp: 'wa', messenger: 'fbm', instagram: 'ig' };
const STOP = /^\s*(stop|unsubscribe|stop messages)\s*$/i;
const START = /^\s*(start|unstop|subscribe)\s*$/i;

interface Creds {
  token: string;
  /** WhatsApp phone_number_id, Facebook page id, or Instagram account id: where webhooks come from. */
  accountId: string;
  /** Page that sends Messenger / Instagram replies. */
  pageId?: string;
}

const Connect = {
  whatsapp: z.object({
    phoneNumberId: z.string().trim().regex(/^\d{5,30}$/, 'The phone number ID is a long number from WhatsApp → API Setup.'),
    accessToken: z.string().trim().min(20).max(1000),
    templateName: z.string().trim().max(512).optional().or(z.literal('')),
    templateLanguage: z.string().trim().max(10).optional().or(z.literal('')),
  }),
  messenger: z.object({ pageId: z.string().trim().regex(/^\d{5,30}$/), accessToken: z.string().trim().min(20).max(1000) }),
  instagram: z.object({ instagramId: z.string().trim().regex(/^\d{5,30}$/), pageId: z.string().trim().regex(/^\d{5,30}$/), accessToken: z.string().trim().min(20).max(1000) }),
};

/**
 * WhatsApp, Messenger and Instagram for customers. Incoming messages land in the
 * unified inbox (same customer across channels where a phone number links them)
 * and Aria answers; outgoing messages follow Meta's rules: free replies within 24
 * hours of the customer's last message, an approved template (WhatsApp) or a
 * person's reply (Messenger/Instagram, up to 7 days) after that.
 */
@Injectable()
export class MetaChannelsService implements OnModuleInit {
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
    for (const ch of meta.META_CHANNELS) this.channels.registerSender(ch, (tx, m) => this.send(tx, m));
    // Orbit starting a WhatsApp conversation (reminders, follow-ups, the owner asking Orbit to message someone).
    this.channels.register('whatsapp', {
      canReach: async (tx, m) => !!m.customer.phone && m.customer.consent?.whatsapp !== false && !!(await this.connection(tx, 'whatsapp')),
      send: (tx, m) => this.startWhatsApp(tx, m.customer.id, m.customer.phone!, m.agent, m.body),
    });
    this.jobs.register('channels.reply', (d) => this.aria.reply(d.businessId, d.conversationId));
  }

  private connection(tx: Tx, type: MetaChannel) {
    return tx.one(`SELECT * FROM power_connections WHERE power_type = $1 AND status = 'connected' ORDER BY created_at DESC LIMIT 1`, [type]);
  }

  // ---------- connecting ----------

  async connect(t: Tenant, type: MetaChannel, raw: unknown) {
    if (!meta.metaConfig.ready) throw badRequest('power_not_configured', "Orbit's Meta app is not set up on this server yet (META_APP_SECRET and META_VERIFY_TOKEN on orbit-api).");
    const plan = await this.db.one<{ features: PlanFeatures }>(`SELECT p.features FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.id = $1`, [t.businessId]);
    if (!planAllowsPower(plan!.features, type)) throw badRequest('upgrade_needed', 'This Power is not on your plan. Upgrade to use it.');
    const parsed = Connect[type].safeParse(raw);
    if (!parsed.success) throw badRequest('invalid_input', parsed.error.issues[0]?.message ?? 'Please check the details.');
    const b: any = parsed.data;
    const creds: Creds =
      type === 'whatsapp' ? { token: b.accessToken, accountId: b.phoneNumberId }
        : type === 'messenger' ? { token: b.accessToken, accountId: b.pageId, pageId: b.pageId }
          : { token: b.accessToken, accountId: b.instagramId, pageId: b.pageId };
    let label: string;
    try {
      label = await meta.checkAccount(type, creds.accountId, creds.token);
      if (creds.pageId) await meta.subscribeApp(type, creds.pageId, creds.token);
    } catch (e) {
      throw badRequest('meta_check_failed', `Meta did not accept these details: ${(e as Error).message}`);
    }
    const taken = await this.db.one<{ business_id: string }>(`SELECT business_id FROM channel_routes WHERE channel = $1 AND external_id = $2`, [type, creds.accountId]);
    if (taken && taken.business_id !== t.businessId) throw new AppError(409, 'already_connected', 'This account is already connected to another business on Orbit.');
    const settings = type === 'whatsapp' && b.templateName ? { templateName: b.templateName, templateLanguage: b.templateLanguage || 'en' } : {};
    const id = await this.db.withTenant(t.businessId, async (tx) => {
      const old = await tx.q<{ id: string }>(`UPDATE power_connections SET status = 'disconnected', encrypted_tokens = NULL WHERE power_type = $1 AND status <> 'disconnected' RETURNING id`, [type]);
      if (old.length) await tx.q(`DELETE FROM channel_routes WHERE power_connection_id = ANY($1::uuid[])`, [old.map((o) => o.id)]);
      const c = await tx.one(
        `INSERT INTO power_connections (power_type, account_label, external_account, encrypted_tokens, settings, status, connected_by, last_sync_at)
         VALUES ($1, $2, $3, $4, $5, 'connected', $6, now()) RETURNING id`,
        [type, label, creds.accountId, seal(creds), JSON.stringify(settings), t.userId],
      );
      await tx.q(
        `INSERT INTO channel_routes (channel, external_id, business_id, power_connection_id) VALUES ($1, $2, app_current_business(), $3)
         ON CONFLICT (channel, external_id) DO UPDATE SET power_connection_id = EXCLUDED.power_connection_id`,
        [type, creds.accountId, c.id],
      );
      await postFeed(tx, 'orbit', 'power_connected', { key: 'feed.orbit.power_connected', params: { power: `@power.${type}` } }, { entityType: 'power', entityId: c.id });
      liveToBusiness(tx, { type: 'notification.new' });
      return c.id as string;
    }, t.userId);
    await this.audit.write({ businessId: t.businessId, actorId: t.userId, action: 'power.connect', entity: 'power', entityId: id, after: { type, account: label } });
    return { ok: true, id, account: label, webhookUrl: '/webhooks/meta' };
  }

  // ---------- receiving ----------

  async handleWebhook(body: unknown) {
    const { messages, statuses } = meta.parseWebhook(body);
    for (const s of statuses) await this.status(s);
    const toAnswer = new Map<string, string>();
    for (const m of messages) {
      const r = await this.inbound(m);
      if (r?.answer) toAnswer.set(r.conversationId, r.businessId);
    }
    // Answer after the webhook returns (Meta expects a quick 200).
    for (const [conversationId, businessId] of toAnswer) {
      await this.jobs.enqueue('channels.reply', { businessId, conversationId }, { jobId: `reply:${conversationId}:${Date.now()}` });
    }
    return { messages: messages.length, statuses: statuses.length };
  }

  private route(channel: MetaChannel, accountId: string) {
    // Platform table, exact lookup only: which business owns this number / page.
    return this.db.one<{ business_id: string; power_connection_id: string }>(`SELECT business_id, power_connection_id FROM channel_routes WHERE channel = $1 AND external_id = $2`, [channel, accountId]);
  }

  private async inbound(m: Inbound): Promise<{ businessId: string; conversationId: string; answer: boolean } | null> {
    const route = await this.route(m.channel, m.accountId);
    if (!route) {
      logger.warn(`${m.channel} message for an account no business has connected (${m.accountId})`, 'Channels');
      return null;
    }
    return this.db.withTenant(route.business_id, async (tx) => {
      const conn = await tx.one(`SELECT * FROM power_connections WHERE id = $1 AND status = 'connected'`, [route.power_connection_id]);
      if (!conn) return null;
      const channelMessageId = `${PREFIX[m.channel]}:${m.messageId}`;
      if (await tx.one(`SELECT 1 FROM messages WHERE channel_message_id = $1`, [channelMessageId])) return null; // Meta retries; never twice.

      const customer = await this.customerFor(tx, m, conn);
      const optingOut = STOP.test(m.text);
      const optingIn = START.test(m.text);
      if (optingOut) await tx.q(`UPDATE customers SET opted_out_at = opted_out_at || jsonb_build_object($2::text, now()) WHERE id = $1`, [customer.id, m.channel]);
      if (optingIn) await tx.q(`UPDATE customers SET opted_out_at = opted_out_at - $2::text, consent = consent || jsonb_build_object($2::text, true) WHERE id = $1`, [customer.id, m.channel]);

      let conv = await tx.one(`SELECT id, handled_by, customer_id FROM conversations WHERE channel = $1 AND external_thread_id = $2`, [m.channel, m.from]);
      if (!conv) {
        conv = await tx.one(
          `INSERT INTO conversations (customer_id, channel, status, handled_by, external_thread_id, last_message_at) VALUES ($1, $2, 'open', 'aria', $3, now()) RETURNING id, handled_by, customer_id`,
          [customer.id, m.channel, m.from],
        );
      } else if (!conv.customer_id) {
        await tx.q(`UPDATE conversations SET customer_id = $2 WHERE id = $1`, [conv.id, customer.id]);
      }
      await this.conversations.addMessage(tx, conv.id, { direction: 'in', sender: 'customer', body: m.text, channelMessageId });
      if (optingOut || optingIn) {
        // Confirm without Aria. Customers can always stop messages from a business.
        await this.conversations.addMessage(tx, conv.id, {
          direction: 'out',
          sender: 'orbit',
          body: optingOut ? 'You will not get more messages from us here. Reply START to hear from us again.' : 'Welcome back! You will get messages from us here again.',
        });
      }
      await tx.q(`UPDATE power_connections SET last_sync_at = now(), error = NULL WHERE id = $1`, [conn.id]);
      return { businessId: route.business_id, conversationId: conv.id as string, answer: !optingOut && !optingIn };
    });
  }

  /** WhatsApp customers are their phone number (so the same person is linked across channels); others by their channel id. */
  private async customerFor(tx: Tx, m: Inbound, conn: any) {
    if (m.channel === 'whatsapp') {
      const c = await this.bookings.upsertCustomer(tx, { name: m.name, phone: `+${m.from}` }, 'whatsapp');
      // They wrote to the business first: replies on WhatsApp are welcome (unless they opted out).
      await tx.q(`UPDATE customers SET consent = consent || '{"whatsapp": true}' WHERE id = $1 AND NOT (opted_out_at ? 'whatsapp')`, [c.id]);
      return c;
    }
    const known = await tx.one(
      `SELECT c.* FROM customer_identities i JOIN customers c ON c.id = i.customer_id WHERE i.channel = $1 AND i.external_id = $2 AND c.deleted_at IS NULL`,
      [m.channel, m.from],
    );
    if (known) return known;
    const creds = open<Creds>(conn.encrypted_tokens);
    const name = creds ? await meta.senderName(m.channel, m.from, creds.token) : null;
    const c = await tx.one(`INSERT INTO customers (name, source, consent) VALUES ($1, $2, $3) RETURNING *`, [name, m.channel, JSON.stringify({ [m.channel]: true, marketing: false })]);
    await tx.q(`INSERT INTO customer_identities (customer_id, channel, external_id) VALUES ($1, $2, $3)`, [c.id, m.channel, m.from]);
    return c;
  }

  private async status(s: StatusUpdate) {
    const route = await this.route(s.channel, s.accountId);
    if (!route) return;
    await this.db.withTenant(route.business_id, async (tx) => {
      const row = await tx.one(
        `UPDATE messages SET delivery_status = $2, delivery_error = $3 WHERE channel_message_id = $1
           AND NOT (delivery_status = 'read' AND $2 IN ('sent', 'delivered')) RETURNING id, conversation_id`,
        [`${PREFIX[s.channel]}:${s.messageId}`, s.status, s.error],
      );
      if (row) liveToBusiness(tx, { type: 'conversation.updated', data: { id: row.conversation_id } });
    });
  }

  // ---------- sending ----------

  /** Sends one outbound inbox message on its conversation's channel (called by the delivery job). */
  private async send(tx: Tx, m: OutboundRow): Promise<{ channelMessageId: string }> {
    const channel = m.channel as MetaChannel;
    const conn = await this.connection(tx, channel);
    const creds = conn && open<Creds>(conn.encrypted_tokens);
    if (!conn || !creds) throw new meta.MetaError(400, `${channel} is not connected. Connect it in Powers.`);
    const to = m.external_thread_id;
    if (!to) throw new meta.MetaError(400, 'This conversation has no recipient.');
    const lastIn = await tx.one<{ at: Date | null }>(`SELECT max(created_at) AS at FROM messages WHERE conversation_id = $1 AND direction = 'in'`, [m.conversation_id]);
    const age = lastIn?.at ? Date.now() - new Date(lastIn.at).getTime() : Infinity;
    let r: meta.SendResult;
    if (channel === 'whatsapp') {
      if (age < DAY) r = await meta.sendWhatsAppText(creds.accountId, creds.token, to, m.body);
      else if (conn.settings?.templateName) r = await meta.sendWhatsAppTemplate(creds.accountId, creds.token, to, { name: conn.settings.templateName, language: conn.settings.templateLanguage || 'en' }, m.body);
      else throw new meta.MetaError(400, 'The customer last wrote more than 24 hours ago. WhatsApp then needs an approved message template: add one in Powers → WhatsApp.');
    } else {
      const byPerson = m.sender.startsWith('user:');
      if (age < DAY) r = await meta.sendPageMessage(creds.pageId!, creds.token, to, m.body, false);
      else if (byPerson && age < 7 * DAY) r = await meta.sendPageMessage(creds.pageId!, creds.token, to, m.body, true);
      else throw new meta.MetaError(400, `The customer last wrote more than ${byPerson ? '7 days' : '24 hours'} ago, so ${channel === 'instagram' ? 'Instagram' : 'Messenger'} does not allow a new message.`);
    }
    return { channelMessageId: `${PREFIX[channel]}:${r.id}` };
  }

  /** Opens (or reuses) the customer's WhatsApp thread and queues the message; delivery picks text or template. */
  private async startWhatsApp(tx: Tx, customerId: string, phone: string, agent: string, body: string) {
    const thread = phone.replace(/\D/g, '');
    let conv = await tx.one(`SELECT id FROM conversations WHERE channel = 'whatsapp' AND external_thread_id = $1`, [thread]);
    if (!conv) {
      conv = await tx.one(`INSERT INTO conversations (customer_id, channel, status, handled_by, external_thread_id, last_message_at) VALUES ($1, 'whatsapp', 'open', 'aria', $2, now()) RETURNING id`, [customerId, thread]);
    }
    await this.conversations.addMessage(tx, conv.id, { direction: 'out', sender: agent, body });
    return { conversationId: conv.id as string };
  }
}

@UseGuards(TenantGuard)
@Controller('channels')
export class ChannelsController {
  constructor(private readonly svc: MetaChannelsService) {}

  @Roles('owner', 'manager')
  @Post(':type/connect')
  connect(@CurrentTenant() t: Tenant, @Param('type') type: string, @Body() body: unknown) {
    if (!(meta.META_CHANNELS as string[]).includes(type)) throw notFound();
    return this.svc.connect(t, type as MetaChannel, body);
  }
}

/** One webhook for every business: Meta → Orbit (WhatsApp, Messenger, Instagram). */
@Controller('webhooks/meta')
export class MetaWebhookController {
  constructor(private readonly svc: MetaChannelsService) {}

  /** Meta's one-time check when the webhook URL is saved in the Meta app. */
  @Public()
  @SkipThrottle()
  @Get()
  verify(@Query('hub.mode') mode: string, @Query('hub.verify_token') token: string, @Query('hub.challenge') challenge: string, @Res() res: Response) {
    if (mode === 'subscribe' && meta.metaConfig.verifyToken && token === meta.metaConfig.verifyToken) return res.type('text/plain').send(String(challenge ?? ''));
    return res.status(403).send('forbidden');
  }

  @Public()
  @SkipThrottle()
  @Post()
  @HttpCode(200)
  async receive(@Req() req: Request, @Headers('x-hub-signature-256') signature: string | undefined) {
    if (!meta.validSignature((req as any).rawBody, signature)) throw new AppError(401, 'bad_signature', 'Invalid signature.');
    await this.svc.handleWebhook(req.body);
    return 'EVENT_RECEIVED';
  }
}

@Module({ controllers: [ChannelsController, MetaWebhookController], providers: [MetaChannelsService], exports: [MetaChannelsService] })
export class MetaChannelsModule {}
