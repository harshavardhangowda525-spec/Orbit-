-- 002: business-owned (tenant) tables — the full data model from the spec.
--
-- Every table here:
--   * has business_id NOT NULL, defaulting to the business set on the current
--     transaction (app.business_id), so inserts are automatically scoped;
--   * has UNIQUE (business_id, id) so child rows reference parents with
--     COMPOSITE foreign keys (business_id, parent_id). A row can therefore never
--     point at another business's row, even through a code bug;
--   * gets Row-Level Security in 003.

-- The business the current transaction acts for. NULL when unset, which makes
-- every RLS policy match nothing (fail closed).
CREATE OR REPLACE FUNCTION app_current_business() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.business_id', true), '')::uuid
$$;

-- ---------- Profile & setup ----------
CREATE TABLE business_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  address text, city text, postal_code text,
  geo_lat double precision, geo_lng double precision,
  phone text, whatsapp text, email text, website text,
  hours jsonb NOT NULL DEFAULT '{}',          -- WeeklyHours
  holidays jsonb NOT NULL DEFAULT '[]',
  description text,
  photos jsonb NOT NULL DEFAULT '[]',
  social_links jsonb NOT NULL DEFAULT '{}',
  gstin text,
  policies jsonb NOT NULL DEFAULT '{}',       -- cancellation, refunds
  quiet_hours jsonb NOT NULL DEFAULT '{"from":"21:00","to":"09:00"}',
  contact_cap_per_week int NOT NULL DEFAULT 3,
  import_source jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id),
  UNIQUE (business_id)                         -- one profile per business
);

CREATE TABLE locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL, address text, phone text,
  hours jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  deleted_at timestamptz,
  UNIQUE (business_id, id)
);

CREATE TABLE power_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  power_type text NOT NULL,
  account_label text,
  encrypted_tokens bytea,                      -- AES-256-GCM, key from secrets manager
  scopes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'error', 'disconnected')),
  status_detail text,
  connected_by uuid,
  last_sync_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id)
);

CREATE TABLE staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id),
  name text NOT NULL,
  role text,
  working_hours jsonb,                         -- null = business hours
  leave jsonb NOT NULL DEFAULT '[]',
  calendar_connection_id uuid,
  location_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  deleted_at timestamptz,
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES locations(business_id, id),
  FOREIGN KEY (business_id, calendar_connection_id) REFERENCES power_connections(business_id, id)
);

CREATE TABLE services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  duration_min int NOT NULL CHECK (duration_min >= 0),
  price numeric(12, 2) CHECK (price IS NULL OR price >= 0),  -- NULL = "price on request"
  buffer_before_min int NOT NULL DEFAULT 0,
  buffer_after_min int NOT NULL DEFAULT 0,
  category text,
  staff_ids uuid[] NOT NULL DEFAULT '{}',
  renewal_interval_days int,
  deposit_required boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  deleted_at timestamptz,
  UNIQUE (business_id, id)
);

CREATE TABLE knowledge_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('faq', 'policy', 'document', 'price_list', 'note')),
  title text NOT NULL,
  content text NOT NULL,
  source text,
  embedding vector(1536),
  language text NOT NULL DEFAULT 'en',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  deleted_at timestamptz,
  UNIQUE (business_id, id)
);

-- ---------- Customers & conversations ----------
CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  name text, phone text, email citext,
  language text,
  tags text[] NOT NULL DEFAULT '{}',
  source text,
  birthday date,
  notes text,
  lifetime_spend numeric(12, 2) NOT NULL DEFAULT 0,
  visit_count int NOT NULL DEFAULT 0,
  last_visit_at timestamptz,
  consent jsonb NOT NULL DEFAULT '{}',         -- {"whatsapp":true,"sms":false,"email":true,"calls":true,"marketing":false}
  opted_out_at jsonb NOT NULL DEFAULT '{}',    -- {"whatsapp":"2026-01-01T..."}
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  deleted_at timestamptz,
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX customers_phone_per_business ON customers (business_id, phone) WHERE phone IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX ON customers (business_id, email);

CREATE TABLE leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  interest text,
  service_id uuid,
  source_channel text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'qualified', 'booked', 'lost')),
  lost_reason text,
  assigned_agent text,
  answers jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, customer_id) REFERENCES customers(business_id, id),
  FOREIGN KEY (business_id, service_id) REFERENCES services(business_id, id)
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id uuid,
  channel text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting_customer', 'waiting_staff', 'closed')),
  handled_by text NOT NULL DEFAULT 'aria',     -- agent key or 'user:<uuid>'
  summary text,
  sentiment text,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, customer_id) REFERENCES customers(business_id, id)
);
CREATE INDEX ON conversations (business_id, status);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  sender text NOT NULL,                         -- customer | aria | user:<uuid> ...
  body text,
  attachments jsonb NOT NULL DEFAULT '[]',
  channel_message_id text,
  delivery_status text,
  language text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, conversation_id) REFERENCES conversations(business_id, id) ON DELETE CASCADE
);
CREATE INDEX ON messages (business_id, conversation_id, created_at);

