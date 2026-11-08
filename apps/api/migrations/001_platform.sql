-- 001: platform-level tables (not owned by a single business).
-- These hold accounts, businesses and configuration — never customer data.

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TABLE plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  prices      jsonb NOT NULL,            -- {"INR": 1999, "USD": 49}
  limits      jsonb NOT NULL,
  features    jsonb NOT NULL,
  sort_order  int NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone              text UNIQUE,              -- E.164
  email              citext UNIQUE,
  name               text,
  language           text NOT NULL DEFAULT 'en',
  auth_providers     jsonb NOT NULL DEFAULT '[]', -- [{"provider":"google","sub":"..."}]
  google_sub         text UNIQUE,
  is_platform_admin  boolean NOT NULL DEFAULT false,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (phone IS NOT NULL OR email IS NOT NULL)
);

CREATE TABLE businesses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  slug                text NOT NULL UNIQUE,
  type                text NOT NULL,
  timezone            text NOT NULL DEFAULT 'Asia/Kolkata',
  currency            text NOT NULL DEFAULT 'INR',
  country             text NOT NULL DEFAULT 'IN',
  default_language    text NOT NULL DEFAULT 'en',
  supported_languages text[] NOT NULL DEFAULT ARRAY['en'],
  plan_id             uuid NOT NULL REFERENCES plans(id),
  status              text NOT NULL DEFAULT 'onboarding'
                      CHECK (status IN ('onboarding', 'live', 'paused', 'suspended')),
  onboarding_step     int NOT NULL DEFAULT 2,
  calendar_mode       text NOT NULL DEFAULT 'builtin' CHECK (calendar_mode IN ('builtin', 'google', 'outlook')),
  launched_at         timestamptz,
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner', 'manager', 'staff')),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'removed')),
  invited_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, business_id)
);
CREATE INDEX ON memberships (business_id);

CREATE TABLE business_templates (
  type        text PRIMARY KEY,
  content     jsonb NOT NULL,             -- services, hours, faqs, sequences, agent settings, prompts
  version     int NOT NULL DEFAULT 1,
  updated_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE otp_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        text NOT NULL,
  code_hash    text NOT NULL,
  expires_at   timestamptz NOT NULL,
  attempts     int NOT NULL DEFAULT 0,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON otp_codes (phone, created_at DESC);

-- Platform-wide audit log (admin actions, impersonation, sign-ins).
-- Business-scoped sensitive actions are ALSO written here with business_id set.
CREATE TABLE audit_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid REFERENCES businesses(id) ON DELETE SET NULL,
  actor_id     uuid REFERENCES users(id),
  actor_kind   text NOT NULL DEFAULT 'user',  -- user, admin, agent, system
  action       text NOT NULL,
  entity       text,
  entity_id    uuid,
  before       jsonb,
  after        jsonb,
  ip           inet,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (business_id, at DESC);

CREATE TRIGGER t_plans_updated BEFORE UPDATE ON plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER t_users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER t_businesses_updated BEFORE UPDATE ON businesses FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER t_memberships_updated BEFORE UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER t_templates_updated BEFORE UPDATE ON business_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
