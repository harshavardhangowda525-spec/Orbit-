import { Injectable } from '@nestjs/common';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { auth } from '../config';

export interface SupabaseClaims {
  sub: string;
  email: string | null;
  phone: string | null; // Supabase sends digits without "+"
  name: string | null;
  /** Supabase confirmed the email (or phone), or this sign-in itself proved it (Google, email link). */
  verified: boolean;
}

/** Sign-in methods that prove the person controls the email address. */
const PROVING_METHODS = new Set(['oauth', 'otp', 'magiclink', 'recovery', 'invite', 'email_change']);

/**
 * Verifies Supabase Auth access tokens.
 * Current projects sign with asymmetric keys (ES256/RS256) published at
 *   https://<ref>.supabase.co/auth/v1/.well-known/jwks.json
 * Projects still on the legacy shared secret (HS256) set SUPABASE_JWT_SECRET.
 * Issuer must be <SUPABASE_URL>/auth/v1 and audience "authenticated".
 */
@Injectable()
export class SupabaseVerifier {
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  private jwksFor = '';

  private keySet() {
    if (!this.jwks || this.jwksFor !== auth.supabaseJwksUrl) {
      this.jwks = createRemoteJWKSet(new URL(auth.supabaseJwksUrl), { cacheMaxAge: 10 * 60_000 });
      this.jwksFor = auth.supabaseJwksUrl;
    }
    return this.jwks;
  }

  /** True when the token was issued by this project's Supabase Auth (cheap check before verifying). */
  looksLikeSupabase(token: string): boolean {
    if (!auth.supabaseUrl) return false;
    try {
      const body = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
      return body?.iss === `${auth.supabaseUrl}/auth/v1`;
    } catch {
      return false;
    }
  }

  async verify(token: string): Promise<SupabaseClaims> {
    const opts = { issuer: `${auth.supabaseUrl}/auth/v1`, audience: 'authenticated' };
    const { alg } = decodeProtectedHeader(token);
    let payload: JWTPayload;
    if (alg === 'HS256') {
      if (!auth.supabaseJwtSecret) throw new Error('HS256 token but SUPABASE_JWT_SECRET is not set');
      payload = (await jwtVerify(token, new TextEncoder().encode(auth.supabaseJwtSecret), { ...opts, algorithms: ['HS256'] })).payload;
    } else {
      payload = (await jwtVerify(token, this.keySet(), { ...opts, algorithms: ['ES256', 'RS256'] })).payload;
    }
    if (typeof payload.sub !== 'string' || payload.role !== 'authenticated') throw new Error('not a signed-in user token');
    const meta = (payload.user_metadata ?? {}) as Record<string, unknown>;
    const amr = Array.isArray(payload.amr) ? (payload.amr as { method?: string }[]).map((a) => a?.method ?? '') : [];
    return {
      verified: meta.email_verified === true || meta.phone_verified === true || amr.some((m) => PROVING_METHODS.has(m)),
      sub: payload.sub,
      email: typeof payload.email === 'string' && payload.email ? payload.email.toLowerCase() : null,
      phone: typeof payload.phone === 'string' && payload.phone ? payload.phone : null,
      name: typeof meta.full_name === 'string' ? meta.full_name : typeof meta.name === 'string' ? meta.name : null,
    };
  }
}
