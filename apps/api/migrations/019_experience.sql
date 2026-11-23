-- 019: Premium experience by plan — appearance, plan changes (upgrade moment), milestones.

-- Owner's look and feel: theme, brand colour (Business), Crew avatar style (Pro), festivals.
ALTER TABLE business_profiles
  ADD COLUMN appearance jsonb NOT NULL DEFAULT '{"theme":"space","brandColor":null,"avatarStyle":"initials","festivals":["diwali","christmas"]}';

-- Every plan change, however it happened (payment, admin, trial end, grace end): the app
-- celebrates an upgrade once and shows a calm summary for a downgrade.
CREATE TABLE plan_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  from_plan text,
  to_plan text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('up', 'down', 'same')),
  -- "What's new" items the owner has tried (ticked) since this upgrade.
  ticks jsonb NOT NULL DEFAULT '[]',
  seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE INDEX ON plan_changes (business_id, created_at DESC);

-- Recorded by a trigger so no code path can forget it. The tenant setting is switched to
-- the changed business just for the insert (row-level security stays forced), then restored.
CREATE OR REPLACE FUNCTION record_plan_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prev text := current_setting('app.business_id', true);
  f record;
  t record;
BEGIN
  IF NEW.plan_id IS NOT DISTINCT FROM OLD.plan_id THEN RETURN NEW; END IF;
  SELECT code, sort_order INTO f FROM plans WHERE id = OLD.plan_id;
  SELECT code, sort_order INTO t FROM plans WHERE id = NEW.plan_id;
  PERFORM set_config('app.business_id', NEW.id::text, true);
  INSERT INTO plan_changes (business_id, from_plan, to_plan, direction)
  VALUES (NEW.id, f.code, t.code, CASE WHEN t.sort_order > COALESCE(f.sort_order, 0) THEN 'up' WHEN t.sort_order < f.sort_order THEN 'down' ELSE 'same' END);
  PERFORM set_config('app.business_id', COALESCE(prev, ''), true);
  RETURN NEW;
END $$;
CREATE TRIGGER businesses_plan_change AFTER UPDATE OF plan_id ON businesses FOR EACH ROW EXECUTE FUNCTION record_plan_change();

-- Milestones reached (first 100 bookings, ₹1 lakh through Orbit, a year with Orbit).
CREATE TABLE milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  key text NOT NULL,
  value numeric,
  reached_at timestamptz NOT NULL DEFAULT now(),
  seen_at timestamptz,
  UNIQUE (business_id, key),
  UNIQUE (business_id, id)
);

ALTER TABLE plan_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON plan_changes USING (business_id = app_current_business()) WITH CHECK (business_id = app_current_business());
ALTER TABLE milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE milestones FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON milestones USING (business_id = app_current_business()) WITH CHECK (business_id = app_current_business());
GRANT SELECT, INSERT, UPDATE, DELETE ON plan_changes, milestones TO orbit_app, orbit_admin;
