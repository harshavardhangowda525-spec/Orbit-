import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { toE164 } from '@orbit/shared';
import { auth } from '../config';
import { DbService } from '../db/db.service';
import { AppError, badRequest } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { checkPassword, hashPassword, PASSWORD_MAX, PASSWORD_MIN } from './password';
import { GOOGLE_VERIFIER, type GoogleVerifier } from './google';
import type { JwtPayload } from './types';
import type { SupabaseClaims } from './supabase';

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 254;

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    @Inject(GOOGLE_VERIFIER) private readonly google: GoogleVerifier,
  ) {}

  private normEmail(raw: string) {
    const email = raw.trim().toLowerCase();
    if (!isEmail(email)) throw badRequest('invalid_email', 'That email address does not look right. Please check it.');
    return email;
  }

  private checkLength(password: string) {
    if (password.length < PASSWORD_MIN) throw badRequest('password_short', `Your password needs at least ${PASSWORD_MIN} characters.`);
    if (password.length > PASSWORD_MAX) throw badRequest('password_long', `Your password can have at most ${PASSWORD_MAX} characters.`);
  }

  /** Orbit's own sign-up (local development; hosted sites use Supabase Auth). */
  async signUp(rawEmail: string, password: string, ip?: string) {
    const email = this.normEmail(rawEmail);
    this.checkLength(password);
    const exists = await this.db.one(`SELECT 1 FROM users WHERE email = $1`, [email]);
    if (exists) throw new AppError(409, 'account_exists', 'An account with this email already exists. Please log in.');
    const user = await this.db.one(
      `INSERT INTO users (email, password_hash, auth_providers, is_platform_admin, last_login_at) VALUES ($1, $2, '[{"provider":"password"}]', $3, now()) RETURNING *`,
      [email, await hashPassword(password), auth.adminEmails.includes(email)],
    );
    await this.audit.write({ actorId: user.id, action: 'auth.sign_up', entity: 'user', entityId: user.id, after: { method: 'password' }, ip });
    return { token: this.issue({ sub: user.id }), user: publicUser(user), isNew: true };
  }

  async logIn(rawEmail: string, password: string, ip?: string) {
    const email = this.normEmail(rawEmail);
    const row = await this.db.one<{ id: string; password_hash: string | null }>(`SELECT id, password_hash FROM users WHERE email = $1`, [email]);
    if (!(await checkPassword(password, row?.password_hash))) {
      throw new AppError(401, 'wrong_password', 'That email and password do not match. Please try again.');
    }
    const user = await this.db.one(`UPDATE users SET last_login_at = now(), is_platform_admin = is_platform_admin OR $2 WHERE id = $1 RETURNING *`, [row!.id, auth.adminEmails.includes(email)]);
    await this.audit.write({ actorId: user.id, action: 'auth.sign_in', entity: 'user', entityId: user.id, after: { method: 'password' }, ip });
    return { token: this.issue({ sub: user.id }), user: publicUser(user), isNew: false };
  }

  async signInWithGoogle(idToken: string, ip?: string) {
    const g = await this.google.verify(idToken);
    let user = await this.db.one(`SELECT * FROM users WHERE google_sub = $1 OR email = $2 ORDER BY (google_sub = $1) DESC LIMIT 1`, [g.sub, g.email]);
    const isNew = !user;
    if (user) {
      user = await this.db.one(
        `UPDATE users SET google_sub = $2, last_login_at = now(), name = COALESCE(name, $3),
           auth_providers = CASE WHEN auth_providers @> '[{"provider":"google"}]' THEN auth_providers
                                 ELSE auth_providers || '[{"provider":"google"}]' END
         WHERE id = $1 RETURNING *`,
        [user.id, g.sub, g.name ?? null],
      );
    } else {
      user = await this.db.one(
        `INSERT INTO users (email, name, google_sub, auth_providers, last_login_at)
         VALUES ($1, $2, $3, '[{"provider":"google"}]', now()) RETURNING *`,
        [g.email, g.name ?? null, g.sub],
      );
    }
    await this.audit.write({ actorId: user.id, action: 'auth.sign_in', entity: 'user', entityId: user.id, after: { method: 'google' }, ip });
    return { token: this.issue({ sub: user.id }), user: publicUser(user), isNew };
  }

  /**
   * The Orbit user for a Supabase Auth user. Links by Supabase id, then by phone or
   * email (so people who already exist, e.g. seeded owners, keep their businesses),
   * otherwise creates the user.
   */
  async userForSupabase(c: SupabaseClaims): Promise<string> {
    const linked = await this.db.one<{ id: string }>(`SELECT id FROM users WHERE supabase_uid = $1`, [c.sub]);
    if (linked) return linked.id;
    const phone = c.phone ? toE164(c.phone.startsWith('+') ? c.phone : `+${c.phone}`) : null;
    // Taking over an existing Orbit account (its businesses, admin rights) needs proof of owning that inbox or number.
    const taken = await this.db.one(
      `SELECT 1 FROM users WHERE supabase_uid IS NULL AND (($1::text IS NOT NULL AND phone = $1) OR ($2::text IS NOT NULL AND email = $2))`,
      [phone, c.email],
    );
    if (taken && !c.verified) throw new AppError(403, 'email_not_verified', 'Please confirm your email first. Check your inbox for the link.');
    const isAdmin = !!c.email && c.verified && auth.adminEmails.includes(c.email);
    const existing = await this.db.one<{ id: string }>(
      `SELECT id FROM users WHERE supabase_uid IS NULL AND (($1::text IS NOT NULL AND phone = $1) OR ($2::text IS NOT NULL AND email = $2)) ORDER BY (phone = $1) DESC NULLS LAST LIMIT 1`,
      [phone, c.email],
    );
    const user = existing
      ? await this.db.one(
          `UPDATE users SET supabase_uid = $2, phone = COALESCE(phone, $3), email = COALESCE(email, $4), name = COALESCE(name, $5),
             is_platform_admin = is_platform_admin OR $6, last_login_at = now(),
             auth_providers = CASE WHEN auth_providers @> '[{"provider":"supabase"}]' THEN auth_providers ELSE auth_providers || '[{"provider":"supabase"}]' END
           WHERE id = $1 RETURNING id`,
          [existing.id, c.sub, phone, c.email, c.name, isAdmin],
        )
      : await this.db.one(
          `INSERT INTO users (supabase_uid, phone, email, name, is_platform_admin, auth_providers, last_login_at)
           VALUES ($1, $2, $3, $4, $5, '[{"provider":"supabase"}]', now())
           ON CONFLICT (supabase_uid) DO UPDATE SET last_login_at = now() RETURNING id`,
          [c.sub, phone, c.email, c.name, isAdmin],
        );
    await this.audit.write({ actorId: user!.id, action: 'auth.sign_in', entity: 'user', entityId: user!.id, after: { method: 'supabase', linked: !!existing } });
    return user!.id;
  }

  issue(payload: JwtPayload, expiresIn: string | number = '30d') {
    return this.jwt.sign(payload, { expiresIn: expiresIn as any });
  }

  async me(userId: string) {
    const user = await this.db.one(`SELECT * FROM users WHERE id = $1`, [userId]);
    if (!user) throw new AppError(401, 'unauthorized', 'Please sign in again.');
    const businesses = await this.db.q(
      `SELECT b.id, b.name, b.slug, b.type, b.status, b.onboarding_step, b.default_language, m.role
       FROM memberships m JOIN businesses b ON b.id = m.business_id
       WHERE m.user_id = $1 AND m.status = 'active' ORDER BY m.created_at`,
      [userId],
    );
    return { user: publicUser(user), businesses };
  }

  async updateMe(userId: string, patch: { name?: string; language?: string }) {
    const user = await this.db.one(
      `UPDATE users SET name = COALESCE($2, name), language = COALESCE($3, language) WHERE id = $1 RETURNING *`,
      [userId, patch.name ?? null, patch.language ?? null],
    );
    return publicUser(user);
  }
}

export function publicUser(u: any) {
  return { id: u.id, phone: u.phone, email: u.email, name: u.name, language: u.language, isPlatformAdmin: u.is_platform_admin };
}
