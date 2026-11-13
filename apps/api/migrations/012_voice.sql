-- 012: Vox phone calls (Exotel + Sarvam).
ALTER TABLE calls
  ADD COLUMN call_sid text,
  ADD COLUMN conversation_id uuid,
  ADD COLUMN purpose text NOT NULL DEFAULT 'inbound' CHECK (purpose IN ('inbound', 'reminder', 'test')),
  ADD COLUMN status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('queued', 'in_progress', 'completed', 'failed', 'no_answer')),
  ADD COLUMN language text,
  ADD COLUMN script text,
  ADD COLUMN started_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN ended_at timestamptz,
  ADD CONSTRAINT calls_conversation_fk FOREIGN KEY (business_id, conversation_id) REFERENCES conversations(business_id, id) ON DELETE SET NULL (conversation_id);
CREATE UNIQUE INDEX calls_sid ON calls (business_id, call_sid) WHERE call_sid IS NOT NULL;
CREATE INDEX ON calls (business_id, started_at);
