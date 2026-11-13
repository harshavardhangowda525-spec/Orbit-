import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { SUPPORTED_LANGUAGE_CODES, translate } from '@orbit/shared';
import { DbService } from '../db/db.service';
import { Public } from '../auth/guards';
import { ZodPipe } from '../common/zod.pipe';
import { AppError, notFound } from '../common/errors';
import { hashToken } from '../realtime/hash';
import { ConversationsService } from '../inbox/conversations.service';
import { AriaService } from './aria.service';
import { detectLanguage } from './prompts';

const Start = z.object({ language: z.string().max(10).optional(), channel: z.enum(['website_chat', 'chat_link']).default('chat_link') });
const Send = z.object({ text: z.string().trim().min(1).max(1000) });

/** Customer chat (website widget and public chat page). Each visitor holds a secret token for their own conversation. */
@Controller('public/businesses/:slug/chat')
export class ChatController {
  constructor(private readonly db: DbService, private readonly aria: AriaService, private readonly conversations: ConversationsService) {}

  private async business(slug: string) {
    if (!/^[a-z0-9-]{1,64}$/.test(slug)) throw notFound();
    const b = await this.db.one<{ id: string; name: string; default_language: string; supported_languages: string[] }>(
      `SELECT id, name, default_language, supported_languages FROM businesses WHERE slug = $1 AND status IN ('live', 'onboarding', 'paused')`,
      [slug],
    );
    if (!b) throw notFound('We could not find this business.');
    return b;
  }

  private async conversation(businessId: string, id: string, token?: string) {
    if (!token) throw new AppError(401, 'unauthorized', 'Please start a new chat.');
    const c = await this.db.withTenant(businessId, (tx) => tx.one(`SELECT id, handled_by, status FROM conversations WHERE id = $1 AND visitor_token_hash = $2`, [id, hashToken(token)]));
    if (!c) throw new AppError(401, 'unauthorized', 'Please start a new chat.');
    return c;
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  async start(@Param('slug') slug: string, @Body(new ZodPipe(Start)) b: z.infer<typeof Start>) {
    const biz = await this.business(slug);
    const base = (b.language ?? '').toLowerCase().split('-')[0];
    const lang = SUPPORTED_LANGUAGE_CODES.includes(base) && biz.supported_languages.includes(base) ? base : biz.default_language;
    const token = randomBytes(24).toString('base64url');
    return this.db.withTenant(biz.id, async (tx) => {
      const agent = await tx.one(`SELECT display_name FROM agents WHERE agent_key = 'aria'`);
      const conv = await tx.one(
        `INSERT INTO conversations (channel, status, handled_by, visitor_token_hash, language, last_message_at) VALUES ($1, 'open', 'aria', $2, $3, now()) RETURNING id`,
        [b.channel, hashToken(token), lang],
      );
      const greeting = translate(lang, 'chat.greeting_named', { agent: agent?.display_name ?? 'Aria', business: biz.name });
      const msg = await this.conversations.addMessage(tx, conv.id, { direction: 'out', sender: 'aria', body: greeting, language: lang });
      return { conversationId: conv.id, visitorToken: token, language: lang, messages: [msg] };
    });
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':id/messages')
  async send(@Param('slug') slug: string, @Param('id', ParseUUIDPipe) id: string, @Headers('x-visitor-token') token: string, @Body(new ZodPipe(Send)) b: z.infer<typeof Send>) {
    const biz = await this.business(slug);
    await this.conversation(biz.id, id, token);
    const inbound = await this.db.withTenant(biz.id, (tx) => this.conversations.addMessage(tx, id, { direction: 'in', sender: 'customer', body: b.text, language: detectLanguage(b.text, '') || null }));
    const r = await this.aria.reply(biz.id, id);
    const messages = await this.db.withTenant(biz.id, (tx) =>
      tx.q(`SELECT id, direction, sender, body, created_at AS at FROM messages WHERE conversation_id = $1 AND created_at >= $2 ORDER BY created_at`, [id, inbound.at]),
    );
    return { messages: messages.map(publicMessage), handledBy: r.handover || r.reason === 'human_handling' ? 'human' : 'aria' };
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get(':id/messages')
  async history(@Param('slug') slug: string, @Param('id', ParseUUIDPipe) id: string, @Headers('x-visitor-token') token: string) {
    const biz = await this.business(slug);
    const c = await this.conversation(biz.id, id, token);
    const messages = await this.db.withTenant(biz.id, (tx) => tx.q(`SELECT id, direction, sender, body, created_at AS at FROM messages WHERE conversation_id = $1 ORDER BY created_at`, [id]));
    return { messages: messages.map(publicMessage), handledBy: c.handled_by === 'aria' ? 'aria' : 'human' };
  }
}

/** Customers see who replied (Aria or "the team"), never staff user ids. */
function publicMessage(m: any) {
  return { id: m.id, direction: m.direction, from: m.direction === 'in' ? 'you' : m.sender.startsWith('user:') ? 'team' : 'aria', body: m.body, at: m.at };
}
