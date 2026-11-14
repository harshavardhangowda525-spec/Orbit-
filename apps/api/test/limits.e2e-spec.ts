/**
 * AI tiers, allowances and the graceful handover (add-on: AI tiers by plan).
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { PROVIDER_WORDS } from '@orbit/shared';
import en from '../../../packages/shared/src/locales/en.json';
import hi from '../../../packages/shared/src/locales/hi.json';
import kn from '../../../packages/shared/src/locales/kn.json';
import { bootApp, onboard, signIn, api, SEED } from './helpers';
import { DbService } from '../src/db/db.service';
import { JobsService } from '../src/jobs/jobs.service';
import { AiService } from '../src/ai/ai.service';
import { UsageService } from '../src/billing/usage.service';
import { AiUnavailableError, type AiProvider } from '../src/ai/provider';
import { text } from '../src/ai/fake.provider';

const TEST_PLANS = ['t_free5', 't_paid', 't_wallet'];

describe('AI tiers, limits and graceful handover', () => {
  let app: NestExpressApplication;
  let db: DbService;
  let ai: AiService;
  let usage: UsageService;
  const tenant = (id: string, fn: (tx: any) => Promise<any>): Promise<any> => db.withTenant(id, fn);
  const http = () => request(app.getHttpServer());

  /** A test plan: a copy of Free (or Plus) with small allowances. */
  const plan = async (code: string, base: 'free' | 'plus', limits: Record<string, unknown>) =>
    db.adminTx((tx: any) =>
      tx.q(
        `INSERT INTO plans (code, name, prices, limits, features, sort_order, active, updated_by)
         SELECT $1, $1, prices, limits || $2::jsonb, features, 90, false, gen_random_uuid() FROM plans WHERE code = $3
         ON CONFLICT (code) DO UPDATE SET limits = (SELECT limits FROM plans WHERE code = $3) || $2::jsonb, features = (SELECT features FROM plans WHERE code = $3)`,
        [code, JSON.stringify(limits), base],
      ),
    );
  const onPlan = async (businessId: string, code: string) => {
    await db.q(`UPDATE businesses SET plan_id = (SELECT id FROM plans WHERE code = $2) WHERE id = $1`, [businessId, code]);
    ai.invalidate(businessId);
  };
  const startChat = async (slug: string) => {
    const s = await http().post(`/public/businesses/${slug}/chat`).send({}).expect(201);
    return { id: s.body.conversationId as string, token: s.body.visitorToken as string };
  };
  const say = (slug: string, c: { id: string; token: string }, t = 'What are your timings?') =>
    http().post(`/public/businesses/${slug}/chat/${c.id}/messages`).set('x-visitor-token', c.token).send({ text: t }).expect(201).then((r) => r.body);

  beforeAll(async () => {
    app = await bootApp();
    db = app.get(DbService);
    ai = app.get(AiService);
    usage = app.get(UsageService);
    await plan('t_free5', 'free', { aiConversationsPerDay: 5, graceMessages: 2 });
    await plan('t_paid', 'plus', { aiConversationsPerMonth: 10, aiConversationsPerDay: null, dailyCapMultiplier: 3, graceMessages: 10 });
    await plan('t_wallet', 'plus', { aiConversationsPerMonth: 1, aiConversationsPerDay: 100, overage: 'wallet', overagePrices: { aiConversation: { INR: 2, USD: 0.03 } } });
  });
  beforeEach(() => app.get(AiService).fake!.reset());
  afterAll(async () => {
    await db.adminTx(async (tx: any) => {
      await tx.q(`UPDATE businesses SET plan_id = (SELECT id FROM plans WHERE code = 'free') WHERE plan_id IN (SELECT id FROM plans WHERE code = ANY($1))`, [TEST_PLANS]);
      await tx.q(`DELETE FROM plans WHERE code = ANY($1)`, [TEST_PLANS]);
    });
    await app.close();
  });

  it('Free hits its daily limit: heads-up at 80%, one acknowledgement per customer, the chat waits in the inbox, the owner is told, nothing is lost', async () => {
    const a = await onboard(app, 'salon', 'Sunrise Salon');
    await onPlan(a.businessId, 't_free5');
    for (let i = 0; i < 5; i++) expect((await say(a.slug, await startChat(a.slug))).handledBy).toBe('aria');
    const warn = await tenant(a.businessId, (tx) => tx.q(`SELECT title FROM notifications WHERE type = 'ai_limit_warning'`));
    expect(warn).toHaveLength(1);
    expect(warn[0].title).toMatchObject({ key: 'notify.ai_80_day', params: { used: 4, cap: 5 } });

    const late = await startChat(a.slug);
    const r1 = await say(a.slug, late, 'Do you do bridal makeup?');
    expect(r1.handledBy).toBe('human');
    expect(r1.messages.map((m: any) => m.body)).toEqual(['Do you do bridal makeup?', 'Thanks for your message! The team at Sunrise Salon will reply shortly.']);
    const r2 = await say(a.slug, late, 'Hello?');
    expect(r2.messages.map((m: any) => m.body)).toEqual(['Hello?']); // acknowledged once, not per message
    const another = await startChat(a.slug);
    await say(a.slug, another);

    const conv = await tenant(a.businessId, (tx) => tx.one(`SELECT status, handled_by, parked_for_limit_at FROM conversations WHERE id = $1`, [late.id]));
    expect(conv).toMatchObject({ status: 'waiting_staff', handled_by: 'human' });
    expect(conv.parked_for_limit_at).toBeTruthy();
    const inbound = await tenant(a.businessId, (tx) => tx.q(`SELECT body FROM messages WHERE conversation_id = $1 AND direction = 'in'`, [late.id]));
    expect(inbound).toHaveLength(2); // nothing lost
    const notes = await tenant(a.businessId, (tx) => tx.q(`SELECT title, link FROM notifications WHERE type = 'ai_limit'`));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ title: { key: 'notify.ai_limit_day' }, link: '/inbox' });
    const cards = await tenant(a.businessId, (tx) => tx.q(`SELECT title, context FROM approval_cards WHERE type = 'limit_waiting' AND status = 'pending'`));
    expect(cards).toHaveLength(1);
    expect(cards[0].title.params.count).toBe(2);
    expect(cards[0].context.conversationIds).toEqual(expect.arrayContaining([late.id, another.id]));

    // The Bridge says Orbit is paused; customers never see limits or plans.
    const home = (await a.api.get('/bridge').expect(200)).body;
    expect(home.pulse.sentence).toMatchObject({ key: 'pulse.ai_paused_day', params: { count: 2 } });
    expect(home.ticker[0].sentence.key).toBe('ticker.ai_paused_day');
    const toCustomers = await tenant(a.businessId, (tx) => tx.q(`SELECT body FROM messages WHERE direction = 'out'`));
    for (const m of toCustomers) expect(m.body).not.toMatch(/limit|plan|upgrade|quota|allowance/i);
    // The booking page keeps working without AI.
    expect((await http().get(`/public/businesses/${a.slug}`)).status).toBe(200);

    // Midnight passes (usage moves to yesterday): Orbit resumes and offers to reply to the waiting chats.
    await tenant(a.businessId, (tx) => tx.q(`UPDATE ai_usage SET created_at = created_at - interval '1 day'`));
    expect(await usage.offerResume(a.businessId)).toBe(true);
    const offer = await tenant(a.businessId, (tx) => tx.one(`SELECT id, title FROM approval_cards WHERE type = 'limit_resume' AND status = 'pending'`));
    expect(offer.title).toMatchObject({ key: 'card.limit_resume', params: { count: 2 } });
    expect(await tenant(a.businessId, (tx) => tx.one(`SELECT 1 FROM approval_cards WHERE type = 'limit_waiting' AND status = 'pending'`))).toBeFalsy();
    expect((await a.api.get('/bridge').expect(200)).body.paused).toBeNull();
    await a.api.post(`/bridge/cards/${offer.id}/decide`, { option: 'reply' }).expect(201);
    await app.get(JobsService).runDue(Date.now(), ['channels.reply']);
    const after = await tenant(a.businessId, (tx) => tx.one(`SELECT handled_by, status, parked_for_limit_at FROM conversations WHERE id = $1`, [late.id]));
    expect(after).toMatchObject({ handled_by: 'aria', parked_for_limit_at: null });
    const replied = await tenant(a.businessId, (tx) => tx.q(`SELECT 1 FROM ai_usage WHERE conversation_id = $1 AND error IS NULL`, [late.id]));
    expect(replied.length).toBeGreaterThan(0);
  });

  it('a conversation already under way gets a few more replies (grace), then waits; the meters show it', async () => {
    const a = await onboard(app, 'salon', 'Grace Salon');
    await onPlan(a.businessId, 't_free5');
    const first = await startChat(a.slug);
    await say(a.slug, first);
    for (let i = 0; i < 4; i++) await say(a.slug, await startChat(a.slug));
    // Limit reached: the first chat continues for graceMessages (2) more replies.
    expect((await say(a.slug, first, 'And on Sunday?')).handledBy).toBe('aria');
    expect((await say(a.slug, first, 'Thanks')).handledBy).toBe('aria');
    expect((await say(a.slug, first, 'One more thing')).handledBy).toBe('human');
    const o = (await a.api.get('/billing').expect(200)).body;
    expect(o.meters.today).toMatchObject({ used: 5, cap: 5 });
    expect(new Date(o.meters.today.resetsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('a paid plan hits its daily cap mid-conversation: that conversation finishes, new ones wait', async () => {
    const a = await onboard(app, 'salon', 'Paid Salon');
    await onPlan(a.businessId, 't_paid'); // monthly 10 → daily cap ceil(10/30 × 3) = 1
    const c = await startChat(a.slug);
    for (let i = 0; i < 6; i++) expect((await say(a.slug, c, `Question ${i}`)).handledBy).toBe('aria');
    expect((await say(a.slug, await startChat(a.slug))).handledBy).toBe('human');
    const o = (await a.api.get('/billing').expect(200)).body;
    expect(o.meters).toMatchObject({ today: { used: 1, cap: 1 }, month: { used: 1, cap: 10 } });
  });

  it('past the monthly allowance, Pay As You Go credit keeps Orbit answering; without credit it pauses', async () => {
    const a = await onboard(app, 'salon', 'Wallet Salon');
    await onPlan(a.businessId, 't_wallet');
    await say(a.slug, await startChat(a.slug));
    await db.q(`UPDATE businesses SET ai_wallet_balance = 3 WHERE id = $1`, [a.businessId]);
    expect((await say(a.slug, await startChat(a.slug))).handledBy).toBe('aria'); // ₹2 from credit
    expect((await say(a.slug, await startChat(a.slug))).handledBy).toBe('human'); // ₹1 left: not enough
    const w = await db.one(`SELECT ai_wallet_balance::float AS b FROM businesses WHERE id = $1`, [a.businessId]);
    expect(w!.b).toBe(1);
    expect(await tenant(a.businessId, (tx) => tx.q(`SELECT amount::float FROM wallet_transactions WHERE kind = 'usage'`))).toEqual([{ amount: -2 }]);
  });

  it('routes by plan tier and fails over silently (logged), never to a higher tier', async () => {
    const a = await onboard(app, 'salon', 'Route Salon');
    const routing = await ai.currentRouting();
    // Free never borrows paid models; paid tiers fall back down, not up.
    const freeChain = ai.chainFor(routing, 'free', 'conversation').map((s) => s.tier);
    expect(new Set(freeChain)).toEqual(new Set(['free']));
    expect(ai.chainFor(routing, 'standard', 'conversation').some((s) => s.tier === 'premium')).toBe(false);
    expect(ai.chainFor(routing, 'premium', 'conversation')[0].tier).toBe('premium');

    const saved = ai.providers;
    const calls: string[] = [];
    const failing: AiProvider = { name: 'groq', complete: async (_r, m) => { calls.push(`groq/${m}`); throw new AiUnavailableError('rate limited'); } };
    const backup: AiProvider = { name: 'claude', complete: async (_r, m) => { calls.push(`claude/${m}`); return { content: [text('Hello!')], stopReason: 'end_turn', model: m ?? 'x', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }; } };
    await db.adminTx((tx: any) =>
      tx.q(`INSERT INTO platform_settings (key, value) VALUES ('ai.routing', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [
        JSON.stringify({ free: { routes: { conversation: { provider: 'groq', model: 'open-a' } }, fallback: [{ provider: 'claude', model: 'claude-haiku-5-5' }] } }),
      ]),
    );
    ai.invalidate();
    ai.providers = { groq: failing, claude: backup };
    try {
      const conv = await startChat(a.slug);
      const res = await ai.complete(a.businessId, 'aria', { system: 'S', messages: [{ role: 'user', content: 'hi' }], tools: [] }, { conversationId: conv.id });
      expect(res.content[0]).toMatchObject({ text: 'Hello!' });
      expect(calls).toEqual(['groq/open-a', 'claude/claude-haiku-5-5']);
      const rows = await tenant(a.businessId, (tx) => tx.q(`SELECT provider, model, tier, task_type, failover, error IS NOT NULL AS failed, cost::float FROM ai_usage ORDER BY created_at, id`));
      expect(rows).toEqual([
        { provider: 'groq', model: 'open-a', tier: 'free', task_type: 'conversation', failover: false, failed: true, cost: 0 },
        expect.objectContaining({ provider: 'claude', model: 'claude-haiku-5-5', tier: 'free', failover: true, failed: false }),
      ]);
      // Everything failing: one plain error, no provider names for people to see.
      ai.providers = { groq: failing, claude: failing };
      await expect(ai.complete(a.businessId, 'aria', { system: 'S', messages: [], tools: [] })).rejects.toBeInstanceOf(AiUnavailableError);
    } finally {
      ai.providers = saved;
      await db.adminTx((tx: any) => tx.q(`DELETE FROM platform_settings WHERE key = 'ai.routing'`));
      ai.invalidate();
    }
  });

  it('admin edits routing and the budget; the margin view has per-business, per-plan and overall numbers', async () => {
    const admin = await signIn(app, SEED.admin);
    const ad = api(app, admin.token);
    const r = (await ad.get('/admin/ai/routing').expect(200)).body;
    expect(Object.keys(r.routing)).toEqual(['free', 'standard', 'premium']);
    const edited = { ...r.routing, standard: { ...r.routing.standard, routes: { ...r.routing.standard.routes, simple: { provider: 'groq', model: 'llama-3.1-8b-instant' } } } };
    await ad.put('/admin/ai/routing', edited).expect(200);
    expect((await ad.get('/admin/ai/routing').expect(200)).body.routing.standard.routes.simple.model).toBe('llama-3.1-8b-instant');
    await ad.put('/admin/ai/budget', { budgetPct: 30 }).expect(200);
    const m = (await ad.get('/admin/ai/margins').expect(200)).body;
    expect(m.settings.budgetPct).toBe(30);
    expect(m).toHaveProperty('transferToAiAccount');
    expect(Array.isArray(m.byPlan) && Array.isArray(m.businesses) && Array.isArray(m.byProvider)).toBe(true);
    // Owners cannot reach any of it.
    const owner = await signIn(app);
    await api(app, owner.token).get('/admin/ai/margins').expect(403);
    await ad.put('/admin/ai/budget', { budgetPct: 25 }).expect(200);
    await db.adminTx((tx: any) => tx.q(`DELETE FROM platform_settings WHERE key = 'ai.routing'`));
    ai.invalidate();
  });

  it('no AI provider or model name appears in anything businesses or customers see', async () => {
    // Every owner- and customer-facing string, in all three languages (the Sarvam
    // keys describe the owner's own Sarvam account integration, like Razorpay).
    for (const dict of [en, hi, kn] as Record<string, string>[]) {
      const leaks = Object.entries(dict).filter(([k, v]) => !k.startsWith('sarvam.') && PROVIDER_WORDS.test(v));
      expect(leaks).toEqual([]);
    }
    const a = await onboard(app, 'gym', 'Brand Gym');
    for (const path of ['/bridge', '/billing', '/powers', '/crew/settings']) {
      const body = JSON.stringify((await a.api.get(path).expect(200)).body);
      expect(body).not.toMatch(PROVIDER_WORDS);
    }
  });
});
