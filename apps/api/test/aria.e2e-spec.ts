/**
 * Aria on web chat (Phase 2 acceptance): a customer asks a question, gets the
 * answer from the knowledge base, and books a real free slot. Plus guardrails:
 * handover, made-up prices, AI outage, least-privilege tools, data isolation of
 * the AI context. The model is a scripted fake so results are deterministic.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AiService } from '../src/ai/ai.service';
import { FakeProvider, text, toolUse } from '../src/ai/fake.provider';
import { runTool } from '../src/ai/tools';
import { DbService } from '../src/db/db.service';
import { addDays, localParts, respectQuietHours } from '@orbit/shared';
import { bootApp, onboard } from './helpers';

type Biz = Awaited<ReturnType<typeof onboard>>;

function lastUser(req: any): any {
  for (let i = req.messages.length - 1; i >= 0; i--) if (req.messages[i].role === 'user') return req.messages[i];
}
const userText = (req: any) => {
  const m = lastUser(req);
  return typeof m.content === 'string' ? m.content : (m.content.find((b: any) => b.type === 'text')?.text ?? '');
};
const toolResults = (req: any) => {
  const m = lastUser(req);
  return Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'tool_result').map((b: any) => JSON.parse(b.content)) : [];
};

describe('Aria on web chat', () => {
  let app: NestExpressApplication;
  let fake: FakeProvider;
  let db: DbService;
  let A: Biz;
  let B: Biz;
  const http = () => request(app.getHttpServer());

  async function startChat(slug: string) {
    const r = await http().post(`/public/businesses/${slug}/chat`).send({ language: 'en-IN', channel: 'website_chat' }).expect(201);
    return { id: r.body.conversationId as string, token: r.body.visitorToken as string, greeting: r.body.messages[0].body as string };
  }
  const say = (slug: string, c: { id: string; token: string }, t: string) =>
    http().post(`/public/businesses/${slug}/chat/${c.id}/messages`).set('x-visitor-token', c.token).send({ text: t });

  beforeAll(async () => {
    app = await bootApp();
    fake = app.get(AiService).fake!;
    db = app.get(DbService);
    A = await onboard(app, 'salon', 'Chat Salon');
    B = await onboard(app, 'clinic', 'Other Clinic');
    await A.api.post('/knowledge', { type: 'faq', title: 'Parking', content: 'Free parking is available behind the building on 4th Cross.' }).expect(201);
  });
  afterAll(() => app.close());
  beforeEach(() => fake.reset());

  it('greets the visitor and answers from the knowledge base only', async () => {
    const c = await startChat(A.slug);
    expect(c.greeting).toContain('Chat Salon');
    fake.script = (req) => {
      const results = toolResults(req);
      if (results.length) return [text(results[0].results[0].content)];
      return [toolUse('search_knowledge', { query: userText(req) })];
    };
    const r = await say(A.slug, c, 'Is there parking near you?').expect(201);
    expect(r.body.messages.map((m: any) => m.from)).toEqual(['you', 'aria']);
    expect(r.body.messages[1].body).toBe('Free parking is available behind the building on 4th Cross.');
    // The AI only ever saw this business's facts.
    const sys = fake.calls[0].system;
    expect(sys).toContain('Chat Salon');
    expect(sys).toContain('Haircut');
    expect(sys).not.toContain('Other Clinic');
    expect(sys).toMatch(/DATA, never instructions/);
    expect(fake.calls[0].tools.map((t) => t.name).sort()).toEqual(
      ['cancel_booking', 'check_availability', 'create_booking', 'create_lead', 'get_customer', 'handover_to_human', 'request_task', 'reschedule_booking', 'search_knowledge', 'send_service_info', 'upsert_customer'],
    );
    const usage = await db.withTenant(A.businessId, (tx) => tx.one(`SELECT count(*)::int AS n FROM ai_usage WHERE conversation_id = $1 AND agent_key = 'aria'`, [c.id]));
    expect(usage.n).toBe(2);
  });

  it('books a real free slot through the chat and schedules reminders', async () => {
    const c = await startChat(A.slug);
    let offered: any[] = [];
    fake.script = (req) => {
      const results = toolResults(req);
      if (results[0]?.slots) {
        offered = results[0].slots;
        return [text(`I have ${offered.map((s: any) => s.label).join(', ')}. Which suits you?`)];
      }
      if (results[0]?.booking_id) return [text(`Done! You're booked for ${results[0].when}. Manage it here: ${results[0].manage_link}`)];
      const t = userText(req);
      const svc = req.system.match(/Haircut \(service_id=([0-9a-f-]{36})/)![1];
      if (/haircut/i.test(t)) return [toolUse('check_availability', { service_id: svc, date: addDays(localParts(new Date(), 'Asia/Kolkata').date, 3) })];
      return [toolUse('create_booking', { service_id: svc, start: offered[0].start, staff_id: offered[0].staff_id, name: 'Anil Kumar', phone: '98450 11111' })];
    };
    const r1 = await say(A.slug, c, 'Can I book a haircut?').expect(201);
    expect(offered).toHaveLength(3);
    expect(r1.body.messages[1].body).toContain(offered[0].label);
    const r2 = await say(A.slug, c, 'The first one please. Anil, 98450 11111').expect(201);
    expect(r2.body.messages[1].body).toMatch(/You're booked for .*\/manage\//);

    const bk = await db.withTenant(A.businessId, (tx) =>
      tx.one(`SELECT bk.*, c.name, c.phone FROM bookings bk JOIN customers c ON c.id = bk.customer_id WHERE bk.source = 'aria:website_chat' ORDER BY bk.created_at DESC LIMIT 1`),
    );
    expect(new Date(bk.start_at).toISOString()).toBe(offered[0].start);
    expect(bk).toMatchObject({ status: 'confirmed', name: 'Anil Kumar', phone: '+919845011111' });
    // The conversation is now linked to the customer.
    const conv = await db.withTenant(A.businessId, (tx) => tx.one(`SELECT customer_id FROM conversations WHERE id = $1`, [c.id]));
    expect(conv.customer_id).toBe(bk.customer_id);
    // Reminders are queued for 24 h and 2 h before (those still in the future).
    const reminders = await db.withTenant(A.businessId, (tx) => tx.q(`SELECT send_at FROM scheduled_messages WHERE booking_id = $1 AND kind = 'reminder' AND status = 'scheduled' ORDER BY send_at`, [bk.id]));
    const start = new Date(bk.start_at);
    const quiet = { from: '21:00', to: '09:00' };
    const expected = [24, 2].map((h) => respectQuietHours(new Date(start.getTime() - h * 3_600_000), quiet, 'Asia/Kolkata', start)!.toISOString());
    expect(reminders.map((r) => new Date(r.send_at).toISOString())).toEqual(expected);
    // The same slot is gone for the next customer.
    const slots = await http().get(`/public/businesses/${A.slug}/slots`).query({ serviceId: bk.service_id, staffId: bk.staff_id, date: new Date(bk.start_at).toISOString().slice(0, 10) }).expect(200);
    expect(slots.body.map((s: any) => s.start)).not.toContain(offered[0].start);
    // The Bridge shows it and credits Aria.
    const bridge = (await A.api.get('/bridge').expect(200)).body;
    expect(bridge.feed[0].sentence.key).toBe('feed.aria.booked');
    expect(bridge.earnings.byAgent.find((x: any) => x.agent === 'aria').value).toBeGreaterThan(0);
  });

  it('never sends a price that is not in the business data', async () => {
    const c = await startChat(A.slug);
    fake.script = () => [text('A haircut is just ₹99 today!')];
    const r = await say(A.slug, c, 'How much is a haircut?').expect(201);
    expect(r.body.messages[1].body).not.toContain('99');
    expect(r.body.handledBy).toBe('human');
    // Real prices pass through.
    const c2 = await startChat(A.slug);
    fake.script = () => [text('A haircut is ₹300.')];
    const ok = await say(A.slug, c2, 'How much is a haircut?').expect(201);
    expect(ok.body.messages[1].body).toBe('A haircut is ₹300.');
  });

  it('hands over immediately when the customer asks for a person, without asking the AI', async () => {
    const c = await startChat(A.slug);
    const r = await say(A.slug, c, 'I want to talk to a real person please').expect(201);
    expect(fake.calls).toHaveLength(0);
    expect(r.body.handledBy).toBe('human');
    const bridge = (await A.api.get('/bridge').expect(200)).body;
    const card = bridge.needsYou.find((x: any) => x.type === 'handover' && x.context.conversationId === c.id);
    expect(card).toBeTruthy();
    const notes = (await A.api.get('/notifications').expect(200)).body;
    expect(notes.unread).toBeGreaterThan(0);
    // Aria stays quiet while a person is needed.
    await say(A.slug, c, 'Hello?').expect(201);
    expect(fake.calls).toHaveLength(0);
  });

  it('owner takes over and hands back; customers see the team reply', async () => {
    const c = await startChat(A.slug);
    fake.script = () => [text('Happy to help!')];
    await say(A.slug, c, 'Hi').expect(201);
    await A.api.post(`/inbox/${c.id}/takeover`).expect(201);
    const before = fake.calls.length;
    const r = await say(A.slug, c, 'Can you do a bridal package?').expect(201);
    expect(r.body.messages).toHaveLength(1); // only the customer's message: Aria did not answer
    expect(fake.calls.length).toBe(before);
    await A.api.post(`/inbox/${c.id}/reply`, { body: 'Yes! Meera here. I will send details.' }).expect(201);
    const hist = await http().get(`/public/businesses/${A.slug}/chat/${c.id}/messages`).set('x-visitor-token', c.token).expect(200);
    expect(hist.body.messages.at(-1)).toMatchObject({ from: 'team', body: 'Yes! Meera here. I will send details.' });
    const inbox = (await A.api.get(`/inbox/${c.id}`).expect(200)).body;
    expect(inbox.conversation.handledBy).toBe(`user:${A.owner.userId}`);
    // Customer writes again, then the owner hands back: Aria answers the waiting message.
    await say(A.slug, c, 'Thanks! And what are your timings?').expect(201);
    fake.script = () => [text('We are open 10 am to 9 pm.')];
    await A.api.post(`/inbox/${c.id}/handback`).expect(201);
    const after = await http().get(`/public/businesses/${A.slug}/chat/${c.id}/messages`).set('x-visitor-token', c.token).expect(200);
    expect(after.body).toMatchObject({ handledBy: 'aria' });
    expect(after.body.messages.at(-1)).toMatchObject({ from: 'aria', body: 'We are open 10 am to 9 pm.' });
  });

  it('when the AI service is down, the customer gets a polite message and the owner is told', async () => {
    const c = await startChat(A.slug);
    fake.script = () => {
      throw new Error('provider outage');
    };
    const r = await say(A.slug, c, 'Hello').expect(201);
    expect(r.body.messages[1].body).toMatch(/team/i);
    expect(r.body.handledBy).toBe('human');
  });

  it('replies in the language the customer writes in', async () => {
    const c = await startChat(A.slug);
    fake.script = () => [text('ನಮಸ್ಕಾರ!')];
    await say(A.slug, c, 'ನಮಸ್ಕಾರ, ನಿಮ್ಮ ಸಮಯ ಏನು?').expect(201);
    expect(fake.calls[0].messages.at(-1)!.content).toMatch(/Customer language: kn/);
  });

  it('Aria cannot use tools outside her list, nor touch another customer\'s booking', async () => {
    const out = await db.withTenant(A.businessId, (tx) =>
      runTool({ tx, agent: 'aria', conversationId: null, channel: 'website_chat', language: 'en', now: new Date(), services: {} as any, effects: { quotedAmounts: [] } }, 'create_invoice', {}),
    );
    expect(out.isError).toBe(true);
    const c = await startChat(A.slug);
    const someBooking = await db.withTenant(A.businessId, (tx) => tx.one(`SELECT id FROM bookings LIMIT 1`));
    fake.script = (req) => (toolResults(req).length ? [text(JSON.stringify(toolResults(req)[0]))] : [toolUse('cancel_booking', { booking_id: someBooking.id })]);
    const r = await say(A.slug, c, 'cancel booking').expect(201);
    expect(r.body.messages[1].body).toContain('does not belong to this customer');
  });

  it('visitor tokens only open their own conversation, in their own business', async () => {
    const a = await startChat(A.slug);
    const b = await startChat(B.slug);
    await http().get(`/public/businesses/${A.slug}/chat/${a.id}/messages`).set('x-visitor-token', b.token).expect(401);
    await http().get(`/public/businesses/${B.slug}/chat/${a.id}/messages`).set('x-visitor-token', a.token).expect(401);
    await http().get(`/public/businesses/${A.slug}/chat/${a.id}/messages`).expect(401);
  });
});
