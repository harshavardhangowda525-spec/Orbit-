import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Load apps/api/.env if present (Node 22 built-in; no dotenv dependency). Tests set their own env.
for (const p of process.env.NODE_ENV === 'test' ? [] : [join(__dirname, '..', '.env'), join(process.cwd(), '.env')]) {
  if (existsSync(p)) {
    try {
      process.loadEnvFile(p);
    } catch {
      /* ignore malformed env file */
    }
    break;
  }
}

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: req('DATABASE_URL', 'postgres://orbit_app:orbit_app_dev@localhost:5432/orbit'),
  databaseAdminUrl: req('DATABASE_ADMIN_URL', 'postgres://orbit_admin:orbit_admin_dev@localhost:5432/orbit'),
  databaseMigrationUrl: req('DATABASE_MIGRATION_URL', 'postgres://orbit_migrator:orbit_migrator_dev@localhost:5432/orbit'),
  jwtSecret: req('JWT_SECRET', 'dev-only-secret-change-me'),
  webOrigins: (process.env.WEB_ORIGIN ?? 'http://localhost:3000').split(',').map((s) => s.trim()),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  smsProvider: process.env.SMS_PROVIDER ?? 'dev',
  get otpDevEcho() {
    return process.env.OTP_DEV_ECHO === 'true' && config.env !== 'production';
  },
  platformAdminPhones: (process.env.PLATFORM_ADMIN_PHONES ?? '').split(',').map((s) => s.trim()).filter(Boolean),
};

if (config.env === 'production' && config.jwtSecret.startsWith('dev-only')) {
  throw new Error('JWT_SECRET must be set in production');
}

export const runtime = {
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  /** "bullmq" runs background jobs on Redis; "inline" keeps them in memory (tests). */
  jobsMode: (process.env.JOBS_MODE ?? (process.env.NODE_ENV === 'test' ? 'inline' : 'bullmq')) as 'bullmq' | 'inline',
  /** "redis" fans live updates out across API instances; "local" is single-process (tests). */
  realtimeMode: (process.env.REALTIME_MODE ?? (process.env.NODE_ENV === 'test' ? 'local' : 'redis')) as 'redis' | 'local',
  aiProvider: (process.env.AI_PROVIDER ?? 'claude') as 'claude' | 'fake',
  aiModel: process.env.AI_MODEL ?? 'claude-opus-5-5',
  /** 32-byte key (base64) for encrypting Power tokens. */
  powersKey: process.env.POWERS_ENCRYPTION_KEY ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:4000/powers/oauth/callback',
  webBaseUrl: (process.env.WEB_BASE_URL ?? process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
  /** Development: messages to channels that are not connected are recorded as sent (not delivered). */
  devDeliver: process.env.DEV_DELIVER === 'true',
};

/** TLS to Postgres: "off" (local), "require" (encrypted; hosted pools such as Supabase), "verify" (also checks DATABASE_CA_CERT). */
export function pgSsl(): false | { rejectUnauthorized: boolean; ca?: string } {
  const mode = process.env.DATABASE_SSL ?? 'off';
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'verify') return { rejectUnauthorized: true, ca: process.env.DATABASE_CA_CERT?.replace(/\\n/g, '\n') };
  return false;
}

/** Sign-in: "orbit" (Orbit's own phone codes + Google) or "supabase" (Supabase Auth tokens). Read live so tests can switch. */
export const auth = {
  get provider() {
    return (process.env.AUTH_PROVIDER ?? 'orbit') as 'orbit' | 'supabase';
  },
  get supabaseUrl() {
    return (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
  },
  /** Where the signing keys are published (defaults to the project's JWKS URL). */
  get supabaseJwksUrl() {
    return process.env.SUPABASE_JWKS_URL || `${(process.env.SUPABASE_URL ?? '').replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`;
  },
  /** Only for projects still on the legacy shared JWT secret (HS256). */
  get supabaseJwtSecret() {
    return process.env.SUPABASE_JWT_SECRET ?? '';
  },
  get adminEmails() {
    return (process.env.PLATFORM_ADMIN_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  },
};
