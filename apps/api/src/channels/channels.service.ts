import { Global, Injectable, Module } from '@nestjs/common';
import type { Tx } from '../db/db.service';
import { runtime } from '../config';
import { liveToBusiness, liveToConversation } from '../realtime/live';
import { logger } from '../logger';

export interface OutboundMessage {
  customer: { id: string; name: string | null; phone: string | null; email: string | null; consent: Record<string, boolean>; opted_out_at: Record<string, string> };
  body: string;
  subject?: string;
  agent: string;
}

export interface DeliveryResult {
  delivered: boolean;
  channel: string | null;
  reason?: string;
  conversationId?: string;
}

/** A channel adapter: can it reach this customer, and send. Adapters run inside the business's transaction. */
export interface ChannelAdapter {
  canReach(tx: Tx, m: OutboundMessage): Promise<boolean>;
  send(tx: Tx, m: OutboundMessage): Promise<{ conversationId?: string }>;
}

/** An outbound inbox message waiting to be delivered on its conversation's channel. */
export interface OutboundRow {
  id: string;
  conversation_id: string;
  body: string;
  sender: string;
  channel: string;
  external_thread_id: string | null;
}

/** Delivers one outbound inbox message on an external channel; returns the channel's message id. */
export type ChannelSender = (tx: Tx, m: OutboundRow) => Promise<{ channelMessageId: string }>;

/** Order Orbit tries channels in when the preferred one cannot reach the customer. */
const FALLBACK_ORDER = ['whatsapp', 'sms', 'gmail', 'web_chat'];

/**
 * Routes outbound messages to the best connected channel. Adapters register
 * themselves (web chat; Gmail and WhatsApp when connected). Opt-outs are checked
 * for every channel.
 */
@Injectable()
export class ChannelsService {
  private adapters = new Map<string, ChannelAdapter>();
  private senders = new Map<string, ChannelSender>();

  constructor() {
    this.register('web_chat', new WebChatAdapter());
  }

  register(channel: string, adapter: ChannelAdapter) {
    this.adapters.set(channel, adapter);
  }

  registerSender(channel: string, sender: ChannelSender) {
    this.senders.set(channel, sender);
  }

  sender(channel: string): ChannelSender | undefined {
    return this.senders.get(channel);
  }

  async deliver(tx: Tx, preferred: string, m: OutboundMessage): Promise<DeliveryResult> {
    const order = [preferred, ...FALLBACK_ORDER.filter((c) => c !== preferred)];
    for (const ch of order) {
      if (m.customer.opted_out_at?.[ch === 'gmail' ? 'email' : ch]) continue;
      const a = this.adapters.get(ch);
      if (!a || !(await a.canReach(tx, m))) continue;
      const r = await a.send(tx, m);
      return { delivered: true, channel: ch, conversationId: r.conversationId };
    }
    if (runtime.devDeliver) {
      logger.log(`[dev delivery] to ${m.customer.name ?? m.customer.id}: ${m.body}`, 'Channels');
      return { delivered: true, channel: 'dev' };
    }
    return { delivered: false, channel: null, reason: 'no_channel_connected' };
  }
}

/** Posts into the customer's most recent website chat. They see it next time they open the chat (or live). */
class WebChatAdapter implements ChannelAdapter {
  async canReach(tx: Tx, m: OutboundMessage) {
    return !!(await tx.one(`SELECT 1 FROM conversations WHERE customer_id = $1 AND channel IN ('website_chat', 'chat_link')`, [m.customer.id]));
  }
  async send(tx: Tx, m: OutboundMessage) {
    const conv = await tx.one<{ id: string }>(
      `SELECT id FROM conversations WHERE customer_id = $1 AND channel IN ('website_chat', 'chat_link') ORDER BY last_message_at DESC NULLS LAST LIMIT 1`,
      [m.customer.id],
    );
    const msg = await tx.one(
      `INSERT INTO messages (conversation_id, direction, sender, body, delivery_status) VALUES ($1, 'out', $2, $3, 'sent') RETURNING id, created_at`,
      [conv!.id, m.agent, m.body],
    );
    await tx.q(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [conv!.id]);
    const payload = { type: 'message.new' as const, data: { conversationId: conv!.id, message: { id: msg.id, direction: 'out', sender: m.agent, body: m.body, at: msg.created_at } } };
    liveToConversation(tx, conv!.id, payload);
    liveToBusiness(tx, payload);
    return { conversationId: conv!.id };
  }
}

@Global()
@Module({ providers: [ChannelsService], exports: [ChannelsService] })
export class ChannelsModule {}
