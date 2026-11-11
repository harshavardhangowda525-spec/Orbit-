-- 011: Orbit subscriptions, Crew permissions, review link.

-- Where review requests send happy customers (e.g. the Google review link).
ALTER TABLE business_profiles ADD COLUMN review_url text;

-- Razorpay plan ids Orbit created for each price (a new price gets a new plan).
ALTER TABLE plans ADD COLUMN provider_refs jsonb NOT NULL DEFAULT '{}';

-- Orbit's own subscription for each business (paid plans).
CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  plan_code text NOT NULL,
  provider text NOT NULL DEFAULT 'razorpay',
  provider_subscription_id text NOT NULL,
  status text NOT NULL DEFAULT 'created',   -- created, authenticated, active, pending, halted, cancelled, completed
  short_url text,
  current_end timestamptz,
  cancel_at_cycle_end boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id),
  UNIQUE (provider, provider_subscription_id)
);
CREATE INDEX ON subscriptions (business_id, status);
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subscriptions USING (business_id = app_current_business()) WITH CHECK (business_id = app_current_business());
CREATE TRIGGER t_subscriptions_updated BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Agents' permissions were a list; they are now an object of switches (e.g. {"reviewRequests": false}).
UPDATE agents SET auto_approval_rules = '{}' WHERE jsonb_typeof(auto_approval_rules) <> 'object';
ALTER TABLE agents ALTER COLUMN auto_approval_rules SET DEFAULT '{}';

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriptions TO orbit_app, orbit_admin;
GRANT UPDATE (provider_refs) ON plans TO orbit_app;
