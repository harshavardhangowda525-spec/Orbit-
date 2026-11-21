-- 017: Khata keeps bills by month.
-- Every bill belongs to one month of the books (YYYY-MM): the month the owner adds it to
-- (by default the month they are looking at). Monthly totals and the bills list use this
-- month, not the date printed on the bill, so a misread or late bill never goes missing.
-- The printed bill date stays on the bill as a detail.

ALTER TABLE expenses ADD COLUMN books_month text CHECK (books_month ~ '^\d{4}-(0[1-9]|1[0-2])$');

-- Existing bills: the month they were added in (the business's own time zone).
-- (Row-level security applies to migrations too, so each business is set in turn.)
DO $$
DECLARE b record;
BEGIN
  FOR b IN SELECT id, timezone FROM businesses LOOP
    PERFORM set_config('app.business_id', b.id::text, true);
    UPDATE expenses SET books_month = to_char(created_at AT TIME ZONE b.timezone, 'YYYY-MM') WHERE books_month IS NULL;
  END LOOP;
  PERFORM set_config('app.business_id', '', true);
END
$$;

ALTER TABLE expenses ALTER COLUMN books_month SET NOT NULL;
-- Safety net for any insert that does not say: the current month (the app always sets it in the business's time zone).
ALTER TABLE expenses ALTER COLUMN books_month SET DEFAULT to_char(now(), 'YYYY-MM');
CREATE INDEX ON expenses (business_id, books_month);
