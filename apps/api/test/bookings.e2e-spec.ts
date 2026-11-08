import { Client } from 'pg';
import { bootApp, onboard } from './helpers';

/** The database itself makes double booking impossible, even under concurrent requests. */
describe('double booking protection', () => {
  it('only one of many concurrent overlapping bookings for the same staff member succeeds', async () => {
    const app = await bootApp();
    const biz = await onboard(app, 'salon', 'Race Salon');
    await app.close();
    const clients = await Promise.all(Array.from({ length: 8 }, async () => {
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      return c;
    }));
    const setup = clients[0];
    await setup.query('BEGIN');
    await setup.query(`SELECT set_config('app.business_id', $1, true)`, [biz.businessId]);
    const { rows: [ids] } = await setup.query(`SELECT (SELECT id FROM services LIMIT 1) AS service, (SELECT id FROM staff LIMIT 1) AS staff`);
    await setup.query('COMMIT');
    const start = new Date(Date.now() + 86_400_000);
    const results = await Promise.allSettled(
      clients.map(async (c, i) => {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.business_id', $1, true)`, [biz.businessId]);
        const s = new Date(start.getTime() + i * 3 * 60_000); // 30-min bookings within 21 min: every pair overlaps
        await c.query(`INSERT INTO bookings (service_id, staff_id, start_at, end_at) VALUES ($1, $2, $3, $4)`, [ids.service, ids.staff, s, new Date(s.getTime() + 30 * 60_000)]);
        await c.query('COMMIT');
      }),
    );
    await Promise.all(clients.map((c) => c.query('ROLLBACK').catch(() => undefined).then(() => c.end())));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    if (process.env.DEBUG_RACE) console.log(results.map((r: any) => String(r.reason ?? 'ok')));
    expect(ok).toBe(1);
    expect(results.filter((r) => r.status === 'rejected').every((r: any) => /conflicting key value|exclusion/.test(String(r.reason)))).toBe(true);
  });
});
