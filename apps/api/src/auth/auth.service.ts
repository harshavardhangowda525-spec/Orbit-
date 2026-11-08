import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { toE164 } from '@orbit/shared';
import { config } from '../config';
import { DbService } from '../db/db.service';
import { AppError, badRequest } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { SMS_SENDER, type SmsSender } from './sms';
import { GOOGLE_VERIFIER, type GoogleVerifier } from './google';
import type { JwtPayload } from './types';

const OTP_TTL_MIN = 5;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_HOUR = 5;

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    @Inject(GOOGLE_VERIFIER) private readonly google: GoogleVerifier,
  ) {}

  private hash(phone: string, code: string) {
    return createHmac('sha256', config.jwtSecret).update(`${phone}:${code}`).digest('hex');
  }

  async requestOtp(rawPhone: string) {
    const phone = toE164(rawPhone);
    if (!phone) throw badRequest('invalid_phone', 'That phone number does not look right. Please check it.');
    const recent = await this.db.one<{ n: string }>(
      `SELECT count(*) AS n FROM otp_codes WHERE phone = $1 AND created_at > now() - interval '1 hour'`,
      [phone],
    );
    if (Number(recent?.n ?? 0) >= OTP_MAX_PER_HOUR) {
      throw new AppError(429, 'too_many_requests', 'Too many codes asked for this number. Please try again in an hour.');
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.db.q(
      `INSERT INTO otp_codes (phone, code_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))`,
      [phone, this.hash(phone, code), OTP_TTL_MIN],
    );
    await this.sms.sendOtp(phone, code);
    return { phone, expiresInSec: OTP_TTL_MIN * 60, ...(config.otpDevEcho ? { devCode: code } : {}) };
  }

  async verifyOtp(rawPhone: string, code: string, ip?: string) {
    const phone = toE164(rawPhone);
    if (!phone) throw badRequest('invalid_phone', 'That phone number does not look right. Please check it.');
    const row = await this.db.one<{ id: string; code_hash: string; attempts: number }>(
      `SELECT id, code_hash, attempts FROM otp_codes
       WHERE phone = $1 AND consumed_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [phone],
    );
    const wrong = badRequest('otp_wrong', 'That code is not right or has expired. Please try again.');
    if (!row || row.attempts >= OTP_MAX_ATTEMPTS) throw wrong;
    const a = Buffer.from(row.code_hash, 'hex');
    const b = Buffer.from(this.hash(phone, code.trim()), 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      await this.db.q(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
      throw wrong;
    }
    await this.db.q(`UPDATE otp_codes SET consumed_at = now() WHERE id = $1`, [row.id]);

    const isAdmin = config.platformAdminPhones.includes(phone);
    const existing = await this.db.one<{ id: string }>(`SELECT id FROM users WHERE phone = $1`, [phone]);
    const user = existing
      ? await this.db.one(
          `UPDATE users SET last_login_at = now(), is_platform_admin = is_platform_admin OR $2 WHERE id = $1 RETURNING *`,
          [existing.id, isAdmin],
        )
      : await this.db.one(
          `INSERT INTO users (phone, auth_providers, is_platform_admin, last_login_at)
           VALUES ($1, '[{"provider":"phone"}]', $2, now()) RETURNING *`,
          [phone, isAdmin],
        );
    await this.audit.write({ actorId: user.id, action: 'auth.sign_in', entity: 'user', entityId: user.id, after: { method: 'otp' }, ip });
    return { token: this.issue({ sub: user.id }), user: publicUser(user), isNew: !existing };
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
