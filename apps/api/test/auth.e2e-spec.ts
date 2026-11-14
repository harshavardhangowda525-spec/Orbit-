import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { bootApp, newEmail, signIn, api, SEED, SEED_PASSWORD } from './helpers';
import { DbService } from '../src/db/db.service';
import { seed } from '../src/scripts/seed';

describe('sign-in', () => {
  let app: NestExpressApplication;
  beforeAll(async () => (app = await bootApp()));
  afterAll(() => app.close());
  const http = () => request(app.getHttpServer());

  it('signs up with email + password, then logs in; addresses are case-insensitive', async () => {
    const email = newEmail();
    const r1 = await http().post('/auth/signup').send({ email: `  ${email.toUpperCase()} `, password: 'long-enough-pw' }).expect(201);
    expect(r1.body.isNew).toBe(true);
    expect(r1.body.user.email).toBe(email);
    const r2 = await http().post('/auth/login').send({ email: email.toUpperCase(), password: 'long-enough-pw' }).expect(201);
    expect(r2.body.user.id).toBe(r1.body.user.id);
    await api(app, r2.body.token).get('/auth/me').expect(200);
    // The password is stored as a salted scrypt hash, never as text.
    const row = await (app as any).get(DbService).one(`SELECT password_hash FROM users WHERE email = $1`, [email]);
    expect(row.password_hash).toMatch(/^scrypt\$/);
    expect(row.password_hash).not.toContain('long-enough-pw');
  });

  it('rejects a wrong password and an unknown email with the same message', async () => {
    const { email } = await signIn(app);
    const wrong = await http().post('/auth/login').send({ email, password: 'not-the-password' });
    const unknown = await http().post('/auth/login').send({ email: newEmail(), password: 'not-the-password' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error).toEqual(unknown.body.error);
    expect(wrong.body.error.message).toBe('That email and password do not match. Please try again.');
  });

  it('will not sign up the same email twice, or with a short password', async () => {
    const { email } = await signIn(app);
    const dup = await http().post('/auth/signup').send({ email, password: 'another-password' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('account_exists');
    const short = await http().post('/auth/signup').send({ email: newEmail(), password: 'short' });
    expect(short.body.error.code).toBe('password_short');
  });

  it('rejects invalid addresses in plain language; code sign-in no longer exists', async () => {
    const r = await http().post('/auth/signup').send({ email: 'not-an-email', password: 'long-enough-pw' });
    expect(r.status).toBe(400);
    expect(r.body.error).toEqual({ code: 'invalid_email', message: 'That email address does not look right. Please check it.' });
    expect((await http().post('/auth/email/request').send({ email: newEmail() })).status).toBe(404);
    expect((await http().post('/auth/otp/request').send({ phone: '9845012345' })).status).toBe(404);
  });

  it('lets seeded sample owners log in with the seed password', async () => {
    await seed(process.env.DATABASE_MIGRATION_URL);
    const r = await http().post('/auth/login').send({ email: SEED.salon, password: SEED_PASSWORD }).expect(201);
    expect(r.body.user.email).toBe(SEED.salon);
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
    expect(plans.map((p: any) => p.code).slice(0, 5)).toEqual(['free', 'plus', 'pro', 'business', 'enterprise']);
    const base = plans[1];
    await a.put('/admin/plans/plus', { ...base, prices: { INR: 2499, USD: 49 } }).expect(200);
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
    await a.put('/admin/plans/plus', base).expect(200);
    await app.get(DbService).adminTx((tx: any) => tx.q(`UPDATE plans SET updated_by = NULL WHERE code = 'plus'`));
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