CREATE TABLE calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id uuid,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  from_number text, to_number text,
  duration_sec int,
  recording_url text,
  transcript text,
  summary text,
  outcome text,
  minutes_billed int NOT NULL DEFAULT 0,
  handled_by text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, customer_id) REFERENCES customers(business_id, id)
);

-- ---------- Bookings ----------
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  invoice_id uuid,
  provider text,
  provider_ref text,
  amount numeric(12, 2) NOT NULL,
  method text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id)
);
CREATE INDEX ON payments (business_id, paid_at);

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id uuid,
  service_id uuid,
  staff_id uuid,
  location_id uuid,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending', 'confirmed', 'completed', 'cancelled', 'no_show')),
  source text,                                  -- aria:whatsapp, owner, booking_page ...
  price numeric(12, 2),
  deposit_payment_id uuid,
  meeting_link text,
  external_calendar_event_id text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  deleted_at timestamptz,
  UNIQUE (business_id, id),
  CHECK (end_at > start_at),
  FOREIGN KEY (business_id, customer_id) REFERENCES customers(business_id, id),
  FOREIGN KEY (business_id, service_id) REFERENCES services(business_id, id),
  FOREIGN KEY (business_id, staff_id) REFERENCES staff(business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES locations(business_id, id),
  FOREIGN KEY (business_id, deposit_payment_id) REFERENCES payments(business_id, id),
  -- Double booking is impossible at the database level: one staff member cannot
  -- have two active bookings that overlap in time.
  EXCLUDE USING gist (
    business_id WITH =, staff_id WITH =, tstzrange(start_at, end_at) WITH &&
  ) WHERE (staff_id IS NOT NULL AND status IN ('pending', 'confirmed') AND deleted_at IS NULL)
);
CREATE INDEX ON bookings (business_id, start_at);

CREATE TABLE waitlist_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  service_id uuid,
  preferred_times jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'offered', 'booked', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, customer_id) REFERENCES customers(business_id, id),
  FOREIGN KEY (business_id, service_id) REFERENCES services(business_id, id)
);

-- ---------- Retention ----------
CREATE TABLE sequences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  trigger text NOT NULL,
  steps jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  owner_agent text NOT NULL DEFAULT 'nudge',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id)
);

CREATE TABLE sequence_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  sequence_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  current_step int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'stopped', 'done')),
  next_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, sequence_id) REFERENCES sequences(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, customer_id) REFERENCES customers(business_id, id)
);
CREATE INDEX ON sequence_runs (status, next_run_at);

-- ---------- Crew: agents, tasks, approvals, feed ----------
CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  agent_key text NOT NULL CHECK (agent_key IN ('orbit', 'aria', 'vox', 'nudge', 'ledger', 'spark')),
  display_name text NOT NULL,
  personality text NOT NULL DEFAULT 'friendly' CHECK (personality IN ('formal', 'friendly', 'energetic')),
  voice text,
  working_hours jsonb,
  enabled boolean NOT NULL DEFAULT true,
  auto_approval_rules jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id),
  UNIQUE (business_id, agent_key)
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  agent_key text NOT NULL,
  parent_task_id uuid,
  created_by_kind text NOT NULL CHECK (created_by_kind IN ('owner', 'orbit', 'agent_request', 'schedule', 'system')),
  goal text NOT NULL,
  inputs jsonb NOT NULL DEFAULT '{}',
  plan jsonb,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'waiting_approval', 'waiting_customer', 'done', 'failed', 'cancelled')),
  result jsonb,
  error text,
  attempts int NOT NULL DEFAULT 0,
  cost numeric(12, 4) NOT NULL DEFAULT 0,
  idempotency_key text,
  started_at timestamptz, finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id),
  UNIQUE (business_id, idempotency_key),
  FOREIGN KEY (business_id, parent_task_id) REFERENCES tasks(business_id, id)
);
CREATE INDEX ON tasks (business_id, status);

CREATE TABLE approval_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  task_id uuid,
  agent_key text NOT NULL,
  type text NOT NULL,                            -- discount, campaign, review_reply, handover, unknown_answer ...
  title jsonb NOT NULL,                          -- Sentence {key, params}
  context jsonb NOT NULL DEFAULT '{}',
  suggested_action jsonb NOT NULL DEFAULT '{}',
  options jsonb NOT NULL,                        -- [{"key":"yes","label":"card.option.yes","style":"primary"}]
  default_option text NOT NULL DEFAULT 'no',     -- applied safely on expiry ("don't send")
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'edited', 'expired')),
  decision text,
  decided_by uuid,
  decided_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, task_id) REFERENCES tasks(business_id, id)
);
CREATE INDEX ON approval_cards (business_id, status);

