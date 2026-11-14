-- 014: Admin control centre: admin team with 2FA and roles, immutable audit log, plan change
-- events, admin notifications, approval queue, provider budgets, business controls, coupons,
-- messaging centre, feature switches.

-- ---------- Admin team (separate from business accounts) ----------
CREATE TABLE admin_users (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'finance', 'support', 'viewer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  totp_secret bytea,                 -- sealed (AES-256-GCM)
  totp_enabled_at timestamptz,
  last_totp_step bigint,             -- a code is accepted once
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER t_admin_users_updated BEFORE UPDATE ON admin_users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- The audit log cannot be edited or deleted (only a deleted business's id is cleared) ----------
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.business_id IS NULL AND OLD.business_id IS NOT NULL
     AND NEW.id = OLD.id AND NEW.action = OLD.action AND NEW.at = OLD.at
     AND NEW.actor_id IS NOT DISTINCT FROM OLD.actor_id AND NEW.before IS NOT DISTINCT FROM OLD.before AND NEW.after IS NOT DISTINCT FROM OLD.after THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
CREATE TRIGGER t_audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE INDEX ON audit_log (at DESC);

-- ---------- Plan changes (upgrades, downgrades, cancellations, failed payments) ----------
CREATE TABLE plan_change_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('upgrade', 'downgrade', 'cancel', 'payment_failed', 'renewal', 'trial', 'grace_ended')),
  from_plan text,
  to_plan text,
  amount numeric(12, 2),
  currency text DEFAULT 'INR',
  status text,                        -- payment status as reported
  source text NOT NULL DEFAULT 'razorpay',
  actor_id uuid,
  at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id)
);
CREATE INDEX ON plan_change_events (at DESC);
ALTER TABLE plan_change_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_change_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON plan_change_events USING (business_id = app_current_business()) WITH CHECK (business_id = app_current_business());

-- ---------- Admin notifications ----------
CREATE TABLE admin_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  title text NOT NULL,
  body text,
  link text,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON admin_notifications (created_at DESC);
CREATE TABLE admin_notification_reads (
  notification_id uuid REFERENCES admin_notifications(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);

-- ---------- Approval queue ----------
CREATE TABLE admin_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('enterprise_deal', 'custom_limits', 'topup', 'refund', 'credit', 'ai_cost', 'budget_increase')),
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  title text NOT NULL,
  context jsonb NOT NULL DEFAULT '{}',
  payload jsonb NOT NULL DEFAULT '{}',    -- what is applied on approval
  cost_impact numeric(12, 2),             -- INR per month (or one-off)
  margin_impact numeric(12, 2),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  requested_by uuid,
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  due_at timestamptz,
  default_action text NOT NULL DEFAULT 'reject' CHECK (default_action IN ('approve', 'reject')),
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON admin_approvals (status, created_at DESC);

-- ---------- Provider budgets ----------
CREATE TABLE provider_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  month text NOT NULL,                     -- "2026-11"
  amount_inr numeric(12, 2) NOT NULL,
  recommended_inr numeric(12, 2),
  status text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'confirmed')),
  approved_by uuid,
  approved_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  last_reminded_at timestamptz,
  alerts_sent int[] NOT NULL DEFAULT '{}', -- thresholds already announced (70, 90, 100)
  UNIQUE (provider, month)
);

-- ---------- Business controls ----------
ALTER TABLE businesses
  ADD COLUMN ai_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN ai_paused_reason text,
  ADD COLUMN limit_overrides jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN trial_ends_at timestamptz,
  ADD COLUMN trial_return_plan text,
  ADD COLUMN grace_until timestamptz,
  ADD COLUMN price_lock jsonb,             -- founding-customer price {"plan":"pro","INR":1999,"until":null}
  ADD COLUMN applied_coupon text,
  ADD COLUMN last_active_at timestamptz;

CREATE TABLE admin_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON admin_notes (business_id, created_at DESC);

-- ---------- Coupons ----------
CREATE TABLE coupons (
  code text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('percent', 'amount')),
  value numeric(12, 2) NOT NULL CHECK (value > 0),
  valid_from timestamptz,
  valid_to timestamptz,
  max_uses int,
  used int NOT NULL DEFAULT 0,
  eligible_plans text[] NOT NULL DEFAULT '{}',   -- empty = all paid plans
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE coupon_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_code text NOT NULL REFERENCES coupons(code),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  plan_code text,
  at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (coupon_code, business_id)
);

