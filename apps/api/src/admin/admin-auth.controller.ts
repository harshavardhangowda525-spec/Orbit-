import QRCode from 'qrcode';
import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { AuthService } from '../auth/auth.service';
import { AuditService } from '../audit/audit.service';
import { AdminGuard, AdminRoles, ClientIp, CurrentAdmin, CurrentUser } from '../auth/guards';
import type { AdminSession, AuthUser } from '../auth/types';
import { ZodPipe } from '../common/zod.pipe';
import { AppError, badRequest, forbidden, notFound } from '../common/errors';
import { open, seal } from '../powers/crypto';
import { matchStep, newSecret, otpauthUrl } from './totp';

const SESSION_HOURS = 8;
const Verify = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app.') });
const ROLE = z.enum(['owner', 'finance', 'support', 'viewer']);
const TeamAdd = z.object({ email: z.string().trim().toLowerCase().email(), role: ROLE });
const TeamPatch = z.object({ role: ROLE.optional(), status: z.enum(['active', 'disabled']).optional() });

/**
 * Opening the admin centre: signed in as usual, then a 6-digit authenticator code
 * (set up with a QR code the first time). Platform admins from PLATFORM_ADMIN_EMAILS
 * start as Owners; Owners add the rest of the team with a role.
 */
@Controller('admin-auth')
export class AdminAuthController {
  constructor(private readonly db: DbService, private readonly auth: AuthService, private readonly audit: AuditService) {}

  private async member(userId: string) {
    return this.db.adminTx(async (tx) => {
      let a = await tx.one(`SELECT * FROM admin_users WHERE user_id = $1`, [userId]);
      if (!a) {
        // Bootstrap: platform admins named in PLATFORM_ADMIN_EMAILS are Owners.
        const u = await tx.one(`SELECT is_platform_admin FROM users WHERE id = $1`, [userId]);
        if (!u?.is_platform_admin) return null;
        a = await tx.one(`INSERT INTO admin_users (user_id, role) VALUES ($1, 'owner') ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id RETURNING *`, [userId]);
      }
      return a.status === 'active' ? a : null;
    });
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('start')
  async start(@CurrentUser() u: AuthUser) {
    if (u.impersonation) throw forbidden();
    const a = await this.member(u.id);
    if (!a) throw forbidden('This account is not on the Orbit admin team.');
    if (a.totp_enabled_at) return { setup: false, role: a.role };
    // First time: a new secret to add to an authenticator app (shown until the first code is confirmed).
    let secret = open<{ secret: string }>(a.totp_secret)?.secret;
    if (!secret) {
      // Only the first request creates the secret; a second one at the same moment gets that same secret.
      const fresh = newSecret();
      const won = await this.db.adminTx((tx) => tx.one(`UPDATE admin_users SET totp_secret = $2 WHERE user_id = $1 AND totp_secret IS NULL RETURNING user_id`, [u.id, seal({ secret: fresh })]));
      secret = won ? fresh : open<{ secret: string }>((await this.db.adminTx((tx) => tx.one(`SELECT totp_secret FROM admin_users WHERE user_id = $1`, [u.id])))?.totp_secret)?.secret;
      if (!secret) throw badRequest('setup_failed', 'Please reload and try again.');
    }
    const user = await this.db.one(`SELECT email, phone FROM users WHERE id = $1`, [u.id]);
    const url = otpauthUrl(secret, String(user?.email ?? user?.phone ?? 'admin'));
    // A QR code to scan with Google Authenticator, Microsoft Authenticator, 1Password, etc.
    const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { setup: true, role: a.role, secret, otpauthUrl: url, qrSvg };
  }

  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @Post('verify')
  async verify(@CurrentUser() u: AuthUser, @Body(new ZodPipe(Verify)) b: z.infer<typeof Verify>, @ClientIp() ip: string) {
    if (u.impersonation) throw forbidden();
    const a = await this.member(u.id);
    if (!a) throw forbidden('This account is not on the Orbit admin team.');
    const secret = open<{ secret: string }>(a.totp_secret)?.secret;
    if (!secret) throw badRequest('setup_needed', 'Set up your authenticator app first.');
    const step = matchStep(secret, b.code);
    if (step === null || (a.last_totp_step != null && step <= Number(a.last_totp_step))) {
      await this.audit.write({ actorId: u.id, actorKind: 'admin', action: 'admin.login_failed', ip });
      throw new AppError(401, 'bad_code', 'That code is not right. Check the time on your phone and try the newest code.');
    }
    await this.db.adminTx((tx) => tx.q(`UPDATE admin_users SET last_totp_step = $2, totp_enabled_at = COALESCE(totp_enabled_at, now()) WHERE user_id = $1`, [u.id, step]));
    await this.audit.write({ actorId: u.id, actorKind: 'admin', action: a.totp_enabled_at ? 'admin.login' : 'admin.2fa_enabled', ip });
    return { token: this.auth.issue({ sub: u.id, adm: { role: a.role } }, `${SESSION_HOURS}h`), role: a.role, expiresInSec: SESSION_HOURS * 3600 };
  }
}

/** The admin team: Owners add people by email with a role, change roles, disable access, reset 2FA. */
@UseGuards(AdminGuard)
@Controller('admin/team')
export class AdminTeamController {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  @Get('me')
  me(@CurrentAdmin() a: AdminSession) {
    return a;
  }

