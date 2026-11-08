import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { CurrentTenant, TenantGuard } from '../auth/guards';
import type { Tenant } from '../auth/types';
import { ZodPipe } from '../common/zod.pipe';
import { notFound } from '../common/errors';
import { ConversationsService } from './conversations.service';
import { AriaService } from '../ai/aria.service';

const Filters = z.object({
  status: z.enum(['open', 'waiting_customer', 'waiting_staff', 'closed', 'needs_me']).optional(),
  channel: z.string().max(30).optional(),
  handledBy: z.enum(['aria', 'human', 'me']).optional(),
});

/** Unified inbox: every channel in one list, with take over / hand back to Aria. */
@UseGuards(TenantGuard)
@Controller('inbox')
export class InboxController {
  constructor(private readonly db: DbService, private readonly conversations: ConversationsService, private readonly aria: AriaService) {}

  @Get()
  list(@CurrentTenant() t: Tenant, @Query(new ZodPipe(Filters)) f: z.infer<typeof Filters>) {
    return this.db.withTenant(t.businessId, (tx) =>
      tx.q(
        `SELECT cv.id, cv.channel, cv.status, cv.handled_by AS "handledBy", cv.last_message_at AS "lastMessageAt", cv.language,
                c.id AS "customerId", c.name AS customer, c.phone,
                (SELECT body FROM messages m WHERE m.conversation_id = cv.id ORDER BY created_at DESC LIMIT 1) AS preview,
                (SELECT count(*)::int FROM messages m WHERE m.conversation_id = cv.id) AS "messageCount"
         FROM conversations cv LEFT JOIN customers c ON c.id = cv.customer_id
         WHERE ($1::text IS NULL OR ($1 = 'needs_me' AND cv.status = 'waiting_staff') OR cv.status = $1)
           AND ($2::text IS NULL OR cv.channel = $2)
           AND ($3::text IS NULL OR ($3 = 'aria' AND cv.handled_by = 'aria') OR ($3 = 'human' AND cv.handled_by <> 'aria') OR ($3 = 'me' AND cv.handled_by = $4))
           AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = cv.id AND m.direction = 'in')
         ORDER BY (cv.status = 'waiting_staff') DESC, cv.last_message_at DESC NULLS LAST LIMIT 100`,
        [f.status ?? null, f.channel ?? null, f.handledBy ?? null, `user:${t.userId}`],
      ),
    );
  }

  @Get(':id')
  async get(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.db.withTenant(t.businessId, async (tx) => {
      const conv = await tx.one(`SELECT id, channel, status, handled_by AS "handledBy", language, customer_id, subject FROM conversations WHERE id = $1`, [id]);
      if (!conv) return null;
      const customer = conv.customer_id
        ? await tx.one(
            `SELECT id, name, phone, email, visit_count AS "visitCount", lifetime_spend::float AS "lifetimeSpend", last_visit_at AS "lastVisitAt", consent, opted_out_at AS "optedOut"
             FROM customers WHERE id = $1`,
            [conv.customer_id],
          )
        : null;
      // Full history across every channel this customer has used.
      const messages = await tx.q(
        `SELECT m.id, m.direction, m.sender, m.body, m.created_at AS at, cv.channel, m.conversation_id AS "conversationId"
         FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
         WHERE ${customer ? 'cv.customer_id = $1' : 'cv.id = $1'} ORDER BY m.created_at LIMIT 500`,
        [customer ? customer.id : id],
      );
      const upcoming = customer
        ? await tx.q(`SELECT bk.id, bk.start_at AS "startAt", s.name AS service FROM bookings bk JOIN services s ON s.id = bk.service_id WHERE bk.customer_id = $1 AND bk.status IN ('pending','confirmed') AND bk.start_at > now() ORDER BY bk.start_at LIMIT 3`, [customer.id])
        : [];
      const { customer_id, ...c } = conv;
      return { conversation: c, customer, messages, upcoming };
    });
    if (!r) throw notFound();
    return r;
  }

  @Post(':id/reply')
  reply(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ body: z.string().trim().min(1).max(2000) }))) b: { body: string }) {
    return this.db.withTenant(t.businessId, (tx) => this.conversations.staffReply(tx, id, t.userId, b.body), t.userId);
  }

  @Post(':id/takeover')
  takeover(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(t.businessId, (tx) => this.conversations.takeover(tx, id, t.userId), t.userId);
  }

  /** Hand back to Aria; if the customer is waiting for an answer, Aria replies straight away. */
  @Post(':id/handback')
  async handback(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.db.withTenant(t.businessId, (tx) => this.conversations.handback(tx, id, t.userId), t.userId);
    const last = await this.db.withTenant(t.businessId, (tx) => tx.one(`SELECT direction FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`, [id]));
    if (last?.direction === 'in') await this.aria.reply(t.businessId, id);
    return r;
  }

  @Post(':id/close')
  async close(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.db.withTenant(t.businessId, (tx) => tx.one(`UPDATE conversations SET status = 'closed' WHERE id = $1 RETURNING id`, [id]));
    if (!r) throw notFound();
    return { ok: true };
  }
}

/** In-app notifications (the bell). */
@UseGuards(TenantGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly db: DbService) {}

  @Get()
  list(@CurrentTenant() t: Tenant) {
    return this.db.withTenant(t.businessId, async (tx) => ({
      unread: (await tx.one(`SELECT count(*)::int AS n FROM notifications WHERE read_at IS NULL AND (user_id IS NULL OR user_id = $1)`, [t.userId]))?.n ?? 0,
      items: await tx.q(`SELECT id, type, title, link, read_at AS "readAt", created_at AS "at" FROM notifications WHERE user_id IS NULL OR user_id = $1 ORDER BY created_at DESC LIMIT 30`, [t.userId]),
    }));
  }

  @Post('read')
  read(@CurrentTenant() t: Tenant) {
    return this.db.withTenant(t.businessId, (tx) => tx.q(`UPDATE notifications SET read_at = now() WHERE read_at IS NULL AND (user_id IS NULL OR user_id = $1)`, [t.userId]).then(() => ({ ok: true })));
  }
}