-- ---------- Messaging centre (Orbit -> business owners) ----------
CREATE TABLE message_templates (
  key text PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'transactional' CHECK (category IN ('transactional', 'marketing')),
  channels text[] NOT NULL DEFAULT '{inapp,email}',
  timing jsonb NOT NULL DEFAULT '{}',      -- e.g. {"daysBefore": 7}
  content jsonb NOT NULL,                  -- {"en": {"subject": "...", "body": "..."}, "hi": {...}, "kn": {...}}
  enabled boolean NOT NULL DEFAULT true,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE broadcasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  content jsonb NOT NULL,                  -- same shape as message_templates.content
  segment jsonb NOT NULL DEFAULT '{}',
  channels text[] NOT NULL DEFAULT '{inapp}',
  category text NOT NULL DEFAULT 'marketing' CHECK (category IN ('transactional', 'marketing')),
  link text,
  scheduled_at timestamptz,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'cancelled')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE TABLE owner_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  template_key text,
  broadcast_id uuid REFERENCES broadcasts(id) ON DELETE SET NULL,
  dedupe_key text,                         -- e.g. "renewal_7:<subscription>:<date>"
  channel text NOT NULL,
  subject text,
  body text NOT NULL,
  link text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'skipped', 'unavailable')),
  error text,
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  read_at timestamptz,
  clicked_at timestamptz,
  notification_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dedupe_key, channel, user_id)
);
CREATE INDEX ON owner_messages (status, scheduled_for);
CREATE INDEX ON owner_messages (broadcast_id);
CREATE INDEX ON owner_messages (template_key, created_at DESC);
CREATE TABLE notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  marketing boolean NOT NULL DEFAULT true,
  quiet_start smallint NOT NULL DEFAULT 21,
  quiet_end smallint NOT NULL DEFAULT 9,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Feature switches ----------
CREATE TABLE feature_flags (
  key text PRIMARY KEY,
  description text,
  enabled boolean NOT NULL DEFAULT true,
  allow uuid[] NOT NULL DEFAULT '{}',
  deny uuid[] NOT NULL DEFAULT '{}',
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_settings (key, value) VALUES
  ('approval.rules', '{"enterprise_deal":{"on":true},"custom_limits":{"on":true},"topup":{"on":true,"aboveInr":5000},"refund":{"on":true},"credit":{"on":true},"ai_cost":{"on":true,"dailyInr":500},"budget_increase":{"on":true},"timeoutHours":48}'),
  ('admin.notify', '{"upgrade":["inapp","email"],"downgrade":["inapp","email"],"cancel":["inapp","email"],"payment_failed":["inapp","email"],"approval":["inapp"],"budget":["inapp","email"],"abnormal_usage":["inapp","email"]}'),
  ('costs.units', '{"sarvamPerMinuteInr":1.5,"telephonyPerMinuteInr":0.8,"whatsappPerMessageInr":0.35,"smsPerMessageInr":0.2,"budgetMarginPct":20}'),
  ('billing.grace_days', '7'),
  ('maintenance', '{"on":false,"message":"","blockWrites":false}')
ON CONFLICT DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON admin_users, admin_notifications, admin_notification_reads, admin_approvals, provider_budgets, admin_notes,
  coupons, coupon_redemptions, message_templates, broadcasts, owner_messages, notification_preferences, feature_flags TO orbit_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON plan_change_events TO orbit_app, orbit_admin;
-- The app (business side) sends owner messages, records reads/clicks, writes approvals and admin alerts, and reads switches.
GRANT SELECT, INSERT, UPDATE ON owner_messages, admin_notifications, admin_approvals, notification_preferences TO orbit_app;
GRANT SELECT ON feature_flags, coupons, message_templates TO orbit_app;
GRANT UPDATE (used) ON coupons TO orbit_app;
GRANT INSERT ON coupon_redemptions TO orbit_app;
GRANT SELECT ON admin_users TO orbit_app;

-- Every table that holds a business_id is isolated per business. Orbit's own jobs and the
-- admin centre reach across businesses through the admin role (which bypasses RLS).
ALTER TABLE admin_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON admin_notes USING (business_id = app_current_business()) WITH CHECK (business_id = app_current_business());
ALTER TABLE owner_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON owner_messages USING (business_id = app_current_business()) WITH CHECK (business_id = app_current_business());
ALTER TABLE admin_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON admin_approvals USING (business_id = app_current_business()) WITH CHECK (business_id = app_current_business());
ALTER TABLE coupon_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupon_redemptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON coupon_redemptions USING (business_id = app_current_business()) WITH CHECK (business_id = app_current_business());
