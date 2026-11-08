-- 006: sign-in codes go by email (SMS sign-in removed).
ALTER TABLE otp_codes ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE otp_codes ADD COLUMN email citext;
CREATE INDEX ON otp_codes (email, created_at DESC);
