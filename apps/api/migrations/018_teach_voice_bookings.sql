-- 018: Teach Orbit by talking, voice notes, and natural booking changes.

-- Teach: one instruction from the owner ("closed Tuesdays from next week"), turned into a
-- previewed change set. Nothing changes until it is confirmed; each applied change is a
-- field_version, so the whole teach can be undone.
CREATE TABLE teach_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL DEFAULT app_current_business() REFERENCES businesses(id) ON DELETE CASCADE,
  text text NOT NULL,
  source text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'voice', 'knowledge', 'whatsapp')),
  status text NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'question', 'needs_owner', 'applied', 'cancelled', 'not_teach')),
  question text,
  changes jsonb NOT NULL DEFAULT '[]',
  affected jsonb NOT NULL DEFAULT '[]',
  conflicts jsonb NOT NULL DEFAULT '[]',
  version_ids uuid[] NOT NULL DEFAULT '{}',
  card_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  UNIQUE (business_id, id)
);
CREATE INDEX ON teach_requests (business_id, created_at DESC);

-- Agent rules taught by the owner, checked by the agents (not just prompt text),
-- e.g. {"maxDiscountPct": 10}.
ALTER TABLE business_profiles
  ADD COLUMN guardrails jsonb NOT NULL DEFAULT '{}',
  -- Weekly hours that start on a later date: [{"from": "YYYY-MM-DD", "hours": WeeklyHours}].
  ADD COLUMN hours_changes jsonb NOT NULL DEFAULT '[]',
  -- Booking changes: free cancellation window, how long to wait before a no-show check-in.
  ADD COLUMN booking_policy jsonb NOT NULL DEFAULT '{"freeCancelHours":4,"noShowCheckMin":15}';

-- Natural booking changes.
ALTER TABLE bookings
  ADD COLUMN late_minutes int NOT NULL DEFAULT 0 CHECK (late_minutes BETWEEN 0 AND 240),
  ADD COLUMN customer_confirmed_at timestamptz,
  ADD COLUMN noshow_checked_at timestamptz,
  ADD COLUMN add_ons jsonb NOT NULL DEFAULT '[]';
ALTER TABLE waitlist_entries
  ADD COLUMN wanted_date date,
  ADD COLUMN offered_booking_slot timestamptz,
  ADD COLUMN offered_at timestamptz;

ALTER TABLE teach_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE teach_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON teach_requests USING (business_id = app_current_business()) WITH CHECK (business_id = app_current_business());
GRANT SELECT, INSERT, UPDATE, DELETE ON teach_requests TO orbit_app, orbit_admin;
