-- 016: Snap to set up, and Khata (the accounts agent).
--
-- files: photos and PDFs owners upload (price lists, bills, settlement screenshots).
--   Stored in Supabase Storage when the server has a storage key, otherwise here.
-- snaps: one extraction from up to 5 photos. Nothing is saved from it until the owner confirms.
-- Khata: vendors, expenses (bills), revenue_entries (cash and other sales logged by the owner),
--   expense_categories, recurring_bills and money_snapshots. Online payments and payments at
--   the counter come from the payments table (Ledger); they are never copied, so never counted twice.

CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  purpose text NOT NULL,                 -- price_list | card | hours | bill | settlement
  mime text NOT NULL,
  size_bytes int NOT NULL,
  storage text NOT NULL CHECK (storage IN ('supabase', 'db')),
  path text,                             -- object path in Supabase Storage
  data bytea,                            -- when stored in the database
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE INDEX ON files (business_id, created_at DESC);

CREATE TABLE snaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('price_list', 'card', 'hours', 'bill', 'settlement')),
  file_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'applied', 'discarded', 'failed')),
  result jsonb,
  problem text,                          -- unreadable | not_a_price_list | not_a_bill ...
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  UNIQUE (business_id, id)
);
CREATE INDEX ON snaps (business_id, kind, created_at DESC);

-- Services keep the photo they came from, the name as written (Hindi/Kannada) and an English name.
ALTER TABLE services
  ADD COLUMN name_en text,
  ADD COLUMN price_type text NOT NULL DEFAULT 'fixed' CHECK (price_type IN ('fixed', 'from', 'range', 'per_hour')),
  ADD COLUMN price_max numeric(12, 2),
  ADD COLUMN source_file_ids uuid[] NOT NULL DEFAULT '{}';

CREATE TABLE expense_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  key text NOT NULL,
  label text,                            -- null = the built-in, translated label
  sort_order int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, key)
);

CREATE TABLE vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  name_key text NOT NULL,                -- normalised for matching
  gstin text,
  default_category text,                 -- learned from the owner's choices
  auto_save boolean NOT NULL DEFAULT false,
  confirmed_bills int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, name_key),
  UNIQUE (business_id, id)
);

-- The original schema had an unused placeholder "expenses" table (no code wrote to it).
-- Replace it with Khata's, but never if anything was ever stored there.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'expenses') THEN
    IF EXISTS (SELECT 1 FROM expenses) THEN RAISE EXCEPTION 'expenses has rows; migrate them by hand first'; END IF;
    DROP TABLE expenses;
  END IF;
END
$$;

CREATE TABLE expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  vendor_id uuid,
  vendor_name text,
  bill_number text,
  bill_date date NOT NULL,
  category text NOT NULL DEFAULT 'other',
  subtotal numeric(12, 2),
  tax jsonb NOT NULL DEFAULT '{}',       -- {cgst, sgst, igst, cess}
  total numeric(12, 2) NOT NULL CHECK (total >= 0),
  payment_mode text,
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('draft', 'confirmed', 'deleted')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('scan', 'manual', 'whatsapp', 'gmail')),
  file_ids uuid[] NOT NULL DEFAULT '{}',
  snap_id uuid,
  items jsonb NOT NULL DEFAULT '[]',
  extraction jsonb,
  notes text,
  trace_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  deleted_at timestamptz,
  UNIQUE (business_id, id)
);
CREATE INDEX ON expenses (business_id, bill_date);
CREATE INDEX ON expenses (business_id, vendor_id);

CREATE TABLE revenue_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('cash', 'other')),
  mode text NOT NULL DEFAULT 'cash' CHECK (mode IN ('cash', 'upi', 'card', 'other')),
  amount numeric(12, 2) NOT NULL CHECK (amount > 0),
  entry_date date NOT NULL,
  note text,
  via text NOT NULL DEFAULT 'app',       -- app | checkin | settlement | whatsapp
  file_id uuid,
  booking_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (business_id, id)
);
CREATE INDEX ON revenue_entries (business_id, entry_date);

CREATE TABLE recurring_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL,
  category text NOT NULL,
  typical_amount numeric(12, 2) NOT NULL,
  due_day int NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  next_due date NOT NULL,
  last_reminded_for date,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, vendor_id)
);

CREATE TABLE money_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  month text NOT NULL,                   -- YYYY-MM
  revenue jsonb NOT NULL,                -- {online, counter, cash, total}
  expenses jsonb NOT NULL,               -- {by category, total}
  profit numeric(12, 2) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, month)
);

-- Khata's settings: the end-of-day cash check-in time.
ALTER TABLE business_profiles ADD COLUMN khata_settings jsonb NOT NULL DEFAULT '{"checkin":true,"checkinTime":"21:00"}';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['files', 'snaps', 'expense_categories', 'vendors', 'expenses', 'revenue_entries', 'recurring_bills', 'money_snapshots'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (business_id = app_current_business()) WITH CHECK (business_id = app_current_business())', t);
  END LOOP;
END
$$;
GRANT SELECT, INSERT, UPDATE, DELETE ON files, snaps, expense_categories, vendors, expenses, revenue_entries, recurring_bills, money_snapshots TO orbit_app, orbit_admin;

-- Khata joins every Crew, on every plan (Free: up to 10 bills a month, monthly totals only).
ALTER TABLE agents DROP CONSTRAINT agents_agent_key_check;
ALTER TABLE agents ADD CONSTRAINT agents_agent_key_check CHECK (agent_key IN ('orbit', 'aria', 'vox', 'nudge', 'ledger', 'spark', 'khata'));
-- (Row-level security applies to migrations too, so each business is set in turn.)
DO $$
DECLARE b uuid;
BEGIN
  FOR b IN SELECT id FROM businesses LOOP
    PERFORM set_config('app.business_id', b::text, true);
    INSERT INTO agents (business_id, agent_key, display_name, personality, enabled)
    VALUES (b, 'khata', 'Khata', 'friendly', true) ON CONFLICT (business_id, agent_key) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.business_id', '', true);
END
$$;
UPDATE plans SET features = jsonb_set(features, '{agents}', (features->'agents') || '"khata"'::jsonb)
  WHERE NOT (features->'agents') ? 'khata';
UPDATE plans SET
  features = features || jsonb_build_object('khataLevel', CASE code WHEN 'free' THEN 'basic' WHEN 'plus' THEN 'plus' WHEN 'pro' THEN 'pro' ELSE 'business' END),
  limits = limits || jsonb_build_object('billsPerMonth', CASE code WHEN 'free' THEN to_jsonb(10) WHEN 'plus' THEN to_jsonb(50) ELSE 'null'::jsonb END)
  WHERE NOT features ? 'khataLevel';
