import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.factory';
import { GOOGLE_VERIFIER } from '../src/auth/google';
import { logger } from '../src/logger';
import { TEMPLATES, type BusinessType } from '@orbit/shared';

export async function bootApp() {
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GOOGLE_VERIFIER)
    .useValue({ verify: async (t: string) => ({ sub: `sub-${t}`, email: `${t}@example.com`, name: 'Google User' }) })
    .compile();
  const app = mod.createNestApplication<NestExpressApplication>({ logger, bodyParser: false });
  configureApp(app);
  await app.init();
  return app;
}

let emailSeq = 0;
/** A fresh email address per call, unique per test run. */
export function newEmail() {
  emailSeq++;
  return `owner${Date.now().toString(36)}${emailSeq}@example.com`;
}

/** Demo accounts created by the seed. */
export const SEED = { salon: 'meera@glowstudio.example', gym: 'suresh@ironcore.example', admin: 'admin@orbit.test' };

export async function signIn(app: NestExpressApplication, email = newEmail()) {
  const r1 = await request(app.getHttpServer()).post('/auth/email/request').send({ email }).expect(201);
  const r2 = await request(app.getHttpServer()).post('/auth/email/verify').send({ email, code: r1.body.devCode }).expect(201);
  return { token: r2.body.token as string, userId: r2.body.user.id as string, email };
}

export function api(app: NestExpressApplication, token: string, businessId?: string) {
  const s = app.getHttpServer();
  const h = (r: request.Test) => {
    r.set('authorization', `Bearer ${token}`);
    if (businessId) r.set('x-business-id', businessId);
    return r;
  };
  return {
    get: (u: string) => h(request(s).get(u)),
    post: (u: string, b: object = {}) => h(request(s).post(u)).send(b),
    put: (u: string, b: object = {}) => h(request(s).put(u)).send(b),
    patch: (u: string, b: object = {}) => h(request(s).patch(u)).send(b),
    delete: (u: string) => h(request(s).delete(u)),
  };
}

/** Run the whole onboarding flow through the API, as a real owner would. */
export async function onboard(app: NestExpressApplication, type: BusinessType, name: string) {
  const owner = await signIn(app);
  const created = await api(app, owner.token).post('/onboarding/business', { type, language: 'en' }).expect(201);
  const businessId = created.body.businessId as string;
  const a = api(app, owner.token, businessId);
  await a.put('/onboarding/import', { fields: null }).expect(200);
  const state = await a.get('/onboarding/state').expect(200);
  await a
    .put('/onboarding/essentials', {
      name,
      phone: '9845012345',
      hours: TEMPLATES[type].hours,
      services: state.body.services.map((s: any) => ({ id: s.id, name: s.name, durationMin: s.durationMin, price: s.price })),
      staff: [{ name: 'Asha' }],
    })
    .expect(200);
  await a.put('/onboarding/calendar', { mode: 'builtin' }).expect(200);
  const launched = await a.post('/onboarding/launch').expect(201);
  return { owner, businessId, slug: launched.body.business.slug as string, api: a };
}

/** Direct DB access as the APP role (RLS applies), for proving isolation below the API. */
export async function appDb() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  return c;
}

export async function asTenant<T>(c: Client, businessId: string, fn: () => Promise<T>): Promise<T> {
  await c.query('BEGIN');
  try {
    await c.query(`SELECT set_config('app.business_id', $1, true)`, [businessId]);
    const r = await fn();
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  }
}
