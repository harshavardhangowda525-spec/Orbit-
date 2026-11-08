-- 005: Supabase support.

-- Sign-in can come from Supabase Auth: link each Supabase user to one Orbit user.
ALTER TABLE users ADD COLUMN supabase_uid uuid UNIQUE;

-- On Supabase, the Data API (PostgREST) serves the public schema to the `anon`
-- and `authenticated` roles. Orbit is only ever reached through its own API, so
-- those roles must never be able to read Orbit's tables, even by accident.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
    END IF;
  END LOOP;
END
$$;
