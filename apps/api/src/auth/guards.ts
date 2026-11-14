import { CanActivate, ExecutionContext, Injectable, SetMetadata, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { Role } from '@orbit/shared';
import { DbService } from '../db/db.service';
import { SupabaseVerifier } from './supabase';
import { AuthService } from './auth.service';
import { auth } from '../config';
import { AppError, forbidden } from '../common/errors';
import { logger } from '../logger';

/** The token's issuer, without verifying it (only used to explain a rejection). */
function tokenIssuer(token: string): string | null {
  try {
    const iss = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))?.iss;
    return typeof iss === 'string' ? iss : null;
  } catch {
    return null;
  }
}
import { currentContext } from '../context';
import type { AdminRole, JwtPayload, Tenant } from './types';

export const IS_PUBLIC = 'orbit:public';
/** Route needs no sign-in (public business pages, OTP request, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES_KEY = 'orbit:roles';
/** Limit a tenant route to some roles, e.g. @Roles('owner','manager'). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Global guard: every route requires a valid sign-in token unless marked @Public().
 * Accepts Orbit's own tokens (local sign-in, admin impersonation) and, when
 * AUTH_PROVIDER=supabase, Supabase Auth access tokens for this project.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private cache = new Map<string, { userId: string; at: number }>();
  private warned = new Set<string>();
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly supabase: SupabaseVerifier,
    private readonly authService: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new AppError(401, 'unauthorized', 'Please sign in.');
    const user = await this.resolve(token, true);
    if (!user) throw new AppError(401, 'unauthorized', 'Please sign in again.');
    req.user = user;
    const c = currentContext();
    if (c) c.userId = user.id;
    return true;
  }

  /** Token -> user, shared with the WebSocket gateway. */
  async resolve(token: string, explain = false): Promise<{ id: string; impersonation?: { adminId: string; businessId: string; readOnly?: boolean } } | null> {
    // A Supabase token the server is not set up to accept: say which setting is wrong (once per issuer in the log).
    const iss = tokenIssuer(token);
    if (iss?.endsWith('.supabase.co/auth/v1') && !(auth.provider === 'supabase' && this.supabase.looksLikeSupabase(token))) {
      const why =
        auth.provider !== 'supabase'
          ? 'AUTH_PROVIDER on orbit-api must be "supabase"'
          : `SUPABASE_URL on orbit-api is "${auth.supabaseUrl || '(not set)'}" but this sign-in came from ${iss.replace(/\/auth\/v1$/, '')}`;
      if (!this.warned.has(why)) {
        this.warned.add(why);
        logger.warn(`Rejected a Supabase sign-in: ${why}`, 'Auth');
      }
      if (explain) throw new AppError(401, 'auth_not_configured', `Orbit's server is not set up for this sign-in yet: ${why}.`);
      return null;
    }
    if (auth.provider === 'supabase' && this.supabase.looksLikeSupabase(token)) {
      try {
        const claims = await this.supabase.verify(token);
        const hit = this.cache.get(claims.sub);
        if (hit && Date.now() - hit.at < 10 * 60_000) return { id: hit.userId };
        const userId = await this.authService.userForSupabase(claims);
        if (this.cache.size > 5000) this.cache.clear();
        this.cache.set(claims.sub, { userId, at: Date.now() });
        return { id: userId };
      } catch (e) {
        // A known reason (e.g. email not confirmed yet) is shown to the person; anything else is just "sign in again".
        if (explain && e instanceof AppError && e.getStatus() !== 401) throw e;
        // An expired token is normal (the app renews it and retries); only unexpected failures are worth a warning.
        if (!(e instanceof AppError) && (e as { code?: string }).code !== 'ERR_JWT_EXPIRED') logger.warn(`Supabase sign-in rejected: ${(e as Error).message}`, 'Auth');
        return null;
      }
    }
    try {
      const p = this.jwt.verify<JwtPayload>(token);
      if (p.adm) return null; // an admin session is not a sign-in on its own
      return { id: p.sub, impersonation: p.imp };
    } catch {
      return null;
    }
  }
}

