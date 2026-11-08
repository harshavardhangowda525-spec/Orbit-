import type { NestExpressApplication } from '@nestjs/platform-express';
import { TEMPLATES } from '@orbit/shared';
import { bootApp, signIn, api } from './helpers';

describe('onboarding (all 6 steps)', () => {
  let app: NestExpressApplication;
  beforeAll(async () => (app = await bootApp()));
  afterAll(() => app.close());

  it('lists all 13 business types', async () => {
    const { token } = await signIn(app);
    const r = await api(app, token).get('/onboarding/types').expect(200);
    expect(r.body).toHaveLength(13);
    expect(r.body.map((t: any) => t.type)).toContain('dental_clinic');
  });

  it('a new owner goes from sign-in to live, with autosave and resume after every step', async () => {
    const started = Date.now();
    // Step 1: sign in with phone OTP.
    const owner = await signIn(app);
    const me0 = await api(app, owner.token).get('/auth/me').expect(200);
    expect(me0.body.businesses).toEqual([]);

    // Step 2: choose type -> template loaded.
    const { body } = await api(app, owner.token).post('/onboarding/business', { type: 'gym', language: 'kn' }).expect(201);
    const a = api(app, owner.token, body.businessId);
    let state = (await a.get('/onboarding/state').expect(200)).body;
    expect(state.business.onboardingStep).toBe(3);
    expect(state.business.status).toBe('onboarding');
    expect(state.business.supportedLanguages).toEqual(['en', 'kn']);
    expect(state.services.map((s: any) => s.name)).toEqual(TEMPLATES.gym.services.map((s) => s.name));
    expect(state.profile.hours).toEqual(TEMPLATES.gym.hours);

    // Resume: /auth/me tells the app where the owner left off.
    const me1 = await api(app, owner.token).get('/auth/me').expect(200);
    expect(me1.body.businesses[0]).toMatchObject({ id: body.businessId, onboarding_step: 3, role: 'owner' });

    // Changing type while onboarding swaps the template.
    await a.put('/onboarding/type', { type: 'yoga_studio' }).expect(200);
    state = (await a.get('/onboarding/state').expect(200)).body;
    expect(state.services[0].name).toBe(TEMPLATES.yoga_studio.services[0].name);
    expect(state.business.name).toBe('My Yoga Studio');

    // Step 3: quick import (instagram handle is kept as a link).
    const prev = await a.post('/onboarding/import/preview', { input: '@calmflow.yoga' }).expect(201);
    expect(prev.body).toMatchObject({ source: 'instagram', ok: true, fields: { instagram: 'https://instagram.com/calmflow.yoga' } });
    await a.put('/onboarding/import', { fields: prev.body.fields }).expect(200);
    state = (await a.get('/onboarding/state').expect(200)).body;
    expect(state.business.onboardingStep).toBe(4);
    expect(state.profile.socialLinks.instagram).toBe('https://instagram.com/calmflow.yoga');

    // Step 4: essentials — rename, edit a service, drop one, add one, add staff.
    const services = state.services.map((s: any) => ({ id: s.id, name: s.name, durationMin: s.durationMin, price: s.price }));
    services[1].price = 350;
    services.splice(3, 1);
    services.push({ name: 'Weekend workshop', durationMin: 120, price: 999 });
    await a
      .put('/onboarding/essentials', { name: 'Calm Flow Yoga', phone: '98450 12345', address: 'JP Nagar, Bengaluru', hours: TEMPLATES.yoga_studio.hours, services, staff: [{ name: 'Lata' }] })
      .expect(200);
    state = (await a.get('/onboarding/state').expect(200)).body;
    expect(state.business.name).toBe('Calm Flow Yoga');
    expect(state.business.slug).toMatch(/^calm-flow-yoga/);
    expect(state.profile.phone).toBe('+919845012345');
    expect(state.services.map((s: any) => s.name)).toEqual(['Trial class', 'Drop-in class', 'Monthly membership', 'Weekend workshop']);
    expect(state.services[1].price).toBe(350);
    expect(state.staff.map((s: any) => s.name)).toEqual(['Lata']);
    expect(state.business.onboardingStep).toBe(5);

    // Step 5: calendar.
    await a.put('/onboarding/calendar', { mode: 'google' }).expect(200);
    state = (await a.get('/onboarding/state').expect(200)).body;
    expect(state.business.calendarMode).toBe('google');
    expect(state.powers).toEqual([{ power_type: 'google_calendar', status: 'pending' }]);

    // Step 6: live.
    const live = await a.post('/onboarding/launch').expect(201);
    expect(live.body.business.status).toBe('live');
    expect(live.body.links.publicUrl).toBe(`https://orbit.test/${state.business.slug}`);
    expect(live.body.links.qrSvg).toMatch(/^<svg/);
    expect(live.body.links.widgetCode).toContain(`data-orbit="${state.business.slug}"`);

    state = (await a.get('/onboarding/state').expect(200)).body;
    expect(state.checklist.map((c: any) => c.key)).toEqual(['whatsapp', 'instagram', 'gmail', 'voice', 'payments', 'faqs', 'price_list', 'invite_staff', 'meet_crew']);
    const bridge = (await a.get('/bridge').expect(200)).body;
    expect(bridge.feed[0].sentence.key).toBe('feed.orbit.live');

    // Launching twice is harmless; type can no longer be swapped.
    await a.post('/onboarding/launch').expect(201);
    expect((await a.put('/onboarding/type', { type: 'gym' })).status).toBe(400);

    // The public page works straight away.
    const pub = await api(app, '').get(`/public/businesses/${state.business.slug}`).expect(200);
    expect(pub.body).toMatchObject({ name: 'Calm Flow Yoga', live: true, poweredByOrbit: true });
    expect(pub.body.services).toHaveLength(4);

    // API side of onboarding is far inside the 2-minute budget (UI timing is in the web e2e test).
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('accepts old timezone names that phones still send, and rejects unknown ones safely', async () => {
    const owner = await signIn(app);
    const { body } = await api(app, owner.token).post('/onboarding/business', { type: 'salon', timezone: 'Asia/Calcutta' }).expect(201);
    const a = api(app, owner.token, body.businessId);
    expect((await a.get('/onboarding/state').expect(200)).body.business.timezone).toBe('Asia/Kolkata');
    await a.get('/bridge').expect(200);
    const other = await signIn(app);
    const r = await api(app, other.token).post('/onboarding/business', { type: 'salon', timezone: 'Mars/Olympus' }).expect(201);
    expect((await api(app, other.token, r.body.businessId).get('/onboarding/state')).body.business.timezone).toBe('Asia/Kolkata');
  });

  it('rejects bad input with plain-language messages', async () => {
    const owner = await signIn(app);
    expect((await api(app, owner.token).post('/onboarding/business', { type: 'spaceship' })).body.error.code).toBe('invalid_input');
    const { body } = await api(app, owner.token).post('/onboarding/business', { type: 'salon' }).expect(201);
    const a = api(app, owner.token, body.businessId);
    const bad = await a.put('/onboarding/essentials', { name: 'X Salon', hours: { mon: { open: true, ranges: [{ from: '25:00', to: '10:00' }] } }, services: [{ name: 'Cut', durationMin: 30, price: 100 }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/hours/);
    const noServices = await a.put('/onboarding/essentials', { name: 'X Salon', hours: TEMPLATES.salon.hours, services: [] });
    expect(noServices.status).toBe(400);
    const badPhone = await a.put('/onboarding/essentials', { name: 'X Salon', phone: '123', hours: TEMPLATES.salon.hours, services: [{ name: 'Cut', durationMin: 30, price: 100 }] });
    expect(badPhone.body.error.code).toBe('invalid_phone');
  });

  it('staff members cannot launch or change the business type', async () => {
    const owner = await signIn(app);
    const { body } = await api(app, owner.token).post('/onboarding/business', { type: 'salon' }).expect(201);
    const staffUser = await signIn(app);
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    await c.query(`INSERT INTO memberships (user_id, business_id, role) VALUES ($1, $2, 'staff')`, [staffUser.userId, body.businessId]);
    await c.end();
    const s = api(app, staffUser.token, body.businessId);
    expect((await s.get('/onboarding/state')).status).toBe(200);
    expect((await s.post('/onboarding/launch')).status).toBe(403);
    expect((await s.put('/onboarding/type', { type: 'spa' })).status).toBe(403);
    expect((await s.post('/bridge/commands', { text: 'hi' })).status).toBe(403);
  });
});
