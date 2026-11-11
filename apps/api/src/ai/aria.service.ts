import { Injectable } from '@nestjs/common';
import { translate, type BusinessType } from '@orbit/shared';
import { DbService } from '../db/db.service';
import { TemplatesService } from '../templates/templates.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { BookingsService } from '../bookings/bookings.service';
import { NudgeService } from '../nudge/nudge.service';
import { ConversationsService } from '../inbox/conversations.service';
import { finishActivity, startActivity } from '../common/feed';
import { liveToBusiness } from '../realtime/live';
import { logger } from '../logger';
import { AiService } from './ai.service';
import { ariaSystemPrompt, amountsIn, detectLanguage, wantsHuman } from './prompts';
import { runTool, todayLabel, toolsFor, type ToolContext } from './tools';
import type { AiBlock, AiMessage } from './provider';

const MAX_STEPS = 6;
const HISTORY = 24;

export interface AriaResult {
  replied: boolean;
  text?: string;
  handover?: boolean;
  reason?: string;
}

/**
 * Aria — front desk. Runs one turn of the agent loop for a conversation:
 * build context from THIS business only, call the model with Aria's tools,
 * execute tool calls inside the business's RLS context, apply guardrails,
 * then save and push the reply.
 */
@Injectable()
export class AriaService {
  constructor(
    private readonly db: DbService,
    private readonly ai: AiService,
    private readonly templates: TemplatesService,
    private readonly knowledge: KnowledgeService,
    private readonly bookings: BookingsService,
    private readonly nudge: NudgeService,
    private readonly conversations: ConversationsService,
  ) {}

  async reply(businessId: string, conversationId: string, now = new Date()): Promise<AriaResult> {
    const prep = await this.db.withTenant(businessId, async (tx) => {
      const conv = await tx.one(`SELECT * FROM conversations WHERE id = $1`, [conversationId]);
      if (!conv) return null;
      const biz = await tx.one(`SELECT b.*, p.address, p.phone, p.hours, p.description, p.policies FROM businesses b JOIN business_profiles p ON p.business_id = b.id WHERE b.id = $1`, [businessId]);
      const agent = await tx.one(`SELECT display_name, personality, enabled FROM agents WHERE agent_key = 'aria'`);
      const services = await tx.q(`SELECT id, name, duration_min, price::float AS price, description FROM services WHERE active AND deleted_at IS NULL ORDER BY sort_order`);
      const staff = await tx.q(`SELECT id, name FROM staff WHERE active AND deleted_at IS NULL ORDER BY created_at`);
      const history = await tx.q(`SELECT direction, sender, body FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2`, [conversationId, HISTORY]);
      const customer = conv.customer_id ? await tx.one(`SELECT name FROM customers WHERE id = $1`, [conv.customer_id]) : null;
      // Plan limit: AI conversations this month (a conversation counts once, however long it is).
      const usage = await tx.one(
        `SELECT (p.limits->>'aiConversationsPerMonth')::int AS cap, COALESCE(p.limits->>'overage', 'block') AS overage,
                (SELECT count(DISTINCT conversation_id)::int FROM ai_usage WHERE agent_key = 'aria' AND conversation_id IS NOT NULL AND created_at >= date_trunc('month', now())) AS used,
                EXISTS (SELECT 1 FROM ai_usage WHERE conversation_id = $1 AND created_at >= date_trunc('month', now())) AS counted
         FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.id = app_current_business()`,
        [conversationId],
      );
      const overLimit = usage && usage.cap !== null && usage.overage !== 'charge' && !usage.counted && usage.used >= usage.cap;
      if (overLimit) {
        const told = await tx.one(`SELECT 1 FROM notifications WHERE type = 'plan_limit' AND created_at >= date_trunc('month', now())`);
        if (!told) {
          await tx.q(`INSERT INTO notifications (user_id, type, title, link) VALUES (NULL, 'plan_limit', $1, '/bridge?view=plan')`, [JSON.stringify({ key: 'notify.plan_limit', params: { count: usage.cap } })]);
          liveToBusiness(tx, { type: 'notification.new' });
        }
      }
      return { conv, biz, agent, services, staff, history: history.reverse(), customer, overLimit };
    });
    if (!prep) return { replied: false };
    const { conv, biz, agent, history } = prep;
    if (conv.handled_by !== 'aria') return { replied: false, reason: 'human_handling' };
    const lastIn = [...history].reverse().find((m) => m.direction === 'in');
    if (!lastIn) return { replied: false };
    const language = detectLanguage(lastIn.body, conv.language ?? biz.default_language);
    if (language !== conv.language) await this.db.withTenant(businessId, (tx) => tx.q(`UPDATE conversations SET language = $2 WHERE id = $1`, [conversationId, language]));
    const say = (key: string) => translate(['en', 'hi', 'kn'].includes(language) ? language : 'en', key, { business: biz.name });

    // Guardrails that never wait for the AI.
    if (!agent?.enabled || biz.status === 'paused') return this.finish(businessId, conversationId, say('aria.auto.team_will_reply'), { handover: 'Aria is switched off' });
    if (prep.overLimit) return this.finish(businessId, conversationId, say('aria.auto.team_will_reply'), { handover: "This month's AI conversations on the plan are used up" });
    if (wantsHuman(lastIn.body)) return this.finish(businessId, conversationId, say('aria.auto.handover'), { handover: 'Customer asked for a person' });

    const template = await this.templates.get(biz.type as BusinessType);
    const system = ariaSystemPrompt({
      agentName: agent.display_name,
      personality: agent.personality,
      business: { name: biz.name, type: biz.type, currency: biz.currency, timezone: biz.timezone, languages: biz.supported_languages, defaultLanguage: biz.default_language },
      profile: { address: biz.address, phone: biz.phone, hours: biz.hours, description: biz.description, policies: biz.policies },
      services: prep.services,
      staff: prep.staff,
      template,
    });
    const messages: AiMessage[] = toMessages(history);
    // Volatile facts go after the cached prefix as a mid-conversation system note.
    messages.push({
      role: 'system' as any,
      content: `Now: ${todayLabel(now, biz.timezone)} local time. Customer language: ${language}.${prep.customer?.name ? ` Customer: ${prep.customer.name}.` : ' Customer not identified yet.'} Channel: ${conv.channel}.`,
    } as any);
    const tools = toolsFor('aria');
    const effects: ToolContext['effects'] = { quotedAmounts: prep.services.filter((s) => s.price !== null).map((s) => Number(s.price)) };
    const who = prep.customer?.name?.split(' ')[0] ?? null;
    const taskId = await this.db.withTenant(businessId, (tx) =>
      startActivity(tx, 'aria', `Reply on ${conv.channel}`, { key: who ? 'activity.aria.replying' : 'activity.aria.replying_visitor', params: { customer: who ?? '', channel: `@channel.${conv.channel}` } }, { conversationId }),
    );

    let finalText = '';
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const res = await this.ai.complete(businessId, 'aria', { system, messages, tools, maxTokens: 2000 }, { conversationId, taskId });
        if (res.stopReason === 'refusal') {
          await this.db.withTenant(businessId, (tx) => finishActivity(tx, taskId, 'done', { refusal: true }));
          return this.finish(businessId, conversationId, say('aria.auto.handover'), { handover: 'Aria could not help with this request' });
        }
        messages.push({ role: 'assistant', content: res.content as any });
        const calls = res.content.filter((b): b is Extract<AiBlock, { type: 'tool_use' }> => b.type === 'tool_use');
        if (!calls.length) {
          finalText = res.content.filter((b) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
          break;
        }
        const results: any[] = [];
        for (const call of calls) {
          const out = await this.db.withTenant(businessId, (tx) =>
            runTool({ tx, agent: 'aria', conversationId, channel: conv.channel, language, now, services: { knowledge: this.knowledge, bookings: this.bookings, nudge: this.nudge }, effects }, call.name, call.input),
          ).catch((e) => {
            logger.error(`tool ${call.name} failed: ${e.message}`, e.stack, 'Aria');
            return { content: JSON.stringify({ error: 'That did not work. Offer to have the team follow up.' }), isError: true };
          });
          results.push({ type: 'tool_result', tool_use_id: call.id, content: out.content, is_error: out.isError || undefined });
        }
        messages.push({ role: 'user', content: results });
      }
    } catch (e) {
      logger.error(`Aria failed: ${(e as Error).message}`, (e as Error).stack, 'Aria');
      await this.db.withTenant(businessId, (tx) => finishActivity(tx, taskId, 'failed', null, (e as Error).message));
      return this.finish(businessId, conversationId, say('aria.auto.trouble'), { handover: 'Orbit could not reach its AI service', failure: true });
    }

