-- Orbit on Supabase: run ONCE in the Supabase SQL Editor (it runs as the `postgres` role).
-- Before running, replace the three CHANGE_ME passwords with long random passwords
-- (letters and numbers only, so they work in connection strings without escaping).
--
-- Creates the same three roles Orbit uses everywhere:
--   orbit_migrator : owns Orbit's tables, runs migrations
--   orbit_app      : the running API; Row-Level Security always applies to it
--   orbit_admin    : platform admin panel only (cross-business totals)

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orbit_migrator') THEN
    CREATE ROLE orbit_migrator LOGIN PASSWORD 'CHANGE_ME_MIGRATOR';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orbit_app') THEN
    CREATE ROLE orbit_app LOGIN PASSWORD 'CHANGE_ME_APP' NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orbit_admin') THEN
    CREATE ROLE orbit_admin LOGIN PASSWORD 'CHANGE_ME_ADMIN';
  END IF;
END
$$;

-- The admin role reads totals across businesses, so it must bypass RLS.
-- If Supabase does not allow this, you will see a NOTICE: then use the `postgres`
-- connection string for DATABASE_ADMIN_URL instead (it bypasses RLS on Supabase).
DO $$
BEGIN
  ALTER ROLE orbit_admin BYPASSRLS;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Could not grant BYPASSRLS to orbit_admin: use the postgres connection string for DATABASE_ADMIN_URL';
END
$$;

-- Extensions live in Supabase's `extensions` schema.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

GRANT USAGE, CREATE ON SCHEMA public TO orbit_migrator;
GRANT USAGE ON SCHEMA public TO orbit_app, orbit_admin;
GRANT USAGE ON SCHEMA extensions TO orbit_migrator, orbit_app, orbit_admin;
ALTER ROLE orbit_migrator SET search_path = public, extensions;
ALTER ROLE orbit_app SET search_path = public, extensions;
ALTER ROLE orbit_admin SET search_path = public, extensions;

-- Check: the last column must be true for orbit_admin (or use the postgres URL, see above).
SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname LIKE 'orbit_%' ORDER BY rolname;
