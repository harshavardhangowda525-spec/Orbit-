import { Injectable } from '@nestjs/common';
import { JobsService } from '../jobs/jobs.service';
import type { Tx } from '../db/db.service';
import { postFeed } from '../common/feed';
import { liveToBusiness, liveToConversation } from '../realtime/live';
import { badRequest, notFound } from '../common/errors';

/** Conversation state changes shared by Aria, the inbox and the public chat. */
@Injectable()
export class ConversationsService {
  constructor(private readonly jobs: JobsService) {}

  async addMessage(tx: Tx, conversationId: string, m: { direction: 'in' | 'out'; sender: string; body: string; language?: string | null; channelMessageId?: string | null; meta?: unknown }) {
    const row = await tx.one(
      `INSERT INTO messages (conversation_id, direction, sender, body, language, channel_message_id, delivery_status, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, direction, sender, body, created_at AS at`,
      [conversationId, m.direction, m.sender, m.body, m.language ?? null, m.channelMessageId ?? null, m.direction === 'out' ? 'sent' : 'received', JSON.stringify(m.meta ?? {})],
    );
    await tx.q(
      `UPDATE conversations SET last_message_at = now(),
         status = CASE WHEN $2 = 'in' AND status = 'closed' THEN 'open' WHEN $2 = 'out' AND status = 'open' THEN 'waiting_customer' WHEN $2 = 'in' AND status = 'waiting_customer' THEN 'open' ELSE status END
       WHERE id = $1`,
      [conversationId, m.direction],
    );
    // Outbound messages on external channels (email now; WhatsApp/SMS in Phase 3) are sent by a job after commit.
    if (m.direction === 'out') {
      const ch = await tx.one(`SELECT channel FROM conversations WHERE id = $1`, [conversationId]);
      if (ch && !['website_chat', 'chat_link'].includes(ch.channel)) {
        const businessId = tx.businessId!;
        tx.afterCommit(() => this.jobs.enqueue('powers.deliver', { businessId, messageId: row.id }, { jobId: `deliver:${row.id}` }).catch(() => undefined));
      }
    }
    const event = { type: 'message.new' as const, data: { conversationId, message: row } };
    liveToConversation(tx, conversationId, event);
    liveToBusiness(tx, event);
    return row;
  }

  /** Aria passes the conversation to a person: notification + Needs You card + feed. */
  async handover(tx: Tx, conversationId: string, reason: string) {
    const conv = await tx.one(
      `UPDATE conversations SET handled_by = 'human', status = 'waiting_staff' WHERE id = $1 AND handled_by = 'aria' RETURNING id, customer_id, channel`,
      [conversationId],
    );
    if (!conv) return;
    const c = conv.customer_id ? await tx.one(`SELECT name, phone FROM customers WHERE id = $1`, [conv.customer_id]) : null;
    const who = (c?.name ?? '').split(' ')[0] || c?.phone || null;
    await tx.q(
      `INSERT INTO approval_cards (agent_key, type, title, context, options, default_option, expires_at)
       VALUES ('aria', 'handover', $1, $2, $3, 'aria', now() + interval '12 hours')`,
      [
        JSON.stringify({ key: who ? 'card.handover' : 'card.handover_visitor', params: { customer: who ?? '', reason } }),
        JSON.stringify({ conversationId, reason, channel: conv.channel }),
        JSON.stringify([
          { key: 'reply_myself', label: 'card.option.reply_myself', style: 'primary', outcome: 'edited' },
          { key: 'aria', label: 'card.option.let_aria', style: 'secondary', outcome: 'rejected' },
        ]),
      ],
    );
    await tx.q(
      `INSERT INTO notifications (user_id, type, title, link) VALUES (NULL, 'handover', $1, $2)`,
      [JSON.stringify(who ? { key: 'notify.handover', params: { customer: who } } : { key: 'notify.handover_visitor', params: {} }), `/inbox/${conversationId}`],
    );
    await postFeed(tx, 'aria', 'handover', who ? { key: 'feed.aria.handover', params: { customer: who } } : { key: 'feed.aria.handover_visitor', params: {} }, { entityType: 'conversation', entityId: conversationId, channel: conv.channel });
    liveToBusiness(tx, { type: 'card.new' });
    liveToBusiness(tx, { type: 'notification.new' });
    liveToBusiness(tx, { type: 'conversation.updated', data: { id: conversationId } });
    liveToConversation(tx, conversationId, { type: 'conversation.updated', data: { handledBy: 'human' } });
  }

  async takeover(tx: Tx, conversationId: string, userId: string) {
    const r = await tx.one(`UPDATE conversations SET handled_by = $2, taken_over_by = $3, status = 'open' WHERE id = $1 RETURNING id`, [conversationId, `user:${userId}`, userId]);
    if (!r) throw notFound();
    await this.resolveHandoverCards(tx, conversationId, 'edited', userId);
    liveToBusiness(tx, { type: 'conversation.updated', data: { id: conversationId } });
    liveToConversation(tx, conversationId, { type: 'conversation.updated', data: { handledBy: 'human' } });
    return { ok: true, handledBy: `user:${userId}` };
  }

  async handback(tx: Tx, conversationId: string, userId: string | null) {
    const r = await tx.one(`UPDATE conversations SET handled_by = 'aria', taken_over_by = NULL, ai_failures = 0, status = 'open' WHERE id = $1 RETURNING id`, [conversationId]);
    if (!r) throw notFound();
    await this.resolveHandoverCards(tx, conversationId, 'rejected', userId);
    liveToBusiness(tx, { type: 'conversation.updated', data: { id: conversationId } });
    liveToConversation(tx, conversationId, { type: 'conversation.updated', data: { handledBy: 'aria' } });
    return { ok: true, handledBy: 'aria' };
  }

  async staffReply(tx: Tx, conversationId: string, userId: string, body: string) {
    const conv = await tx.one(`SELECT handled_by FROM conversations WHERE id = $1`, [conversationId]);
    if (!conv) throw notFound();
    if (conv.handled_by === 'aria') await this.takeover(tx, conversationId, userId); // replying = taking over
    else if (conv.handled_by.startsWith('user:') && conv.handled_by !== `user:${userId}`) {
      // Another team member is handling it; joining is allowed but recorded on the message.
    } else if (!conv.handled_by.startsWith('user:')) await this.takeover(tx, conversationId, userId);
    if (!body.trim()) throw badRequest('empty', 'Please type a message.');
    return this.addMessage(tx, conversationId, { direction: 'out', sender: `user:${userId}`, body: body.trim() });
  }

  private async resolveHandoverCards(tx: Tx, conversationId: string, status: 'edited' | 'rejected', userId: string | null) {
    const n = await tx.q(
      `UPDATE approval_cards SET status = $2, decided_by = $3, decided_at = now(), decision = CASE WHEN $2 = 'edited' THEN 'reply_myself' ELSE 'aria' END
       WHERE type = 'handover' AND status = 'pending' AND context->>'conversationId' = $1 RETURNING id`,
      [conversationId, status, userId],
    );
    if (n.length) liveToBusiness(tx, { type: 'card.decided' });
  }
}
