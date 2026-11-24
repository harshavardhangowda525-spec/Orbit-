import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client } from 'pg';
import request from 'supertest';
import { adminApi, appDb, asTenant, bootApp, onboard, upgrade } from './helpers';

describe('Phase 6: premium experience by plan', () => {
  let app: NestExpressApplication;
  let db: Client;
  let biz: Awaited<ReturnType<typeof onboard>>;
  let admin: Awaited<ReturnType<typeof adminApi>>;

  beforeAll(async () => {
    app = await bootApp();
    db = await appDb();
    biz = await onboard(app, 'salon', 'Velvet Salon');
    admin = await adminApi(app);
  });

  afterAll(async () => {
    await db.end();
    await app.close();
  });

  it('Free plan has Space/Light themes, locks Midnight/Pro themes, and returns real-data lock previews', async () => {
    const res = await biz.api.get('/experience').expect(200);
    expect(res.body.plan.code).toBe('free');
    expect(res.body.plan.experience.badge).toBe('none');
    expect(res.body.appearance.effectiveTheme).toBe('space');
    expect(res.body.wins).toBeNull();
    expect(res.body.morningStory).toBeNull();

    // Free can switch to light
    const light = await biz.api.patch('/experience/appearance', { theme: 'light' }).expect(200);
    expect(light.body.appearance.theme).toBe('light');

    // Free cannot switch to midnight (Plus+) or characters avatar (Pro+) or brandColor (Business+)
    await biz.api.patch('/experience/appearance', { theme: 'midnight' }).expect(403);
    await biz.api.patch('/experience/appearance', { avatarStyle: 'characters' }).expect(403);
    await biz.api.patch('/experience/appearance', { brandColor: '#FF5500' }).expect(403);
    await biz.api.get('/experience/report').expect(403);

    // Friendly real-data preview for a locked feature
    const prev = await biz.api.get('/experience/preview/vox').expect(200);
    expect(prev.body.plan.code).toBe('pro');
    expect(prev.body.headline.key).toBe('exp.lock.vox_headline');
    expect(prev.body.body.key).toBe('exp.lock.vox_body');
  });

  it('Appearance edits are undoable for 24h via trust versions', async () => {
    const changes = await biz.api.get('/trust/changes').expect(200);
    const appChange = changes.body.find((c: any) => c.entity === 'appearance' && !c.revertedAt);
    expect(appChange).toBeTruthy();

    await biz.api.post(`/trust/changes/${appChange.id}/undo`, {}).expect(201);

    const after = await biz.api.get('/experience').expect(200);
    expect(after.body.appearance.theme).toBe('space');
  });

  it('Upgrading Free → Pro records plan_change via trigger, shows celebration once, unlocks Pro themes & Morning Story', async () => {
    await upgrade(app, biz.businessId, 'pro');

    const bridge = await biz.api.get('/bridge').expect(200);
    const exp = bridge.body.experience;
    expect(exp.plan.code).toBe('pro');
    expect(exp.plan.experience.badge).toBe('shine');
    expect(exp.plan.experience.perks).toContain('heroTrails');
    expect(exp.plan.experience.perks).toContain('morningStory');
    expect(exp.wins).toBeTruthy();
    expect(exp.morningStory).toBeTruthy();
    expect(exp.planChange).toBeTruthy();
    expect(exp.planChange.direction).toBe('up');
    expect(exp.planChange.fromPlan).toBe('free');
    expect(exp.planChange.toPlan).toBe('pro');
    expect(exp.planChange.seenAt).toBeNull();
    expect(exp.planChange.newAgents).toEqual(expect.arrayContaining(['vox', 'nudge', 'ledger', 'spark']));
    expect(exp.planChange.highlights.length).toBeGreaterThanOrEqual(2);
    expect(exp.planChange.checklist.length).toBeGreaterThanOrEqual(2);

    // Pro can switch to sunrise + characters avatar (also auto-ticks checklist!)
    await biz.api.patch('/experience/appearance', { theme: 'sunrise', avatarStyle: 'characters' }).expect(200);

    // Mark celebration seen -> seenAt set so it only celebrates once
    await biz.api.post(`/experience/plan-change/${exp.planChange.id}/seen`, {}).expect(201);

    // Tick a checklist item explicitly
    await biz.api.post(`/experience/plan-change/${exp.planChange.id}/tick`, { item: 'try_story' }).expect(201);

    const after = await biz.api.get('/experience').expect(200);
    expect(after.body.planChange.seenAt).toBeTruthy();
    expect(after.body.planChange.checklist.find((i: any) => i.key === 'try_theme')?.done).toBe(true);
    expect(after.body.planChange.checklist.find((i: any) => i.key === 'try_story')?.done).toBe(true);
  });

  it('Downgrading Pro → Free records calm downgrade and falls back to Space theme without deleting data', async () => {
    await upgrade(app, biz.businessId, 'free');

    const exp = (await biz.api.get('/experience').expect(200)).body;
    expect(exp.plan.code).toBe('free');
    expect(exp.appearance.theme).toBe('sunrise'); // stored choice kept
    expect(exp.appearance.effectiveTheme).toBe('space'); // falls back cleanly
    expect(exp.appearance.effectiveAvatar).toBe('initials');
    expect(exp.planChange.direction).toBe('down');
    expect(exp.planChange.seenAt).toBeNull();
    expect(exp.planChange.themeReset).toBe(true);
    expect(exp.planChange.pausedAgents).toContain('vox');

    await biz.api.post(`/experience/plan-change/${exp.planChange.id}/seen`, {}).expect(201);
    const after = (await biz.api.get('/experience').expect(200)).body;
    expect(after.planChange).toBeNull(); // downgrade banner disappears once seen
  });

  it('Business plan unlocks brand colour, branches constellation, Success Manager from platform_settings, monthly report, and milestones', async () => {
    await admin.put('/admin/settings/support.success_manager', {
      value: { name: 'Ananya Rao', role: 'Business Success Manager', phone: '+919876543210', whatsapp: '919876543210', email: 'ananya@orbit.example' },
    }).expect(200);

    await upgrade(app, biz.businessId, 'business');

    await asTenant(db, biz.businessId, async () => {
      await db.query(`INSERT INTO locations (name, address) VALUES ('Indiranagar', '100ft Rd'), ('Koramangala', '80ft Rd')`);
      await db.query(`INSERT INTO payments (amount, status, paid_at) VALUES (105000, 'paid', now())`);
    });

    await biz.api.patch('/experience/appearance', { theme: 'brand', brandColor: '#D97706' }).expect(200);

    const exp = (await biz.api.get('/experience').expect(200)).body;
    expect(exp.plan.experience.badge).toBe('metal');
    expect(exp.appearance.effectiveTheme).toBe('brand');
    expect(exp.appearance.effectiveBrandColor).toBe('#D97706');
    expect(exp.locations.map((l: any) => l.name)).toEqual(expect.arrayContaining(['Indiranagar', 'Koramangala']));
    expect(exp.successManager?.name).toBe('Ananya Rao');
    expect(exp.milestones.unseen?.key).toBe('earned_1lakh');

    await biz.api.post(`/experience/milestones/${exp.milestones.unseen.id}/seen`, {}).expect(201);
    const afterM = (await biz.api.get('/experience').expect(200)).body;
    expect(afterM.milestones.unseen).toBeNull();

    const rep = await biz.api.get('/experience/report').expect(200);
    expect(rep.body.revenue).toBeGreaterThanOrEqual(105000);
    expect(rep.body.whiteLabel).toBe(false);
  });

  it('Enterprise plan enables white-label and removes Orbit branding on public website', async () => {
    await upgrade(app, biz.businessId, 'enterprise');
    const exp = (await biz.api.get('/experience').expect(200)).body;
    expect(exp.plan.whiteLabel).toBe(true);

    const pub = await request(app.getHttpServer()).get(`/public/businesses/${biz.slug}`).expect(200);
    expect(pub.body.whiteLabel).toBe(true);
    expect(pub.body.poweredByOrbit).toBe(false);
  });
});
