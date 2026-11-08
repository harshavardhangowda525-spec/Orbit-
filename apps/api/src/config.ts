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
