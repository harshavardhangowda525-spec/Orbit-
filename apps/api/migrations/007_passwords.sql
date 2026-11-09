-- 007: email + password sign-in for Orbit's own sign-in (local development).
-- Hosted deployments use Supabase Auth, which stores passwords itself.
ALTER TABLE users ADD COLUMN password_hash text;