/**
 * Resolves which business a request acts for, from the X-Business-Id header,
 * and proves the signed-in user is an active member of it. Without this guard a
 * route has no business context and RLS returns no business data at all.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly db: DbService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const user = req.user;
    if (!user) throw new AppError(401, 'unauthorized', 'Please sign in.');
    const businessId = String(req.headers['x-business-id'] ?? '');
    if (!UUID_RE.test(businessId)) throw forbidden('Please choose a business first.');

    let role: Role;
    if (user.impersonation) {
      // Impersonation tokens are locked to exactly one business, and read-only unless an Owner asked otherwise.
      if (user.impersonation.businessId !== businessId) throw forbidden();
      if (user.impersonation.readOnly && req.method !== 'GET') throw forbidden('Viewing as this business is read-only.');
      role = 'owner';
    } else {
      const m = await this.db.one<{ role: Role }>(
        `SELECT m.role FROM memberships m JOIN businesses b ON b.id = m.business_id
         WHERE m.user_id = $1 AND m.business_id = $2 AND m.status = 'active' AND b.status <> 'suspended'`,
        [user.id, businessId],
      );
      if (!m) throw forbidden();
      role = m.role;
    }
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (roles && !roles.includes(role)) throw forbidden('Only the business owner can do this.');

    req.tenant = { businessId, role, userId: user.id };
    const c = currentContext();
    if (c) c.businessId = businessId;
    // When the business was last used (admin centre); at most once every 10 minutes.
    if (!user.impersonation) this.db.adminTx((tx) => tx.q(`UPDATE businesses SET last_active_at = now() WHERE id = $1 AND (last_active_at IS NULL OR last_active_at < now() - interval '10 minutes')`, [businessId])).catch(() => undefined);
    return true;
  }
}

/** Platform admins only (the Orbit team). Impersonation tokens never count as admin. */
export const ADMIN_ROLES = 'adminRoles';
/** Admin roles allowed on a route. Without it: GET is open to every admin role, changes need Owner. */
export const AdminRoles = (...roles: AdminRole[]) => SetMetadata(ADMIN_ROLES, roles);
export const ADMIN_SESSION_HEADER = 'x-admin-session';

/**
 * Platform admin routes. A normal sign-in is not enough: the request also
 * carries an admin session (issued after the authenticator code, 8 hours), and
 * the person must be an active member of the admin team. Their role comes from
 * the database on every request, so a changed or removed role applies at once.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly db: DbService, private readonly jwt: JwtService, private readonly reflector: Reflector) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.user || req.user.impersonation) throw forbidden();
    const row = await this.db.one<{ role: AdminRole; ready: boolean; status: string }>(`SELECT role, status, totp_enabled_at IS NOT NULL AS ready FROM admin_users WHERE user_id = $1`, [req.user.id]);
    if (row && row.status !== 'active') throw forbidden('Your admin access has been switched off.');
    const a = row ?? null;
    const platform = a ? null : await this.db.one<{ is_platform_admin: boolean }>(`SELECT is_platform_admin FROM users WHERE id = $1`, [req.user.id]);
    if (!a && !platform?.is_platform_admin) throw forbidden();
    const raw = String(req.headers[ADMIN_SESSION_HEADER] ?? '');
    let p: JwtPayload | null = null;
    try {
      p = raw ? this.jwt.verify<JwtPayload>(raw) : null;
    } catch {
      p = null;
    }
    if (!a?.ready || !p?.adm || p.sub !== req.user.id) throw new AppError(401, 'admin_session_required', 'Please confirm with your authenticator code to open the admin centre.');
    const allowed = this.reflector.getAllAndOverride<AdminRole[] | undefined>(ADMIN_ROLES, [ctx.getHandler(), ctx.getClass()]);
    const ok = allowed ? allowed.includes(a.role) || a.role === 'owner' : req.method === 'GET' ? true : a.role === 'owner';
    if (!ok) throw forbidden('Your admin role does not allow this.');
    req.admin = { userId: req.user.id, role: a.role };
    return true;
  }
}

export const CurrentAdmin = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<Request>().admin!);

export const CurrentTenant = createParamDecorator((_: unknown, ctx: ExecutionContext): Tenant => {
  const t = ctx.switchToHttp().getRequest<Request>().tenant;
  if (!t) throw forbidden('Please choose a business first.');
  return t;
});

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const u = ctx.switchToHttp().getRequest<Request>().user;
  if (!u) throw new AppError(401, 'unauthorized', 'Please sign in.');
  return u;
});

export const ClientIp = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<Request>().ip);
