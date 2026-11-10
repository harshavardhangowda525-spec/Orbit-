-- 009: Ledger: GST-ready invoices, payment links, reminders.

-- Seller details printed on invoices.
ALTER TABLE business_profiles
  ADD COLUMN legal_name text,
  ADD COLUMN gst_state text,                                    -- 2-digit GST state code (from the GSTIN)
  ADD COLUMN default_tax_rate numeric(5, 2) NOT NULL DEFAULT 18,
  ADD COLUMN prices_include_tax boolean NOT NULL DEFAULT true,  -- shop prices usually include GST
  ADD COLUMN invoice_prefix text NOT NULL DEFAULT 'INV',
  ADD COLUMN invoice_notes text,
  ADD COLUMN payment_terms_days int NOT NULL DEFAULT 7;

-- Drafts have no number yet: GST numbers must be consecutive for issued invoices only.
ALTER TABLE invoices ALTER COLUMN number DROP NOT NULL;
ALTER TABLE invoices
  ADD COLUMN kind text NOT NULL DEFAULT 'invoice' CHECK (kind IN ('invoice', 'deposit')),
  ADD COLUMN fiscal_year text,
  ADD COLUMN seq int,
  ADD COLUMN currency text NOT NULL DEFAULT 'INR',
  ADD COLUMN subtotal numeric(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN tax_total numeric(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN amount_paid numeric(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN customer_snapshot jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN seller_snapshot jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN place_of_supply text,
  ADD COLUMN notes text,
  ADD COLUMN issued_at timestamptz,
  ADD COLUMN sent_at timestamptz,
  ADD COLUMN paid_at timestamptz,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN public_token_hash text,
  ADD COLUMN pay_link_id text,
  ADD COLUMN pay_link_url text,
  ADD COLUMN reminders_sent int NOT NULL DEFAULT 0,
  ADD COLUMN last_reminded_at timestamptz;
CREATE UNIQUE INDEX invoices_fy_seq ON invoices (business_id, fiscal_year, seq) WHERE seq IS NOT NULL;
CREATE UNIQUE INDEX invoices_public_token ON invoices (public_token_hash) WHERE public_token_hash IS NOT NULL;
CREATE UNIQUE INDEX invoices_pay_link ON invoices (business_id, pay_link_id) WHERE pay_link_id IS NOT NULL;
CREATE INDEX ON invoices (business_id, status, due_at);

-- One running number per business per financial year (April to March).
CREATE TABLE invoice_counters (
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  fiscal_year text NOT NULL,
  last_seq int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, fiscal_year)
);
ALTER TABLE invoice_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice_counters USING (business_id = app_current_business()) WITH CHECK (business_id = app_current_business());
CREATE TRIGGER t_invoice_counters_updated BEFORE UPDATE ON invoice_counters FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- An issued invoice never changes: cancel it and issue a new one. Enforced by the database, not just the app.
CREATE OR REPLACE FUNCTION invoices_locked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
       NEW.number IS DISTINCT FROM OLD.number OR NEW.seq IS DISTINCT FROM OLD.seq OR NEW.fiscal_year IS DISTINCT FROM OLD.fiscal_year
    OR NEW.line_items IS DISTINCT FROM OLD.line_items OR NEW.tax IS DISTINCT FROM OLD.tax
    OR NEW.subtotal IS DISTINCT FROM OLD.subtotal OR NEW.tax_total IS DISTINCT FROM OLD.tax_total OR NEW.total IS DISTINCT FROM OLD.total
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.customer_snapshot IS DISTINCT FROM OLD.customer_snapshot
    OR NEW.seller_snapshot IS DISTINCT FROM OLD.seller_snapshot OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
    OR NEW.place_of_supply IS DISTINCT FROM OLD.place_of_supply
  ) THEN
    RAISE EXCEPTION 'invoice_locked' USING ERRCODE = 'check_violation', DETAIL = 'An issued invoice cannot be changed. Cancel it and issue a new one.';
  END IF;
  IF OLD.status IN ('paid', 'cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'invoice_final' USING ERRCODE = 'check_violation', DETAIL = 'A paid or cancelled invoice is final.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER t_invoices_locked BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_locked();

-- The running app cannot delete invoices at all (records are kept; a business deletion still cascades).
REVOKE DELETE ON invoices FROM orbit_app;

-- A payment is recorded once per provider reference (webhooks retry).
CREATE UNIQUE INDEX payments_provider_ref ON payments (business_id, provider, provider_ref) WHERE provider_ref IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_counters TO orbit_app, orbit_admin;
