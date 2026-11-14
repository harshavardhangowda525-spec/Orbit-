/**
 * Phase 3 acceptance: the Undo window and "Why did you do that?".
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { addDays, explainTrace, localParts, ungroundedWords, zonedTimeToUtc, type DecisionTrace } from '@orbit/shared';
import { DbService } from '../src/db/db.service';
import { JobsService } from '../src/jobs/jobs.service';
import { NudgeService } from '../src/nudge/nudge.service';
import { ChannelsService } from '../src/channels/channels.service';
import { HoldService } from '../src/trust/hold.service';
import { AiService } from '../src/ai/ai.service';
import { text, toolUse } from '../src/ai/fake.provider';
import { adminApi, bootApp, onboard, upgrade } from './helpers';

const TZ = 'Asia/Kolkata';
type Biz = Awaited<ReturnType<typeof onboard>>;

describe('Trust: Undo window and Why?', () => {
  let app: NestExpressApplication;
  let db: DbService;
  let jobs: JobsService;
  let S: Biz;
  let haircut: { id: string };
  let deliver: jest.SpyInstance;
  const http = () => request(app.getHttpServer());
  const tenant = (fn: (tx: any) => Promise<any>): Promise<any> => db.withTenant(S.businessId, fn);
  const day = (n: number) => addDays(localParts(new Date(), TZ).date, n);
  const fake = () => app.get(AiService).fake!;

  /** The fake model calls one tool, then answers once the tool result is back. */
  const callOnce = (name: string, input: Record<string, unknown>) => {
    fake().script = (req) => (Array.isArray(req.messages[req.messages.length - 1].content) ? [text('Done.')] : [toolUse(name, input)]);
  };
  /** Time passes: every held action's hold has ended. */
  const holdEnds = () => tenant((tx) => tx.q(`UPDATE held_actions SET hold_until = now() - interval '1 second' WHERE status = 'holding'`));
  const runHolds = async () => {
    await holdEnds();
    await jobs.runDue(Date.now() + 10 * 60_000, ['hold.execute']);
  };
  const book = (hhmm: string, phone: string, name: string) =>
    http().post(`/public/businesses/${S.slug}/bookings`).send({ serviceId: haircut.id, start: zonedTimeToUtc(day(1), hhmm, TZ).toISOString(), name, phone }).expect(201);

  beforeAll(async () => {
    app = await bootApp();
    db = app.get(DbService);
    jobs = app.get(JobsService);
    S = await onboard(app, 'salon', 'Trust Salon');
    await upgrade(app, S.businessId, 'plus');
    haircut = (await S.api.get('/onboarding/state').expect(200)).body.services.find((s: any) => s.name === 'Haircut');
    // Quiet hours that never get in the way of these tests (a one-minute window at 3 am).
    await tenant((tx) => tx.q(`UPDATE business_profiles SET quiet_hours = '{"from":"03:00","to":"03:01"}' WHERE business_id = app_current_business()`));
    await book('11:00', '9822200001', 'Rohan Rao');
    await book('12:00', '9822200002', 'Priya Shah');
    await book('13:00', '9822200003', 'Kiran Das');
    // Count what would really go out to customers.
    deliver = jest.spyOn(app.get(ChannelsService), 'deliver').mockImplementation(async () => ({ delivered: true, channel: 'whatsapp' }));
  });
  beforeEach(() => {
    deliver.mockClear();
    fake().reset();
  });
  afterAll(async () => {
    deliver.mockRestore();
    await app.close();
  });

  it('a group message shows a preview first, then waits 2 minutes; Undo within the hold sends zero messages', async () => {
    callOnce('message_group', { audience: 'booked_tomorrow', text: 'Hi {{name}}, we open at 10 tomorrow!', confirmed: false });
    await S.api.post('/bridge/commands', { text: 'tell everyone booked tomorrow we open at 10' }).expect(201);
    const preview = JSON.parse((fake().calls.at(-1)!.messages.at(-1)!.content as any)[0].content);
    expect(preview).toMatchObject({ preview: true, count: 3, sample_names: expect.arrayContaining(['Rohan', 'Priya', 'Kiran']) });
    expect(preview.sample_message).toMatch(/^Hi (Rohan|Priya|Kiran), we open at 10 tomorrow!$/);
    expect(await tenant((tx) => tx.q(`SELECT 1 FROM held_actions`))).toHaveLength(0); // a preview holds nothing

    callOnce('message_group', { audience: 'booked_tomorrow', text: 'Hi {{name}}, we open at 10 tomorrow!', confirmed: true });
    await S.api.post('/bridge/commands', { text: 'yes send it' }).expect(201);
    const held = (await S.api.get('/trust/held').expect(200)).body;
    expect(held[0]).toMatchObject({ type: 'bulk_message', status: 'holding', audience: 3, summary: { key: 'held.bulk', params: { count: 3 } } });
    const wait = (new Date(held[0].holdUntil).getTime() - new Date(held[0].createdAt).getTime()) / 1000;
    expect(Math.round(wait)).toBe(120);
    // The Bridge shows it too (for the undo bar).
    expect((await S.api.get('/bridge').expect(200)).body.held[0].id).toBe(held[0].id);

    await S.api.post(`/trust/held/${held[0].id}/undo`).expect(201);
    await runHolds();
    expect(deliver).not.toHaveBeenCalled();
    const row = await tenant((tx) => tx.one(`SELECT status, cancelled_via FROM held_actions WHERE id = $1`, [held[0].id]));
    expect(row).toEqual({ status: 'cancelled', cancelled_via: 'app' });
    const feed = (await S.api.get('/bridge').expect(200)).body.feed;
    expect(feed[0].sentence.key).toBe('feed.orbit.undone');
  });

  it('without Undo it goes out when the hold ends, re-checking contact caps; after that it cannot be undone, only corrected', async () => {
    // Kiran already heard from the business 3 times this week (the weekly cap): skipped.
    const kiran = await tenant((tx) => tx.one(`SELECT id FROM customers WHERE phone LIKE '%9822200003'`));
    await tenant((tx) => tx.q(`INSERT INTO contact_log (customer_id, channel, agent_key, at) SELECT $1, 'whatsapp', 'nudge', now() FROM generate_series(1, 3)`, [kiran.id]));
    callOnce('message_group', { audience: 'booked_tomorrow', text: 'Hi {{name}}, bring a towel!', confirmed: true });
    await S.api.post('/bridge/commands', { text: 'send it' }).expect(201);
    const [held] = (await S.api.get('/trust/held').expect(200)).body;
    await jobs.runDue(Date.now(), ['hold.execute']); // too early: nothing happens
    expect(deliver).not.toHaveBeenCalled();
    await runHolds();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls.map((c) => c[2].body).sort()).toEqual(['Hi Priya, bring a towel!', 'Hi Rohan, bring a towel!']);
    const done = await tenant((tx) => tx.one(`SELECT status, result FROM held_actions WHERE id = $1`, [held.id]));
    expect(done.status).toBe('executed');
    expect(done.result).toMatchObject({ sent: 2, skipped: { contact_cap: 1 } });
    // Running the job again is harmless.
    await jobs.runDue(Date.now() + 60_000);
    await app.get(HoldService).execute(S.businessId, held.id);
    expect(deliver).toHaveBeenCalledTimes(2);

    const late = await S.api.post(`/trust/held/${held.id}/undo`);
    expect(late.body.error.code).toBe('already_sent');

    // "Send a correction" drafts a polite follow-up for approval; approving it goes through the same hold.
    const c = await S.api.post(`/trust/held/${held.id}/correction`).expect(201);
    const card = (await S.api.get('/bridge').expect(200)).body.needsYou.find((x: any) => x.id === c.body.cardId);
    expect(card).toMatchObject({ type: 'correction', title: { key: 'card.correction', params: { count: 2 } } });
    expect(card.suggestedAction.text).toMatch(/^Sorry, please ignore our last message/);
    deliver.mockClear();
    await S.api.post(`/bridge/cards/${card.id}/decide`, { option: 'send' }).expect(201);
    await runHolds();
    expect(deliver).toHaveBeenCalledTimes(2); // only the two who got it, cap or not
  });

  it('one message waits 30 seconds; hold times are the owner’s to change (0–5 minutes)', async () => {
    const rohan = await tenant((tx) => tx.one(`SELECT id FROM customers WHERE phone LIKE '%9822200001'`));
    callOnce('message_customer', { customer_id: rohan.id, text: 'See you at 11!' });
    await S.api.post('/bridge/commands', { text: 'tell Rohan see you at 11' }).expect(201);
    const [h] = (await S.api.get('/trust/held').expect(200)).body;
    expect(h).toMatchObject({ type: 'message', status: 'holding', summary: { key: 'held.message', params: { customer: 'Rohan' } } });
    expect(Math.round((new Date(h.holdUntil).getTime() - new Date(h.createdAt).getTime()) / 1000)).toBe(30);
    await runHolds();
    expect(deliver).toHaveBeenCalledTimes(1);

    expect((await S.api.get('/trust/safety').expect(200)).body.holdSeconds).toEqual({ message: 30, booking_change: 30, bulk_message: 120, calls: 120 });
    expect((await S.api.patch('/trust/safety', { holdSeconds: { message: 600 } })).status).toBe(400);
    await S.api.patch('/trust/safety', { holdSeconds: { message: 0 } }).expect(200);
    callOnce('message_customer', { customer_id: rohan.id, text: 'Running 5 min late, sorry!' });
    await S.api.post('/bridge/commands', { text: 'tell Rohan we are late' }).expect(201);
    const [h2] = (await S.api.get('/trust/held').expect(200)).body;
    expect(new Date(h2.holdUntil).getTime() - new Date(h2.createdAt).getTime()).toBeLessThan(1000);
    await runHolds();
    await S.api.patch('/trust/safety', { holdSeconds: { message: 30 } }).expect(200);
  });

  it('if the app is closed during the hold (or the job is lost), it still goes out on time', async () => {
    const priya = await tenant((tx) => tx.one(`SELECT id FROM customers WHERE phone LIKE '%9822200002'`));
    callOnce('message_customer', { customer_id: priya.id, text: 'Your stylist today is Asha.' });
    await S.api.post('/bridge/commands', { text: 'tell Priya her stylist is Asha' }).expect(201);
    jobs.pending.splice(0, jobs.pending.length); // the delayed job never fires
    await tenant((tx) => tx.q(`UPDATE held_actions SET hold_until = now() - interval '30 seconds' WHERE status = 'holding'`));
    expect(await app.get(HoldService).sweep()).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][2].body).toBe('Your stylist today is Asha.');
  });

  it('Why?: Nudge’s reminder has a trace; the sentence uses only its facts; “Don’t do this again for Rohan” stops it for Rohan', async () => {
    const nudge = app.get(NudgeService);
    const rohan = await tenant((tx) => tx.one(`SELECT id FROM customers WHERE phone LIKE '%9822200001'`));
    const due = await tenant((tx) => tx.q(`SELECT id, send_at FROM scheduled_messages WHERE customer_id = $1 AND kind = 'reminder' AND status = 'scheduled' ORDER BY send_at`, [rohan.id]));
    expect(due.length).toBeGreaterThan(0);
    expect((await nudge.process(S.businessId, due[0].id, new Date(due[0].send_at))).status).toBe('sent');

    const feed = (await S.api.get('/bridge').expect(200)).body.feed;
    const item = feed.find((f: any) => f.type === 'reminder_sent');
    expect(item.traceId).toBeTruthy();
    const w = (await S.api.get(`/trust/traces/${item.traceId}`).expect(200)).body;
    expect(w).toMatchObject({ canException: true, exceptionId: null, trace: { agent: 'nudge', trigger: { kind: 'sequence_rule' }, rule: { code: 'nudge.reminder' }, customer: { name: 'Rohan' }, approver: { kind: 'auto_rule' } } });
    expect(w.trace.facts[0]).toMatchObject({ code: 'booking_at', ref: { type: 'booking' } });
    for (const lang of ['en', 'hi', 'kn']) {
      const sentence = explainTrace(lang, w.trace, { timeZone: TZ });
      expect(ungroundedWords(lang, sentence, w.trace, { timeZone: TZ })).toEqual([]);
    }
    expect(explainTrace('en', w.trace, { timeZone: TZ })).toMatch(/^Rohan’s Haircut is on .+ at 11:00 am, so Nudge sent Rohan a reminder \(your “.+” rule\)\.$/);

    await S.api.post(`/trust/traces/${item.traceId}/feedback`, { verdict: 'exception' }).expect(201);
    // Rohan's other reminders are cancelled, and a new booking's reminders are skipped for him.
    expect(await tenant((tx) => tx.q(`SELECT 1 FROM scheduled_messages WHERE customer_id = $1 AND kind = 'reminder' AND status = 'scheduled'`, [rohan.id]))).toHaveLength(0);
    await book('16:00', '9822200001', 'Rohan Rao');
    const next = await tenant((tx) => tx.one(`SELECT id, send_at FROM scheduled_messages WHERE customer_id = $1 AND kind = 'reminder' AND status = 'scheduled' ORDER BY send_at LIMIT 1`, [rohan.id]));
    deliver.mockClear();
    expect(await nudge.process(S.businessId, next.id, new Date(next.send_at))).toEqual({ status: 'skipped', reason: 'owner_exception' });
    expect(deliver).not.toHaveBeenCalled();
    // Priya still gets hers.
    const p = await tenant((tx) => tx.one(`SELECT sm.id, sm.send_at FROM scheduled_messages sm JOIN customers c ON c.id = sm.customer_id WHERE c.phone LIKE '%9822200002' AND sm.kind = 'reminder' AND sm.status = 'scheduled' ORDER BY sm.send_at LIMIT 1`));
    expect((await nudge.process(S.businessId, p.id, new Date(p.send_at))).status).toBe('sent');

    const ex = (await S.api.get('/trust/exceptions').expect(200)).body;
    expect(ex).toEqual([expect.objectContaining({ rule: 'nudge.reminder', customer: 'Rohan Rao' })]);
    expect((await S.api.get(`/trust/traces/${item.traceId}`).expect(200)).body.exceptionId).toBe(ex[0].id);

    // Feedback reaches the admin centre, per rule.
    await S.api.post(`/trust/traces/${item.traceId}/feedback`, { verdict: 'good' }).expect(201);
    const admin = await adminApi(app);
    const report = (await admin.get('/admin/reports/trust').expect(200)).body;
    expect(report.rules.find((r: any) => r.rule === 'nudge.reminder')).toMatchObject({ good: expect.any(Number), exceptions: expect.any(Number) });
    expect(report.undo.find((u: any) => u.type === 'bulk_message').undone).toBeGreaterThanOrEqual(1);
  });

  it('every agent action in this suite has a decision trace with a trigger and facts, and every explanation is grounded', async () => {
    const rows = await tenant((tx) =>
      tx.q(
        `SELECT f.event_type, f.trace_id, t.agent_key, t.action, t.trigger, t.rule, t.facts, t.approver FROM feed_events f LEFT JOIN decision_traces t ON t.id = f.trace_id
         WHERE (f.agent_key <> 'orbit' AND f.event_type <> 'held_cancelled') OR f.event_type IN ('message_sent', 'bulk_sent', 'correction_sent', 'answered', 'booking_created')`,
      ),
    );
    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) {
      expect({ type: r.event_type, traced: !!r.trace_id }).toEqual({ type: r.event_type, traced: true });
      expect(r.trigger.kind).toBeTruthy();
      if (r.event_type !== 'answered') expect(r.facts.length).toBeGreaterThan(0);
      const trace: DecisionTrace = { agent: r.agent_key, action: r.action, trigger: r.trigger, rule: r.rule, facts: r.facts, approver: r.approver };
      for (const lang of ['en', 'hi', 'kn']) {
        const s = explainTrace(lang, trace, { timeZone: TZ });
        expect({ s, bad: ungroundedWords(lang, s, trace, { timeZone: TZ }) }).toEqual({ s, bad: [] });
      }
    }
  });

  it('old actions without a trace say so (no invented reason)', async () => {
    const f = await tenant((tx) => tx.one(`INSERT INTO feed_events (agent_key, event_type, sentence) VALUES ('aria', 'question_answered', '{"key":"feed.aria.answered"}') RETURNING id, trace_id`));
    expect(f.trace_id).toBeNull();
    const item = (await S.api.get('/bridge').expect(200)).body.feed.find((x: any) => x.id === f.id);
    expect(item.traceId).toBeNull(); // the sheet shows "I don't have the details for this one."
  });

  it('settings and knowledge changes can be undone for 24 hours (newest first)', async () => {
    await S.api.patch('/crew/nudge', { personality: 'formal' }).expect(200);
    await S.api.patch('/crew/nudge', { displayName: 'Buddy' }).expect(200);
    let changes = (await S.api.get('/trust/changes').expect(200)).body;
    expect(changes.slice(0, 2).map((c: any) => c.label)).toEqual([
      { key: 'change.agent', params: { agent: 'Buddy' } },
      { key: 'change.agent', params: { agent: 'Nudge' } },
    ]);
    expect((await S.api.post(`/trust/changes/${changes[1].id}/undo`)).body.error.code).toBe('newer_change');
    await S.api.post(`/trust/changes/${changes[0].id}/undo`).expect(201);
    await S.api.post(`/trust/changes/${changes[1].id}/undo`).expect(201);
    const crew = (await S.api.get('/crew/settings').expect(200)).body.crew.find((c: any) => c.agent === 'nudge');
    expect(crew).toMatchObject({ name: 'Nudge', personality: 'friendly' });

    const k = await S.api.post('/knowledge', { type: 'faq', title: 'Parking', content: 'Free parking behind the salon.', language: 'en', active: true }).expect(201);
    changes = (await S.api.get('/trust/changes').expect(200)).body;
    expect(changes[0].label).toEqual({ key: 'change.knowledge_added', params: { title: 'Parking' } });
    await S.api.post(`/trust/changes/${changes[0].id}/undo`).expect(201);
    // Aria no longer knows it.
    expect((await S.api.get('/knowledge').expect(200)).body.find((x: any) => x.id === k.body.id)).toBeUndefined();
  });

  it('review before sending: Aria drafts, the owner approves, then it goes out', async () => {
    await S.api.patch('/trust/safety', { reviewBeforeSend: { website_chat: true } }).expect(200);
    const s = await http().post(`/public/businesses/${S.slug}/chat`).send({ channel: 'website_chat' }).expect(201);
    const chat = { id: s.body.conversationId, token: s.body.visitorToken };
    fake().script = () => [text('We are open 10 to 9 every day.')];
    const r = await http().post(`/public/businesses/${S.slug}/chat/${chat.id}/messages`).set('x-visitor-token', chat.token).send({ text: 'What are your timings?' }).expect(201);
    expect(r.body.messages.map((m: any) => m.body)).toEqual(['What are your timings?']); // nothing sent yet
    const card = (await S.api.get('/bridge').expect(200)).body.needsYou.find((c: any) => c.type === 'reply_review');
    expect(card).toMatchObject({ suggestedAction: { text: 'We are open 10 to 9 every day.' }, traceId: expect.any(String) });
    await S.api.post(`/bridge/cards/${card.id}/decide`, { option: 'send' }).expect(201);
    const h = await http().get(`/public/businesses/${S.slug}/chat/${chat.id}/messages`).set('x-visitor-token', chat.token).expect(200);
    expect(h.body.messages.map((m: any) => m.body).slice(-2)).toEqual(['What are your timings?', 'We are open 10 to 9 every day.']);
    await S.api.patch('/trust/safety', { reviewBeforeSend: { website_chat: false } }).expect(200);
  });

  it('other businesses cannot see or undo these actions', async () => {
    const other = await onboard(app, 'gym', 'Other Gym');
    const [h] = (await S.api.get('/trust/held').expect(200)).body;
    expect((await other.api.get('/trust/held').expect(200)).body).toEqual([]);
    expect((await other.api.post(`/trust/held/${h.id}/undo`)).status).toBe(404);
  });
});
