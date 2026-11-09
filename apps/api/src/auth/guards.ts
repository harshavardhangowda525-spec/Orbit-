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
import { currentContext } from '../context';
import type { JwtPayload, Tenant } from './types';

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
  async resolve(token: string, explain = false): Promise<{ id: string; impersonation?: { adminId: string; businessId: string } } | null> {
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
        return null;
      }
    }
    try {
      const p = this.jwt.verify<JwtPayload>(token);
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
      // Impersonation tokens are locked to exactly one business.
      if (user.impersonation.businessId !== businessId) throw forbidden();
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
    return true;
  }
}

/** Platform admins only (the Orbit team). Impersonation tokens never count as admin. */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly db: DbService) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.user || req.user.impersonation) throw forbidden();
    const u = await this.db.one<{ is_platform_admin: boolean }>(`SELECT is_platform_admin FROM users WHERE id = $1`, [req.user.id]);
    if (!u?.is_platform_admin) throw forbidden();
    return true;
  }
}

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
