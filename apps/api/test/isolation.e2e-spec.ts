/**
 * DATA ISOLATION (non-negotiable principle 2).
 *
 * Two businesses are created through the real onboarding API. Each gets
 * customers, conversations, messages, bookings, tasks, approval cards, feed
 * events and knowledge. We then prove — through the API AND directly in the
 * database as the app role — that neither business can read or change the other's data.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client } from 'pg';
import { bootApp, onboard, signIn, api, appDb, asTenant, SEED } from './helpers';

type Biz = Awaited<ReturnType<typeof onboard>> & { customerId: string; conversationId: string; bookingId: string; taskId: string; cardId: string; feedId: string };

const PLATFORM_TABLES_WITH_BUSINESS_ID = ['memberships', 'audit_log', 'oauth_states'];

describe('data isolation between businesses', () => {
  let app: NestExpressApplication;
  let db: Client;
  let A: Biz;
  let B: Biz;

  async function addData(b: Awaited<ReturnType<typeof onboard>>, tag: string): Promise<Biz> {
    return asTenant(db, b.businessId, async () => {
      const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
      const customer = await q(`INSERT INTO customers (name, phone) VALUES ($1, $2) RETURNING id`, [`Customer ${tag}`, `+9199000${tag === 'A' ? '11111' : '22222'}`]);
      const service = await q(`SELECT id FROM services LIMIT 1`);
      const staff = await q(`SELECT id FROM staff LIMIT 1`);
      const conv = await q(`INSERT INTO conversations (customer_id, channel, status) VALUES ($1, 'website_chat', 'waiting_staff') RETURNING id`, [customer.id]);
      await q(`INSERT INTO messages (conversation_id, direction, sender, body) VALUES ($1, 'in', 'customer', $2)`, [conv.id, `secret message from ${tag}`]);
      const booking = await q(
        `INSERT INTO bookings (customer_id, service_id, staff_id, start_at, end_at) VALUES ($1, $2, $3, now() + interval '1 hour', now() + interval '2 hours') RETURNING id`,
        [customer.id, service.id, staff.id],
      );
      const task = await q(`INSERT INTO tasks (agent_key, created_by_kind, goal, status) VALUES ('nudge', 'orbit', $1, 'waiting_approval') RETURNING id`, [`task ${tag}`]);
      const card = await q(
        `INSERT INTO approval_cards (task_id, agent_key, type, title, options) VALUES ($1, 'nudge', 'campaign', $2, $3) RETURNING id`,
        [task.id, JSON.stringify({ key: 'card.campaign', params: { count: 5, occasion: tag } }), JSON.stringify([{ key: 'send', label: 'card.option.send', outcome: 'approved' }])],
      );
      const feed = await q(`INSERT INTO feed_events (agent_key, event_type, sentence) VALUES ('aria', 'booking_created', $1) RETURNING id`, [JSON.stringify({ key: 'feed.aria.booked', params: { customer: tag } })]);
      await q(`INSERT INTO knowledge_items (type, title, content) VALUES ('note', $1, $2)`, [`private note ${tag}`, `only for ${tag}`]);
      return { ...b, customerId: customer.id, conversationId: conv.id, bookingId: booking.id, taskId: task.id, cardId: card.id, feedId: feed.id };
    });
  }

  beforeAll(async () => {
    app = await bootApp();
    db = await appDb();
    A = await addData(await onboard(app, 'salon', 'Alpha Salon'), 'A');
    B = await addData(await onboard(app, 'clinic', 'Beta Clinic'), 'B');
  });

  afterAll(async () => {
    await db.end();
    await app.close();
  });

  // ---------- Database level ----------

  it('every table with business_id has RLS enabled and forced (except platform tables)', async () => {
    const r = await db.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN information_schema.columns col ON col.table_schema = n.nspname AND col.table_name = c.relname AND col.column_name = 'business_id'
      WHERE n.nspname = 'public' AND c.relkind = 'r'`);
    const unprotected = r.rows.filter((t) => !PLATFORM_TABLES_WITH_BUSINESS_ID.includes(t.relname) && !(t.relrowsecurity && t.relforcerowsecurity));
    expect(unprotected.map((t) => t.relname)).toEqual([]);
    expect(r.rows.length).toBeGreaterThan(30);
  });

  it('the app database role cannot bypass RLS and does not own tables', async () => {
    const role = await db.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned = await db.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user`);
    expect(owned.rows[0].n).toBe(0);
  });

  it('with no business set, the app role sees no business data at all', async () => {
    const tables = (await db.query(`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'business_id'`)).rows
      .map((r) => r.table_name)
      .filter((t) => !PLATFORM_TABLES_WITH_BUSINESS_ID.includes(t));
    for (const t of tables) {
      const r = await db.query(`SELECT count(*)::int AS n FROM "${t}"`);
      expect({ t, n: r.rows[0].n }).toEqual({ t, n: 0 });
    }
  });

  it('business A context sees zero rows of business B in every table', async () => {
    const tables = (await db.query(`SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'business_id'`)).rows
      .map((r) => r.table_name)
      .filter((t) => !PLATFORM_TABLES_WITH_BUSINESS_ID.includes(t));
    await asTenant(db, A.businessId, async () => {
      for (const t of tables) {
        const r = await db.query(`SELECT count(*)::int AS n FROM "${t}" WHERE business_id = $1`, [B.businessId]);
        expect({ t, n: r.rows[0].n }).toEqual({ t, n: 0 });
      }
      const own = await db.query(`SELECT count(*)::int AS n FROM customers`);
      expect(own.rows[0].n).toBe(1);
    });
  });

  it('business A cannot insert, update or delete business B rows', async () => {
    await expect(asTenant(db, A.businessId, () => db.query(`INSERT INTO customers (business_id, name) VALUES ($1, 'intruder')`, [B.businessId]))).rejects.toThrow(/row-level security/);
    await asTenant(db, A.businessId, async () => {
      const u = await db.query(`UPDATE customers SET name = 'hacked' WHERE id = $1`, [B.customerId]);
      expect(u.rowCount).toBe(0);
      const d = await db.query(`DELETE FROM messages WHERE business_id = $1`, [B.businessId]);
      expect(d.rowCount).toBe(0);
    });
    // Moving one of A's rows into B is refused too.
    await expect(
      asTenant(db, A.businessId, () => db.query(`UPDATE customers SET business_id = $1 WHERE id = $2`, [B.businessId, A.customerId])),
    ).rejects.toThrow(/row-level security/);
    await asTenant(db, B.businessId, async () => {
      const r = await db.query(`SELECT name FROM customers WHERE id = $1`, [B.customerId]);
      expect(r.rows[0].name).toBe('Customer B');
    });
  });

  it("a row in A can never reference B's rows (composite foreign keys)", async () => {
    // Even the schema owner (who could see both) cannot link across businesses.
    const { Client } = require('pg');
    const owner = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
    await owner.connect();
    await owner.query('BEGIN');
    await owner.query(`SELECT set_config('app.business_id', $1, true)`, [A.businessId]);
    await expect(
      owner.query(`INSERT INTO conversations (customer_id, channel) VALUES ($1, 'website_chat')`, [B.customerId]),
    ).rejects.toThrow(/foreign key/);
    await owner.query('ROLLBACK');
    await owner.end();
  });

  it('the business context does not leak between pooled connections', async () => {
    await asTenant(db, A.businessId, async () => undefined);
    const r = await db.query(`SELECT count(*)::int AS n FROM customers`);
    expect(r.rows[0].n).toBe(0);
  });

  // ---------- API level ----------

  const tenantRoutes = (b: Biz) => [
    '/bridge',
    '/onboarding/state',
    '/customers',
    `/customers/${b.customerId}`,
    '/bookings',
    '/conversations',
    `/conversations/${b.conversationId}/messages`,
    '/tasks',
    '/crew',
  ];

  it("owner A is refused on every route when asking for B's business", async () => {
    const asA = api(app, A.owner.token, B.businessId);
    for (const route of tenantRoutes(B)) {
      const r = await asA.get(route);
      expect({ route, status: r.status }).toEqual({ route, status: 403 });
    }
    expect((await asA.post(`/bridge/cards/${B.cardId}/decide`, { option: 'send' })).status).toBe(403);
    expect((await asA.post('/bridge/commands', { text: 'send everyone a message' })).status).toBe(403);
    expect((await asA.put('/onboarding/calendar', { mode: 'builtin' })).status).toBe(403);
    expect((await asA.post('/onboarding/launch')).status).toBe(403);
  });

  it("owner A's own routes return only A's data", async () => {
    const a = A.api;
    const customers = (await a.get('/customers').expect(200)).body;
    expect(customers.map((c: any) => c.id)).toEqual([A.customerId]);
    const bookings = (await a.get('/bookings').expect(200)).body;
    expect(bookings.map((b: any) => b.id)).toEqual([A.bookingId]);
    const tasks = (await a.get('/tasks').expect(200)).body.map((t: any) => t.id);
    expect(tasks).toContain(A.taskId);
    expect(tasks).not.toContain(B.taskId);
    const convs = (await a.get('/conversations').expect(200)).body.map((c: any) => c.id);
    expect(convs).toEqual([A.conversationId]);
    const crew = (await a.get('/crew').expect(200)).body;
    expect(crew).toHaveLength(6);

    const bridge = (await a.get('/bridge').expect(200)).body;
    const json = JSON.stringify(bridge);
    for (const id of [B.businessId, B.customerId, B.cardId, B.feedId, B.taskId]) expect(json).not.toContain(id);
    expect(bridge.needsYou.map((c: any) => c.id)).toEqual([A.cardId]);
  });

  it("guessing B's ids from A's own business returns nothing", async () => {
    const a = A.api;
    expect((await a.get(`/customers/${B.customerId}`)).status).toBe(404);
    expect((await a.get(`/conversations/${B.conversationId}/messages`).expect(200)).body).toEqual([]);
    expect((await a.post(`/bridge/cards/${B.cardId}/decide`, { option: 'send' })).status).toBe(404);
    // B's card is untouched.
    const bCards = (await B.api.get('/bridge').expect(200)).body.needsYou;
    expect(bCards.map((c: any) => c.id)).toEqual([B.cardId]);
  });

  it('a signed-in user with no membership gets nothing', async () => {
    const stranger = await signIn(app);
    for (const route of tenantRoutes(A)) {
      expect((await api(app, stranger.token, A.businessId).get(route)).status).toBe(403);
    }
    expect((await api(app, stranger.token).get('/customers')).status).toBe(403);
    expect((await api(app, '', A.businessId).get('/customers')).status).toBe(401);
  });

  it('the public page of A shows only A', async () => {
    const pub = await api(app, '').get(`/public/businesses/${A.slug}`).expect(200);
    expect(pub.body.name).toBe('Alpha Salon');
    const json = JSON.stringify(pub.body);
    expect(json).not.toContain('Beta Clinic');
    expect(json).not.toContain(B.businessId);
    expect(json).not.toContain(A.businessId); // internal ids are not exposed publicly
  });

  it('an admin impersonation token is locked to one business', async () => {
    const admin = await signIn(app, SEED.admin);
    const imp = await api(app, admin.token).post(`/admin/businesses/${A.businessId}/impersonate`).expect(201);
    expect((await api(app, imp.body.token, A.businessId).get('/customers').expect(200)).body).toHaveLength(1);
    expect((await api(app, imp.body.token, B.businessId).get('/customers')).status).toBe(403);
    // Impersonation never grants admin powers.
    expect((await api(app, imp.body.token).get('/admin/businesses')).status).toBe(403);
    const audit = await api(app, admin.token).get('/admin/audit').expect(200);
    expect(audit.body.some((e: any) => e.action === 'admin.impersonate' && e.business_id === A.businessId)).toBe(true);
  });
});
