import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import { translate } from '@orbit/shared';
import { seed } from '../src/scripts/seed';
import { bootApp, signIn, api } from './helpers';

describe('The Bridge with seeded businesses', () => {
  let app: NestExpressApplication;
  let ids: { salon: string; gym: string };
  beforeAll(async () => {
    ids = await seed(process.env.DATABASE_MIGRATION_URL);
    app = await bootApp();
  });
  afterAll(() => app.close());

  it('renders Pulse, Needs You, Orbit Feed and Earnings for the salon', async () => {
    const owner = await signIn(app, '+919800000001');
    const started = Date.now();
    const r = await api(app, owner.token, ids.salon).get('/bridge').expect(200);
    const elapsed = Date.now() - started;
    const b = r.body;
    expect(b.business.name).toBe('Glow Salon');
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
    const owner = await signIn(app, '+919800000002');
    const b = (await api(app, owner.token, ids.gym).get('/bridge').expect(200)).body;
    expect(b.business.name).toBe('IronCore Gym');
    expect(b.needsYou).toHaveLength(1);
    expect(b.needsYou[0]).toMatchObject({ agent: 'spark', type: 'campaign' });
    expect(translate('en', b.needsYou[0].title.key, b.needsYou[0].title.params)).toBe('Spark drafted a Diwali offer for 214 customers. Send?');
    expect((await api(app, owner.token, ids.salon).get('/bridge')).status).toBe(403);
  });

  it('deciding a card is one tap and appears in the Feed', async () => {
    const owner = await signIn(app, '+919800000001');
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
    const owner = await signIn(app, '+919800000002');
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

  it('the Command Bar records the request as an Orbit task', async () => {
    const owner = await signIn(app, '+919800000001');
    const a = api(app, owner.token, ids.salon);
    const r = await a.post('/bridge/commands', { text: 'Block my calendar tomorrow afternoon' }).expect(201);
    expect(r.body.reply.key).toBe('command.received');
    const tasks = (await a.get('/tasks').expect(200)).body;
    expect(tasks[0]).toMatchObject({ id: r.body.taskId, agent: 'orbit', goal: 'Block my calendar tomorrow afternoon', status: 'queued', createdBy: 'owner' });
  });
});
