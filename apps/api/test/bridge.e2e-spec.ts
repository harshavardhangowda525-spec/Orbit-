import { AiService } from '../src/ai/ai.service';
import { AiUnavailableError } from '../src/ai/provider';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import { translate } from '@orbit/shared';
import { seed } from '../src/scripts/seed';
import { bootApp, signIn, api, SEED } from './helpers';

describe('The Bridge with seeded businesses', () => {
  let app: NestExpressApplication;
  let ids: { salon: string; gym: string };
  beforeAll(async () => {
    ids = await seed(process.env.DATABASE_MIGRATION_URL);
    app = await bootApp();
  });
  afterAll(() => app.close());

  it('renders Pulse, Needs You, Orbit Feed and Earnings for the salon', async () => {
    const owner = await signIn(app, SEED.salon);
    const started = Date.now();
    const r = await api(app, owner.token, ids.salon).get('/bridge').expect(200);
    const elapsed = Date.now() - started;
    const b = r.body;
    expect(b.business.name).toBe('Glow Studio');
    expect(['morning', 'evening']).toContain(b.mode);
    expect(b.pulse.score).toBeGreaterThanOrEqual(0);
    expect(b.pulse.score).toBeLessThanOrEqual(100);
    expect(b.pulse.numbers.bookingsToday).toBe(9);
    expect(b.pulse.numbers.peopleWaiting).toBe(2);
    // A bad review is open, so it leads the Pulse sentence.
    expect(b.pulse.sentence.key).toBe('pulse.bad_review');
    expect(b.needsYou.map((c: any) => c.type).sort()).toEqual(['discount', 'review_reply']);
    expect(translate('en', b.needsYou.find((c: any) => c.type === 'discount').title.key, b.needsYou.find((c: any) => c.type === 'discount').title.params)).toBe('Priya asked for a discount. Offer 10%?');
    // Three back-to-back Aria bookings are grouped into one line.
    const grouped = b.feed.find((g: any) => g.type === 'booking_created');
    expect(grouped.items).toHaveLength(3);
    expect(translate('en', grouped.sentence.key, grouped.sentence.params)).toBe('Aria booked 3 appointments');
    expect(b.earnings.total).toBeGreaterThan(0);
    expect(b.earnings.byAgent.map((x: any) => x.agent)).toContain('ledger');
    expect(b.briefing.length).toBeGreaterThan(1);
    expect(b.suggestions).toHaveLength(3);
    expect(elapsed).toBeLessThan(1500);
  });

  it('gym owner sees only the gym, with the Spark campaign card', async () => {
    const owner = await signIn(app, SEED.gym);
    const b = (await api(app, owner.token, ids.gym).get('/bridge').expect(200)).body;
    expect(b.business.name).toBe('IronCore Gym');
    expect(b.needsYou).toHaveLength(1);
    expect(b.needsYou[0]).toMatchObject({ agent: 'spark', type: 'campaign' });
    expect(translate('en', b.needsYou[0].title.key, b.needsYou[0].title.params)).toBe('Spark drafted a Diwali offer for 214 customers. Send?');
    expect((await api(app, owner.token, ids.salon).get('/bridge')).status).toBe(403);
  });

  it('deciding a card is one tap and appears in the Feed', async () => {
    const owner = await signIn(app, SEED.salon);
    const a = api(app, owner.token, ids.salon);
    const card = (await a.get('/bridge').expect(200)).body.needsYou.find((c: any) => c.type === 'discount');
    expect((await a.post(`/bridge/cards/${card.id}/decide`, { option: 'maybe' })).body.error.code).toBe('invalid_option');
    await a.post(`/bridge/cards/${card.id}/decide`, { option: 'yes' }).expect(201);
    expect((await a.post(`/bridge/cards/${card.id}/decide`, { option: 'no' })).body.error.code).toBe('already_decided');
    const b = (await a.get('/bridge').expect(200)).body;
    expect(b.needsYou.map((c: any) => c.id)).not.toContain(card.id);
    expect(b.feed[0].sentence).toMatchObject({ key: 'feed.orbit.card_approved', params: { agent: 'Aria' } });
  });

  it('expired cards fall back to their safe default ("don\'t send")', async () => {
    const c = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
    await c.connect();
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.business_id', $1, true)`, [ids.gym]);
    const task = await c.query(`INSERT INTO tasks (agent_key, created_by_kind, goal, status) VALUES ('spark', 'orbit', 'send offer', 'waiting_approval') RETURNING id`);
    await c.query(`UPDATE approval_cards SET expires_at = now() - interval '1 minute', task_id = $1 WHERE type = 'campaign'`, [task.rows[0].id]);
    await c.query('COMMIT');
    const owner = await signIn(app, SEED.gym);
    const b = (await api(app, owner.token, ids.gym).get('/bridge').expect(200)).body;
    expect(b.needsYou).toEqual([]);
    expect(b.feed[0].sentence.key).toBe('feed.orbit.card_expired');
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.business_id', $1, true)`, [ids.gym]);
    const r = await c.query(`SELECT a.status, a.decision, t.status AS task_status FROM approval_cards a JOIN tasks t ON t.id = a.task_id WHERE a.type = 'campaign'`);
    await c.query('COMMIT');
    await c.end();
    expect(r.rows[0]).toEqual({ status: 'expired', decision: 'no', task_status: 'cancelled' });
  });

  it('Orbit answers in the Command Bar with real data, opens screens, and logs the task', async () => {
    const owner = await signIn(app, SEED.salon);
    const a = api(app, owner.token, ids.salon);
    // Demo brain (AI_PROVIDER=fake): looks up customers through the tools, opens the People screen.
    const r = await a.post('/bridge/commands', { text: 'show my customers', language: 'en' }).expect(201);
    expect(r.body.reply).toMatch(/^Here are your customers: /);
    expect(r.body.actions).toEqual([{ type: 'open', screen: 'people' }]);
    expect(r.body.steps.map((s: any) => s.key)).toEqual(['assistant.step.open_screen', 'assistant.step.find_customers']);
    const tasks = (await a.get('/tasks').expect(200)).body;
    expect(tasks[0]).toMatchObject({ id: r.body.taskId, agent: 'orbit', goal: 'show my customers', status: 'done', createdBy: 'owner' });

    // Streaming: each step arrives as its own line, the answer last.
    const stream = await a.post('/bridge/commands', { text: "today's bookings" }).set('accept', 'application/x-ndjson').expect(201);
    expect(stream.headers['content-type']).toMatch(/application\/x-ndjson/);
    const events = stream.text.trim().split('\n').map((l) => JSON.parse(l));
    expect(events[0]).toEqual({ type: 'step', label: { key: 'assistant.step.todays_schedule' } });
    expect(events[events.length - 1]).toMatchObject({ type: 'reply' });
    expect(events[events.length - 1].text).toMatch(/booking|No bookings/);
  });

  it('Orbit says plainly when its AI cannot be reached', async () => {
    const owner = await signIn(app, SEED.salon);
    const fake = (app as any).get(AiService).fake;
    fake.script = () => {
      throw new AiUnavailableError('down');
    };
    try {
      const r = await api(app, owner.token, ids.salon).post('/bridge/commands', { text: 'hi' }).expect(201);
      expect(r.body).toMatchObject({ reply: null, error: { key: 'assistant.unavailable' } });
    } finally {
      fake.reset();
    }
  });
});
