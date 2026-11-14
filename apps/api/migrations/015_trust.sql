-- 015: Trust — the Undo window and "Why did you do that?".
--
-- held_actions: anything the Crew sends to customers or changes in bulk waits here
--   for a short hold (30 s single, 2 min bulk by default) so the owner can undo it.
-- decision_traces: the real reasons for every agent action, recorded when it happens
--   (structured reason codes and facts, never free text), so "Why?" never guesses.
-- trace_feedback / customer_exceptions: "Looks good", "Change this rule",
--   "Don't do this again for {customer}".
-- field_versions: settings and knowledge changes, undoable for 24 hours.

CREATE TABLE decision_traces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  agent_key text NOT NULL,
  task_id uuid,
  customer_id uuid,
  action jsonb NOT NULL,                 -- Sentence: what was done ("Nudge sent Rohan a reminder")
  trigger jsonb NOT NULL,                -- {kind: owner_command|sequence_rule|inbound_message|schedule|agent_request|owner_decision, text?, ref?}
  rule jsonb,                            -- {code, label (Sentence or plain name), setting (link)}
  facts jsonb NOT NULL DEFAULT '[]',     -- [{code, text: Sentence, ref?: {type, id}}]
  alternatives jsonb NOT NULL DEFAULT '[]',
  approver jsonb NOT NULL DEFAULT '{"kind":"not_needed"}',  -- {kind: owner|auto_rule|not_needed, name?}
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE INDEX ON decision_traces (business_id, created_at DESC);
CREATE INDEX ON decision_traces (business_id, (rule->>'code'));

ALTER TABLE feed_events ADD COLUMN trace_id uuid;
ALTER TABLE approval_cards ADD COLUMN trace_id uuid;
ALTER TABLE scheduled_messages ADD COLUMN trace_id uuid;

CREATE TABLE held_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  task_id uuid,
  agent_key text NOT NULL,
  action_type text NOT NULL CHECK (action_type IN ('message', 'bulk_message', 'booking_change', 'calls')),
  summary jsonb NOT NULL,                -- Sentence shown in the undo bar
  payload jsonb NOT NULL,
  audience int NOT NULL DEFAULT 1,
  hold_until timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'holding' CHECK (status IN ('holding', 'executing', 'executed', 'cancelled', 'failed')),
  cancelled_by uuid,
  cancelled_via text,                    -- app | whatsapp
  cancelled_at timestamptz,
  executed_at timestamptz,
  result jsonb,
  error text,
  trace_id uuid,
  correction_card_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE INDEX ON held_actions (business_id, status, hold_until);

CREATE TABLE trace_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  trace_id uuid NOT NULL,
  agent_key text NOT NULL,
  rule_code text,
  verdict text NOT NULL CHECK (verdict IN ('good', 'change_rule', 'exception')),
  user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, trace_id, user_id, verdict)
);
CREATE INDEX ON trace_feedback (rule_code);

CREATE TABLE customer_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  action_code text NOT NULL,             -- the rule code it applies to, e.g. nudge.renewal
  trace_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, customer_id, action_code)
);

CREATE TABLE field_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  entity_type text NOT NULL,             -- agent | knowledge_item | profile
  entity_id text NOT NULL,
  label jsonb NOT NULL,                  -- Sentence describing the change
  before jsonb,                          -- null when the change created the thing
  after jsonb,
  source text NOT NULL DEFAULT 'settings',  -- settings | teach
  changed_by uuid,
  undo_until timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  reverted_at timestamptz,
  reverted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON field_versions (business_id, created_at DESC);

-- Safety settings: hold seconds per action type (0–300) and "review before sending" per channel for Aria.
ALTER TABLE business_profiles
  ADD COLUMN hold_seconds jsonb NOT NULL DEFAULT '{"message":30,"booking_change":30,"bulk_message":120,"calls":120}',
  ADD COLUMN review_before_send jsonb NOT NULL DEFAULT '{}';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['decision_traces', 'held_actions', 'trace_feedback', 'customer_exceptions', 'field_versions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (business_id = app_current_business()) WITH CHECK (business_id = app_current_business())', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON decision_traces, held_actions, trace_feedback, customer_exceptions, field_versions TO orbit_app, orbit_admin;
