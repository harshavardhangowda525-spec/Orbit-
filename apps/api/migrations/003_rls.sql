-- 003: Row-Level Security on every business-owned table, plus grants.
--
-- Rule: every table in `public` that has a business_id column gets
--   ENABLE + FORCE ROW LEVEL SECURITY and a tenant_isolation policy,
-- except the explicit platform allowlist below. An automated test
-- (test/isolation.e2e-spec.ts) fails if any new table slips through.

DO $$
DECLARE
  t text;
  platform_tables text[] := ARRAY['memberships', 'audit_log'];
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'business_id' AND tb.table_type = 'BASE TABLE'
      AND NOT (c.table_name = ANY (platform_tables))
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (business_id = app_current_business()) WITH CHECK (business_id = app_current_business())',
      t
    );
    EXECUTE format('DROP TRIGGER IF EXISTS t_%s_updated ON %I', t, t);
    EXECUTE format('CREATE TRIGGER t_%s_updated BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO orbit_app, orbit_admin;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO orbit_app, orbit_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO orbit_app, orbit_admin;

-- The app may never rewrite history in the audit log.
REVOKE UPDATE, DELETE ON audit_log FROM orbit_app;