    // Never send a price that did not come from the business's own data.
    const invented = amountsIn(finalText).filter((a) => !effects.quotedAmounts.includes(a));
    if (invented.length) {
      logger.warn(`blocked reply with unverified amounts ${invented.join(',')}`, 'Aria');
      finalText = say('aria.auto.check_price');
      effects.handover ??= { reason: 'Customer asked about a price Orbit could not confirm' };
    }
    if (!finalText) finalText = say(effects.handover ? 'aria.auto.handover' : 'aria.auto.trouble');
    await this.db.withTenant(businessId, (tx) => finishActivity(tx, taskId, 'done', { handover: !!effects.handover }));
    return this.finish(businessId, conversationId, finalText, { handover: effects.handover?.reason });
  }

  private async finish(businessId: string, conversationId: string, text: string, o: { handover?: string; failure?: boolean }): Promise<AriaResult> {
    await this.db.withTenant(businessId, async (tx) => {
      await this.conversations.addMessage(tx, conversationId, { direction: 'out', sender: 'aria', body: text });
      if (o.failure) await tx.q(`UPDATE conversations SET ai_failures = ai_failures + 1 WHERE id = $1`, [conversationId]);
      if (o.handover) await this.conversations.handover(tx, conversationId, o.handover);
      else await tx.q(`UPDATE conversations SET ai_failures = 0 WHERE id = $1`, [conversationId]);
    });
    return { replied: true, text, handover: !!o.handover, reason: o.handover };
  }
}

/** DB messages -> model turns. Customer = user; Aria and staff = assistant. */
function toMessages(rows: { direction: string; sender: string; body: string }[]): AiMessage[] {
  const out: AiMessage[] = [];
  for (const r of rows) {
    const role = r.direction === 'in' ? 'user' : 'assistant';
    const text = r.direction === 'out' && r.sender.startsWith('user:') ? `[A team member replied] ${r.body}` : r.body;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content = `${last.content as string}\n${text}`;
    else out.push({ role, content: text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}
