-- Operator-confirmed billing is independent of the provider response/outcome.
-- Do not manufacture provider usage, a response, or completion when confirming a zero charge.
ALTER TABLE receipts ADD COLUMN billing_review jsonb
  CHECK (billing_review IS NULL OR jsonb_typeof(billing_review) = 'object');
