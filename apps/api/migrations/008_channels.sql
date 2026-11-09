-- 008: customer messaging channels (WhatsApp, Instagram, Messenger through Meta).

-- Which business owns an incoming Meta account id (WhatsApp phone_number_id, Facebook page id,
-- Instagram account id). Platform-level: webhooks arrive before Orbit knows the business.
-- Only exact lookups by (channel, external_id) are made; no customer data lives here.
CREATE TABLE channel_routes (
  channel text NOT NULL,
  external_id text NOT NULL,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  power_connection_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, external_id)
);
CREATE INDEX ON channel_routes (business_id);

-- Customers known by a channel-specific id rather than a phone number (Instagram, Messenger).
CREATE TABLE customer_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  channel text NOT NULL,
  external_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, channel, external_id),
  FOREIGN KEY (business_id, customer_id) REFERENCES customers(business_id, id) ON DELETE CASCADE
);

-- Why an outbound message was not delivered (shown in the inbox).
ALTER TABLE messages ADD COLUMN delivery_error text;

-- Channel settings that are not secrets (e.g. the WhatsApp template used outside the 24-hour window).
ALTER TABLE power_connections ADD COLUMN settings jsonb NOT NULL DEFAULT '{}';

ALTER TABLE customer_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_identities USING (business_id = app_current_business()) WITH CHECK (business_id = app_current_business());
CREATE TRIGGER t_customer_identities_updated BEFORE UPDATE ON customer_identities FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON customer_identities, channel_routes TO orbit_app, orbit_admin;