CREATE TABLE feed_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  agent_key text NOT NULL,
  event_type text NOT NULL,
  sentence jsonb NOT NULL,                      -- Sentence {key, params}; rendered in the viewer's language
  entity_type text,
  entity_id uuid,
  value_amount numeric(12, 2) NOT NULL DEFAULT 0,  -- counts towards Orbit Earnings
  minutes_saved int NOT NULL DEFAULT 0,
  at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id)
);
CREATE INDEX ON feed_events (business_id, at DESC);

CREATE TABLE contact_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  channel text NOT NULL,
  agent_key text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, customer_id) REFERENCES customers(business_id, id)
);
CREATE INDEX ON contact_log (business_id, customer_id, at DESC);

CREATE TABLE briefings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  date date NOT NULL,
  type text NOT NULL CHECK (type IN ('morning', 'evening', 'weekly', 'monthly')),
  content jsonb NOT NULL,
  sent_via text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id),
  UNIQUE (business_id, date, type)
);

CREATE TABLE pulse_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  score int NOT NULL CHECK (score BETWEEN 0 AND 100),
  explanation jsonb NOT NULL,
  inputs jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id)
);

CREATE TABLE usage_counters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  period text NOT NULL,                          -- "2026-11"
  ai_messages int NOT NULL DEFAULT 0,
  call_minutes int NOT NULL DEFAULT 0,
  tasks int NOT NULL DEFAULT 0,
  campaigns_sent int NOT NULL DEFAULT 0,
  storage_bytes bigint NOT NULL DEFAULT 0,
  ai_cost numeric(12, 4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id),
  UNIQUE (business_id, period)
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id),
  type text NOT NULL,
  title jsonb NOT NULL,
  body jsonb,
  link text,
  read_at timestamptz,
  channels_sent text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id)
);

-- ---------- Money, marketing, operations (used from Phase 3+, isolated from day one) ----------
CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id uuid,
  booking_id uuid,
  number text NOT NULL,
  line_items jsonb NOT NULL DEFAULT '[]',
  tax jsonb NOT NULL DEFAULT '{}',
  total numeric(12, 2) NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'overdue', 'cancelled')),
  due_at timestamptz,
  pdf_url text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id),
  UNIQUE (business_id, number),
  FOREIGN KEY (business_id, customer_id) REFERENCES customers(business_id, id),
  FOREIGN KEY (business_id, booking_id) REFERENCES bookings(business_id, id)
);
ALTER TABLE payments ADD FOREIGN KEY (business_id, invoice_id) REFERENCES invoices(business_id, id);

CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  segment jsonb NOT NULL DEFAULT '{}',
  channels text[] NOT NULL DEFAULT '{}',
  content jsonb NOT NULL DEFAULT '{}',
  scheduled_at timestamptz,
  status text NOT NULL DEFAULT 'draft',
  approval_card_id uuid,
  stats jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, approval_card_id) REFERENCES approval_cards(business_id, id)
);

CREATE TABLE offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  code text NOT NULL,
  discount_type text NOT NULL CHECK (discount_type IN ('percent', 'amount')),
  value numeric(12, 2) NOT NULL,
  valid_from timestamptz, valid_to timestamptz,
  usage_limit int, uses int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id),
  UNIQUE (business_id, code)
);

CREATE TABLE reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  platform text NOT NULL,
  author text,
  rating int CHECK (rating BETWEEN 1 AND 5),
  text text,
  reply text,
  replied_at timestamptz,
  flagged boolean NOT NULL DEFAULT false,
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id)
);

CREATE TABLE loyalty_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  points_delta int NOT NULL,
  reason text,
  balance_after int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, customer_id) REFERENCES customers(business_id, id)
);

CREATE TABLE referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  referrer_customer_id uuid NOT NULL,
  referred_customer_id uuid NOT NULL,
  reward_status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, referrer_customer_id) REFERENCES customers(business_id, id),
  FOREIGN KEY (business_id, referred_customer_id) REFERENCES customers(business_id, id)
);

CREATE TABLE inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  quantity numeric(12, 2) NOT NULL DEFAULT 0,
  unit text,
  low_stock_threshold numeric(12, 2),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  deleted_at timestamptz,
  UNIQUE (business_id, id)
);

CREATE TABLE staff_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  title text NOT NULL,
  assignee_staff_id uuid,
  due_at timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, assignee_staff_id) REFERENCES staff(business_id, id)
);

CREATE TABLE expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  amount numeric(12, 2) NOT NULL,
  category text,
  note text,
  date date NOT NULL DEFAULT current_date,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id)
);
