-- 013: five plans, AI tiers and routing, daily/monthly limits with graceful handover, wallet, margins.

-- Plans: Base becomes Plus; Pro and Enterprise are added by the seed. Plans an admin edited
-- (updated_by set) are never overwritten by the built-in defaults.
ALTER TABLE plans ADD COLUMN updated_by uuid;
UPDATE plans SET code = 'plus', name = 'Plus' WHERE code = 'base' AND NOT EXISTS (SELECT 1 FROM plans WHERE code = 'plus');
UPDATE subscriptions SET plan_code = 'plus' WHERE plan_code = 'base';

-- Platform settings edited in admin (AI routing, AI budget %, ...). Not per business.
CREATE TABLE platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_settings (key, value) VALUES ('ai.budget_pct', '25'), ('ai.net_revenue_factor', '0.83') ON CONFLICT DO NOTHING;

-- Every AI call: which provider/model/tier served it, for which task, and whether it was a failover.
ALTER TABLE ai_usage
  ADD COLUMN provider text,
  ADD COLUMN tier text,
  ADD COLUMN task_type text,
  ADD COLUMN failover boolean NOT NULL DEFAULT false,
  ADD COLUMN error text;
CREATE INDEX ON ai_usage (business_id, agent_key, created_at);

-- Limits: one row per business, scope (day/month) and period, recording the 80% heads-up,
-- the moment the limit was reached, and the "reply to waiting chats?" offer after it reset.
CREATE TABLE usage_limit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('day', 'month', 'assistant')),
  period text NOT NULL,                       -- "2026-11-14" (local day) or "2026-11"
  cap int NOT NULL,
  warned_at timestamptz,
  hit_at timestamptz,
  resume_offered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, scope, period),
  UNIQUE (business_id, id)
);
ALTER TABLE usage_limit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_limit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_limit_events USING (business_id = app_current_business()) WITH CHECK (business_id = app_current_business());
CREATE TRIGGER t_usage_limit_events_updated BEFORE UPDATE ON usage_limit_events FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A conversation that arrived while Orbit was paused: one acknowledgement, then it waits for staff.
ALTER TABLE conversations
  ADD COLUMN limit_ack_at timestamptz,
  ADD COLUMN parked_for_limit_at timestamptz;
CREATE INDEX conversations_parked ON conversations (business_id) WHERE parked_for_limit_at IS NOT NULL;

-- Pay As You Go: credit the business topped up, used per conversation past the allowance.
ALTER TABLE businesses ADD COLUMN ai_wallet_balance numeric(12, 2) NOT NULL DEFAULT 0;
CREATE TABLE wallet_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  amount numeric(12, 2) NOT NULL,             -- + top-up / credit, - usage
  kind text NOT NULL CHECK (kind IN ('topup', 'credit', 'usage', 'refund')),
  unit text,                                  -- aiConversation, callMinute
  conversation_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id)
);
CREATE INDEX ON wallet_transactions (business_id, created_at);
ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON wallet_transactions USING (business_id = app_current_business()) WITH CHECK (business_id = app_current_business());

-- Payments Razorpay confirmed for Orbit plans (revenue for the margin dashboard).
CREATE TABLE subscription_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  subscription_id uuid,
  plan_code text NOT NULL,
  provider_payment_id text NOT NULL UNIQUE,
  amount numeric(12, 2) NOT NULL,             -- gross, as charged (incl. GST)
  currency text NOT NULL DEFAULT 'INR',
  charged_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id)
);
CREATE INDEX ON subscription_charges (charged_at);
ALTER TABLE subscription_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_charges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subscription_charges USING (business_id = app_current_business()) WITH CHECK (business_id = app_current_business());
INSERT INTO platform_settings (key, value) VALUES ('fx.usd_inr', '84') ON CONFLICT DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON subscription_charges TO orbit_app, orbit_admin;
GRANT SELECT ON platform_settings TO orbit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_settings TO orbit_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON usage_limit_events, wallet_transactions TO orbit_app, orbit_admin;
