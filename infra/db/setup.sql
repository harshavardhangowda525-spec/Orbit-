-- Run ONCE as a PostgreSQL superuser (docker-compose does this automatically).
-- Creates three roles with deliberately different powers:
--   orbit_migrator : owns the schema, runs migrations. Never used by the running app.
--   orbit_app      : the API and background jobs. NOT the table owner, NO BYPASSRLS,
--                    so Row-Level Security always applies to it.
--   orbit_admin    : platform admin panel only (cross-business aggregates). BYPASSRLS.
-- Passwords here are for local development only; use a secrets manager in production.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orbit_migrator') THEN
    CREATE ROLE orbit_migrator LOGIN PASSWORD 'orbit_migrator_dev';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orbit_app') THEN
    CREATE ROLE orbit_app LOGIN PASSWORD 'orbit_app_dev' NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orbit_admin') THEN
    CREATE ROLE orbit_admin LOGIN PASSWORD 'orbit_admin_dev' NOSUPERUSER BYPASSRLS;
  END IF;
END
$$;
