import type { Role } from '@orbit/shared';

export interface AuthUser {
  id: string;
  /** Set when a platform admin is impersonating a business (audited). */
  impersonation?: { adminId: string; businessId: string; readOnly?: boolean };
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
    admin?: AdminSession;
  }
}

export type AdminRole = 'owner' | 'finance' | 'support' | 'viewer';
export interface AdminSession {
  userId: string;
  role: AdminRole;
}

export interface JwtPayload {
  sub: string;
  imp?: { adminId: string; businessId: string; readOnly?: boolean };
  /** Admin session (after the authenticator code): marks the token as admin-only. */
  adm?: { role: AdminRole };
}
