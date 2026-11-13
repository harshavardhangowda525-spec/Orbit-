import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import Redis from 'ioredis';
import { runtime } from '../config';
import { logger } from '../logger';
import { setLiveBus } from './live';

/** A live update pushed to The Bridge, the inbox or a customer's chat. */
export interface LiveEvent {
  type:
    | 'feed.new'
    | 'card.new'
    | 'card.decided'
    | 'stats.changed'
    | 'task.status'
    | 'message.new'
    | 'conversation.updated'
    | 'notification.new'
    | 'booking.changed'
    | 'invoice.updated'
    | 'call.started'
    | 'call.ended';
  data?: unknown;
}

/**
 * Pub/sub for live updates. Channels are "biz:<businessId>" (owner and staff
 * screens) and "conv:<conversationId>" (one customer's chat). With Redis, every
 * API instance receives every event; locally an in-process emitter is used.
 */
@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private local = new EventEmitter();
  private pub?: Redis;
  private sub?: Redis;

  constructor() {
    this.local.setMaxListeners(0);
    setLiveBus(this);
    if (runtime.realtimeMode === 'redis') {
      const opts = { lazyConnect: false, maxRetriesPerRequest: null as null, enableOfflineQueue: true };
      this.pub = new Redis(runtime.redisUrl, opts);
      this.sub = new Redis(runtime.redisUrl, opts);
      for (const r of [this.pub, this.sub]) r.on('error', (e) => logger.warn(`redis: ${e.message}`, 'Realtime'));
      this.sub.psubscribe('orbit:*').catch(() => undefined);
      this.sub.on('pmessage', (_p, channel, msg) => {
        try {
          this.local.emit(channel.slice('orbit:'.length), JSON.parse(msg));
        } catch {
          /* ignore malformed */
        }
      });
    }
  }

  publish(channel: string, event: LiveEvent) {
    if (this.pub && this.pub.status === 'ready') {
      this.pub.publish(`orbit:${channel}`, JSON.stringify(event)).catch(() => this.local.emit(channel, event));
    } else {
      this.local.emit(channel, event);
    }
  }

  toBusiness(businessId: string, event: LiveEvent) {
    this.publish(`biz:${businessId}`, event);
  }

  toConversation(conversationId: string, event: LiveEvent) {
    this.publish(`conv:${conversationId}`, event);
  }

  subscribe(channel: string, fn: (e: LiveEvent) => void): () => void {
    this.local.on(channel, fn);
    return () => this.local.off(channel, fn);
  }

  async onModuleDestroy() {
    await Promise.all([this.pub?.quit().catch(() => undefined), this.sub?.quit().catch(() => undefined)]);
  }
}

@Global()
@Module({ providers: [RealtimeService], exports: [RealtimeService] })
export class RealtimeModule {}
