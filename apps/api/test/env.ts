// Test environment: a separate orbit_test database, dev OTP echo, no rate limits.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://orbit_app:orbit_app_dev@localhost:5432/orbit_test';
process.env.DATABASE_ADMIN_URL ??= 'postgres://orbit_admin:orbit_admin_dev@localhost:5432/orbit_test';
process.env.DATABASE_MIGRATION_URL ??= 'postgres://orbit_migrator:orbit_migrator_dev@localhost:5432/orbit_test';
process.env.JWT_SECRET = 'test-secret';
process.env.OTP_DEV_ECHO = 'true';
process.env.THROTTLE_DISABLED = 'true';
process.env.LOG_SILENT = 'true';
process.env.PLATFORM_ADMIN_EMAILS = 'admin@orbit.test';
process.env.PUBLIC_BASE_URL = 'https://orbit.test';
process.env.AI_PROVIDER = 'fake';