  @AdminRoles('owner')
  @Get()
  list() {
    return this.db.adminTx((tx) =>
      tx.q(
        `SELECT a.user_id AS "userId", COALESCE(u.email::text, u.phone) AS login, u.name, a.role, a.status, a.totp_enabled_at IS NOT NULL AS "twoFactor", a.created_at AS "createdAt"
         FROM admin_users a JOIN users u ON u.id = a.user_id ORDER BY a.created_at`,
      ),
    );
  }

  @AdminRoles('owner')
  @Post()
  async add(@CurrentAdmin() me: AdminSession, @Body(new ZodPipe(TeamAdd)) b: z.infer<typeof TeamAdd>, @ClientIp() ip: string) {
    return this.db.adminTx(async (tx) => {
      const u = await tx.one(`SELECT id FROM users WHERE email = $1`, [b.email]);
      if (!u) throw notFound('No Orbit account uses that email yet. Ask them to sign up first.');
      const r = await tx.one(
        `INSERT INTO admin_users (user_id, role, created_by) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active' RETURNING user_id, role`,
        [u.id, b.role, me.userId],
      );
      await tx.q(`UPDATE users SET is_platform_admin = true WHERE id = $1`, [u.id]);
      await this.audit.write({ actorId: me.userId, actorKind: 'admin', action: 'admin.team.add', entity: 'admin_user', entityId: u.id, after: r, ip }, tx);
      return r;
    });
  }

  @AdminRoles('owner')
  @Patch(':userId')
  async patch(@CurrentAdmin() me: AdminSession, @Param('userId', ParseUUIDPipe) userId: string, @Body(new ZodPipe(TeamPatch)) b: z.infer<typeof TeamPatch>, @ClientIp() ip: string) {
    if (userId === me.userId && (b.status === 'disabled' || (b.role && b.role !== 'owner'))) throw badRequest('self_lockout', 'You cannot remove your own Owner access.');
    return this.db.adminTx(async (tx) => {
      const before = await tx.one(`SELECT role, status FROM admin_users WHERE user_id = $1`, [userId]);
      if (!before) throw notFound();
      const after = await tx.one(`UPDATE admin_users SET role = COALESCE($2, role), status = COALESCE($3, status) WHERE user_id = $1 RETURNING role, status`, [userId, b.role ?? null, b.status ?? null]);
      await this.audit.write({ actorId: me.userId, actorKind: 'admin', action: 'admin.team.update', entity: 'admin_user', entityId: userId, before, after, ip }, tx);
      return after;
    });
  }

  @AdminRoles('owner')
  @Post(':userId/reset-2fa')
  async reset(@CurrentAdmin() me: AdminSession, @Param('userId', ParseUUIDPipe) userId: string, @ClientIp() ip: string) {
    return this.db.adminTx(async (tx) => {
      const r = await tx.one(`UPDATE admin_users SET totp_secret = NULL, totp_enabled_at = NULL, last_totp_step = NULL WHERE user_id = $1 RETURNING user_id`, [userId]);
      if (!r) throw notFound();
      await this.audit.write({ actorId: me.userId, actorKind: 'admin', action: 'admin.team.reset_2fa', entity: 'admin_user', entityId: userId, ip }, tx);
      return { ok: true };
    });
  }
}
