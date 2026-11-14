import { DbService } from '../src/db/db.service';
import { codeAt, stepAt } from '../src/admin/totp';
/**
 * Supabase Auth sign-in: the API accepts access tokens issued by this project's
 * Supabase Auth (verified against its JWKS, or the legacy HS256 secret), links
 * them to Orbit users, and rejects anything else.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { createServer, type Server } from 'node:http';
import { bootApp, onboard, api } from './helpers';

const URL_ = 'https://testref.supabase.co';

describe('sign-in with Supabase Auth', () => {
  let app: NestExpressApplication;
  let priv: CryptoKey;
  let jwksServer: Server;
  const http = () => request(app.getHttpServer());

  async function token(claims: Record<string, unknown>, opts: { iss?: string; aud?: string; exp?: string; key?: CryptoKey; alg?: string } = {}) {
    return new SignJWT({ role: 'authenticated', ...claims })
      .setProtectedHeader({ alg: opts.alg ?? 'ES256', kid: 'k1' })
      .setIssuer(opts.iss ?? `${URL_}/auth/v1`)
      .setAudience(opts.aud ?? 'authenticated')
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? '1h')
      .sign(opts.key ?? priv);
  }

  beforeAll(async () => {
    const kp = await generateKeyPair('ES256');
    priv = kp.privateKey as CryptoKey;
    const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
    // Stand-in for https://<ref>.supabase.co/auth/v1/.well-known/jwks.json
    jwksServer = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((r) => jwksServer.listen(0, '127.0.0.1', () => r()));
    process.env.SUPABASE_JWKS_URL = `http://127.0.0.1:${(jwksServer.address() as any).port}/jwks.json`;
    app = await bootApp();
  });
  afterAll(async () => {
    process.env.AUTH_PROVIDER = 'orbit';
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_JWT_SECRET;
    delete process.env.SUPABASE_JWKS_URL;
    jwksServer.close();
    await app.close();
  });

  it('links an existing owner by a confirmed email, keeping their businesses', async () => {
    const owned = await onboard(app, 'salon', 'Supa Salon'); // signs up with Orbit's own sign-in (still on)
    process.env.AUTH_PROVIDER = 'supabase';
    process.env.SUPABASE_URL = URL_;
    // Not confirmed yet: no access to the existing account, and a plain-language reason.
    const unconfirmed = await token({ sub: '00000000-0000-4000-8000-000000000009', email: owned.owner.email, user_metadata: { email_verified: false }, amr: [{ method: 'password' }] });
    const denied = await http().get('/auth/me').set('authorization', `Bearer ${unconfirmed}`);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('email_not_verified');
    const t = await token({ sub: '00000000-0000-4000-8000-000000000001', email: owned.owner.email.toUpperCase(), phone: '', user_metadata: { email_verified: true } });
    const me = await http().get('/auth/me').set('authorization', `Bearer ${t}`).expect(200);
    expect(me.body.user.id).toBe(owned.owner.userId);
    expect(me.body.businesses.map((b: any) => b.id)).toContain(owned.businessId);
    await api(app, t, owned.businessId).get('/bridge').expect(200);
  });

  it('creates a new Orbit user for a new Supabase user (Google sign-in with email)', async () => {
    const t = await token({ sub: '00000000-0000-4000-8000-000000000002', email: 'New.Owner@Example.com', phone: '', user_metadata: { full_name: 'Asha Rao' } });
    const me = await http().get('/auth/me').set('authorization', `Bearer ${t}`).expect(200);
    expect(me.body.user).toMatchObject({ email: 'new.owner@example.com', name: 'Asha Rao' });
    expect(me.body.businesses).toEqual([]);
    const again = await http().get('/auth/me').set('authorization', `Bearer ${t}`).expect(200);
    expect(again.body.user.id).toBe(me.body.user.id);
  });

  it('rejects tokens from another project, wrong audience, expired, or signed by someone else', async () => {
    const other = (await generateKeyPair('ES256')).privateKey as CryptoKey;
    const bad = [
      await token({ sub: '00000000-0000-4000-8000-000000000003', email: 'x@y.z' }, { iss: 'https://evil.supabase.co/auth/v1' }),
      await token({ sub: '00000000-0000-4000-8000-000000000003', email: 'x@y.z' }, { aud: 'anon' }),
      await token({ sub: '00000000-0000-4000-8000-000000000003', email: 'x@y.z' }, { exp: '-1m' }),
      await token({ sub: '00000000-0000-4000-8000-000000000003', email: 'x@y.z' }, { key: other }),
      await token({ sub: '00000000-0000-4000-8000-000000000003', email: 'x@y.z', role: 'anon' }),
    ];
    for (const t of bad) expect((await http().get('/auth/me').set('authorization', `Bearer ${t}`)).status).toBe(401);
  });

  it('supports projects on the legacy shared secret (HS256)', async () => {
    process.env.SUPABASE_JWT_SECRET = 'legacy-secret-for-tests-only-0123456789';
    const t = await token({ sub: '00000000-0000-4000-8000-000000000004', email: 'legacy@example.com' }, { alg: 'HS256', key: new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET) as any });
    await http().get('/auth/me').set('authorization', `Bearer ${t}`).expect(200);
    const forged = await token({ sub: '00000000-0000-4000-8000-000000000005', email: 'f@example.com' }, { alg: 'HS256', key: new TextEncoder().encode('wrong-secret-wrong-secret-wrong') as any });
    expect((await http().get('/auth/me').set('authorization', `Bearer ${forged}`)).status).toBe(401);
  });

  it('treats Google and email-link sign-ins as proof of the email', async () => {
    process.env.AUTH_PROVIDER = 'orbit'; // create the owner with Orbit's own sign-in, then switch back
    const owned = await onboard(app, 'gym', 'Supa Gym');
    process.env.AUTH_PROVIDER = 'supabase';
    const t = await token({ sub: '00000000-0000-4000-8000-000000000010', email: owned.owner.email, amr: [{ method: 'oauth' }] });
    expect((await http().get('/auth/me').set('authorization', `Bearer ${t}`).expect(200)).body.user.id).toBe(owned.owner.userId);
  });

  it("turns Orbit's own sign-in off, while admin impersonation tokens keep working", async () => {
    expect((await http().post('/auth/login').send({ email: 'someone@example.com', password: 'whatever-123' })).status).toBe(404);
    expect((await http().post('/auth/signup').send({ email: 'someone@example.com', password: 'whatever-123' })).status).toBe(404);
    expect((await http().post('/auth/google').send({ idToken: 'abcdefghijk' })).status).toBe(404);
    const admin = await token({ sub: '00000000-0000-4000-8000-000000000006', email: 'admin@orbit.test', user_metadata: { email_verified: true } });
    // The admin centre also needs the authenticator code (set up on first use).
    await http().get('/admin/businesses').set('authorization', `Bearer ${admin}`).expect(401);
    const me = (await http().get('/auth/me').set('authorization', `Bearer ${admin}`).expect(200)).body.user.id;
    await app.get(DbService).adminTx((tx: any) => tx.q(`UPDATE admin_users SET totp_secret = NULL, totp_enabled_at = NULL, last_totp_step = NULL WHERE user_id = $1`, [me]));
    const start = await http().post('/admin-auth/start').set('authorization', `Bearer ${admin}`).send({}).expect(201);
    const v = await http().post('/admin-auth/verify').set('authorization', `Bearer ${admin}`).send({ code: codeAt(start.body.secret, stepAt()) }).expect(201);
    const owned = await http().get('/admin/businesses').set('authorization', `Bearer ${admin}`).set('x-admin-session', v.body.token).expect(200);
    const imp = await http().post(`/admin/businesses/${owned.body[0].id}/impersonate`).set('authorization', `Bearer ${admin}`).set('x-admin-session', v.body.token).expect(201);
    await api(app, imp.body.token, owned.body[0].id).get('/bridge').expect(200);
  });
});
