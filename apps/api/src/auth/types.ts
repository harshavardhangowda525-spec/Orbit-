import type { Role } from '@orbit/shared';

export interface AuthUser {
  id: string;
  /** Set when a platform admin is impersonating a business (audited). */
  impersonation?: { adminId: string; businessId: string };
}

export interface Tenant {
  businessId: string;
  role: Role;
  userId: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
    tenant?: Tenant;
  }
}

export interface JwtPayload {
  sub: string;
  imp?: { adminId: string; businessId: string };
}
