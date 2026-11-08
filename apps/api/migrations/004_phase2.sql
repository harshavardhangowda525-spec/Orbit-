-- 004: Phase 2 — chat, knowledge search, scheduled messages (Nudge), AI usage,
-- Powers OAuth, notifications, live activity.

-- Conversations: anonymous web visitors, email threads, takeover state.
ALTER TABLE conversations
  ADD COLUMN visitor_token_hash text,
  ADD COLUMN external_thread_id text,
  ADD COLUMN language text,
  ADD COLUMN ai_failures int NOT NULL DEFAULT 0,
  ADD COLUMN taken_over_by uuid REFERENCES users(id),
  ADD COLUMN subject text;
CREATE INDEX ON conversations (business_id, last_message_at DESC);
CREATE UNIQUE INDEX conversations_thread ON conversations (business_id, channel, external_thread_id) WHERE external_thread_id IS NOT NULL;

ALTER TABLE messages ADD COLUMN meta jsonb NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX messages_channel_id ON messages (business_id, channel_message_id) WHERE channel_message_id IS NOT NULL;

-- Knowledge: full-text search (pgvector embeddings are added once an embedding provider is chosen).
ALTER TABLE knowledge_items
  ADD COLUMN search tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, ''))) STORED;
CREATE INDEX knowledge_search ON knowledge_items USING gin (search);

-- Bookings: customer self-service link, notes.
ALTER TABLE bookings
  ADD COLUMN manage_token_hash text,
  ADD COLUMN customer_note text,
  ADD COLUMN cancelled_reason text;
CREATE UNIQUE INDEX bookings_manage_token ON bookings (manage_token_hash) WHERE manage_token_hash IS NOT NULL;

-- Feed rows show "{Agent} · {channel} · {time}".
ALTER TABLE feed_events ADD COLUMN channel text;

-- Live activity for the ticker and agent pings: what a running task is doing, as a Sentence.
ALTER TABLE tasks ADD COLUMN activity jsonb;
CREATE INDEX ON tasks (business_id, status, updated_at DESC);

-- Nudge outbox: every reminder / follow-up / greeting is a row here, sent by a delayed job.
CREATE TABLE scheduled_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  booking_id uuid,
  lead_id uuid,
  sequence_id uuid,
  step_index int NOT NULL DEFAULT 0,
  agent_key text NOT NULL DEFAULT 'nudge',
  kind text NOT NULL CHECK (kind IN ('reminder', 'follow_up', 'review_request', 'renewal', 'win_back', 'greeting', 'manual')),
  transactional boolean NOT NULL DEFAULT false,      -- booking reminders: exempt from the marketing contact cap
  preferred_channel text NOT NULL,
  channel text,                                      -- channel actually used
  template text NOT NULL,
  body text,                                         -- rendered text actually sent
  send_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sent', 'skipped', 'cancelled', 'failed')),
  skip_reason text,
  attempts int NOT NULL DEFAULT 0,
  sent_at timestamptz,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id),
  UNIQUE (business_id, idempotency_key),
  FOREIGN KEY (business_id, customer_id) REFERENCES customers(business_id, id),
  FOREIGN KEY (business_id, booking_id) REFERENCES bookings(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, lead_id) REFERENCES leads(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, sequence_id) REFERENCES sequences(business_id, id) ON DELETE SET NULL (sequence_id)
);
CREATE INDEX ON scheduled_messages (business_id, status, send_at);

-- AI usage per call, for billing, limits and cost per business and agent.
CREATE TABLE ai_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  agent_key text NOT NULL,
  model text NOT NULL,
  conversation_id uuid,
  task_id uuid,
  input_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  cache_read_tokens int NOT NULL DEFAULT 0,
  cache_write_tokens int NOT NULL DEFAULT 0,
  cost numeric(12, 6) NOT NULL DEFAULT 0,
  stop_reason text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  UNIQUE (business_id, id)
);
CREATE INDEX ON ai_usage (business_id, created_at);

-- Power accounts: provider-side ids and sync cursors.
ALTER TABLE power_connections
  ADD COLUMN external_account text,
  ADD COLUMN config jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN token_expires_at timestamptz;
CREATE UNIQUE INDEX power_one_active ON power_connections (business_id, power_type) WHERE status <> 'disconnected';

-- [platform] OAuth state for connecting Powers. Holds no tokens and no customer data.
CREATE TABLE oauth_states (
  state text PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  power_type text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Re-apply RLS to the new tenant tables (same loop as 003).
DO $$
DECLARE
  t text;
  platform_tables text[] := ARRAY['memberships', 'audit_log', 'oauth_states'];
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
