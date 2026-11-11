-- 010: booking deposits and accounting sync.

-- Deposit for a service: a fixed amount, or (when empty) 25% of the price.
ALTER TABLE services ADD COLUMN deposit_amount numeric(12, 2) CHECK (deposit_amount IS NULL OR deposit_amount > 0);

-- Accounting sync (Zoho Books): the ids Orbit created there, so nothing is pushed twice.
ALTER TABLE invoices ADD COLUMN external_refs jsonb NOT NULL DEFAULT '{}';
ALTER TABLE customers ADD COLUMN external_refs jsonb NOT NULL DEFAULT '{}';
ALTER TABLE payments ADD COLUMN external_refs jsonb NOT NULL DEFAULT '{}';
