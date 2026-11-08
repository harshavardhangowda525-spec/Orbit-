import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { bootApp, newEmail, signIn, api, SEED } from './helpers';

describe('sign-in', () => {
  let app: NestExpressApplication;
  beforeAll(async () => (app = await bootApp()));
  afterAll(() => app.close());
  const http = () => request(app.getHttpServer());

  it('signs in with an emailed 6-digit code; addresses are case-insensitive', async () => {
    const email = newEmail();
    const r1 = await http().post('/auth/email/request').send({ email: `  ${email.toUpperCase()} ` }).expect(201);
    expect(r1.body.email).toBe(email);
    expect(r1.body.devCode).toMatch(/^\d{6}$/);
    const r2 = await http().post('/auth/email/verify').send({ email, code: r1.body.devCode }).expect(201);
    expect(r2.body.isNew).toBe(true);
    expect(r2.body.user.email).toBe(email);
    // A code works once.
    expect((await http().post('/auth/email/verify').send({ email, code: r1.body.devCode })).status).toBe(400);
    // Signing in again finds the same person.
    const again = await signIn(app, email);
    expect(again.userId).toBe(r2.body.user.id);
  });

  it('rejects wrong codes and locks the code after 5 tries', async () => {
    const email = newEmail();
    const r1 = await http().post('/auth/email/request').send({ email }).expect(201);
    const wrong = r1.body.devCode === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const r = await http().post('/auth/email/verify').send({ email, code: wrong });
      expect(r.body.error.code).toBe('otp_wrong');
    }
    expect((await http().post('/auth/email/verify').send({ email, code: r1.body.devCode })).body.error.code).toBe('otp_wrong');
  });

  it('limits how many codes one address can ask for', async () => {
    const email = newEmail();
    for (let i = 0; i < 5; i++) await http().post('/auth/email/request').send({ email }).expect(201);
    expect((await http().post('/auth/email/request').send({ email })).status).toBe(429);
  });

  it('rejects invalid addresses in plain language, and SMS sign-in no longer exists', async () => {
    const r = await http().post('/auth/email/request').send({ email: 'not-an-email' });
    expect(r.status).toBe(400);
    expect(r.body.error).toEqual({ code: 'invalid_email', message: 'That email address does not look right. Please check it.' });
    expect((await http().post('/auth/otp/request').send({ phone: '9845012345' })).status).toBe(404);
  });

  it('signs in with Google and links to the same account next time', async () => {
    const r1 = await http().post('/auth/google').send({ idToken: 'tok-asha-123' }).expect(201);
    expect(r1.body.isNew).toBe(true);
    const r2 = await http().post('/auth/google').send({ idToken: 'tok-asha-123' }).expect(201);
    expect(r2.body.isNew).toBe(false);
    expect(r2.body.user.id).toBe(r1.body.user.id);
  });

  it('rejects missing and forged tokens', async () => {
    expect((await http().get('/auth/me')).status).toBe(401);
    expect((await http().get('/auth/me').set('authorization', 'Bearer abc.def.ghi')).status).toBe(401);
  });

  it('updates the owner language', async () => {
    const { token } = await signIn(app);
    const r = await api(app, token).patch('/auth/me', { language: 'hi', name: 'Asha' }).expect(200);
    expect(r.body).toMatchObject({ language: 'hi', name: 'Asha' });
    expect((await api(app, token).patch('/auth/me', { language: 'xx' })).status).toBe(400);
  });
});

describe('admin panel', () => {
  let app: NestExpressApplication;
  beforeAll(async () => (app = await bootApp()));
  afterAll(() => app.close());

  it('is closed to non-admins', async () => {
    const { token } = await signIn(app);
    for (const r of ['/admin/businesses', '/admin/plans', '/admin/templates', '/admin/health']) {
      expect((await api(app, token).get(r)).status).toBe(403);
    }
  });

  it('lists businesses, edits plans and templates, and audits every change', async () => {
    const admin = await signIn(app, SEED.admin);
    const a = api(app, admin.token);
    expect((await a.get('/admin/health').expect(200)).body.ok).toBe(true);
    expect(Array.isArray((await a.get('/admin/businesses').expect(200)).body)).toBe(true);
    const plans = (await a.get('/admin/plans').expect(200)).body;
    expect(plans.map((p: any) => p.code)).toEqual(['free', 'base', 'business']);
    const base = plans[1];
    await a.put('/admin/plans/base', { ...base, prices: { INR: 2499, USD: 49 } }).expect(200);
    expect((await a.get('/admin/plans').expect(200)).body[1].prices.INR).toBe(2499);
    const tpl = (await a.get('/admin/templates').expect(200)).body.find((t: any) => t.type === 'salon');
    const r = await a.put('/admin/templates/salon', { content: { ...tpl.content, defaultName: 'My Beauty Salon' } }).expect(200);
    expect(r.body.version).toBe(tpl.version + 1);
    const audit = (await a.get('/admin/audit').expect(200)).body.map((e: any) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['admin.plan.update', 'admin.template.update']));
    // New salons now use the edited template — no code change.
    const owner = await signIn(app);
    const { body } = await api(app, owner.token).post('/onboarding/business', { type: 'salon' }).expect(201);
    expect((await api(app, owner.token, body.businessId).get('/onboarding/state')).body.business.name).toBe('My Beauty Salon');
    // Put it back for other tests.
    await a.put('/admin/templates/salon', { content: tpl.content }).expect(200);
    await a.put('/admin/plans/base', base).expect(200);
  });

  it('can suspend a business, which locks its owner out', async () => {
    const admin = await signIn(app, SEED.admin);
    const owner = await signIn(app);
    const { body } = await api(app, owner.token).post('/onboarding/business', { type: 'repair' }).expect(201);
    await api(app, admin.token).patch(`/admin/businesses/${body.businessId}`, { status: 'suspended' }).expect(200);
    expect((await api(app, owner.token, body.businessId).get('/bridge')).status).toBe(403);
    await api(app, admin.token).patch(`/admin/businesses/${body.businessId}`, { status: 'onboarding', planCode: 'business' }).expect(200);
    expect((await api(app, owner.token, body.businessId).get('/bridge')).status).toBe(200);
  });
});
