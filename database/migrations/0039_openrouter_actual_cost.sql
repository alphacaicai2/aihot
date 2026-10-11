-- Preserve sub-micro-dollar charges before summing many short model requests.
ALTER TABLE receipts ALTER COLUMN cost TYPE numeric(20, 12);
ALTER TABLE receipt_attempts ALTER COLUMN cost TYPE numeric(20, 12);

-- This provider-qualified model was introduced with the OpenRouter route. Its saved usage.cost
-- is the account charge in USD, including for a billed answer the application could not use.
-- Each attempt has its own charge; a receipt keeps only the latest attempt's result.
UPDATE receipts
SET cost = (usage->>'cost')::numeric, currency = 'USD', cost_basis = 'actual'
WHERE service = 'llm' AND model = 'qwen/qwen3.7-flash' AND origin = 'live' AND cost IS NULL
  AND CASE WHEN jsonb_typeof(usage->'cost') = 'number' THEN (usage->>'cost')::numeric >= 0 ELSE false END;

UPDATE receipt_attempts
SET cost = (usage->>'cost')::numeric, currency = 'USD', cost_basis = 'actual'
WHERE service = 'llm' AND model = 'qwen/qwen3.7-flash' AND origin = 'live' AND cost IS NULL
  AND CASE WHEN jsonb_typeof(usage->'cost') = 'number' THEN (usage->>'cost')::numeric >= 0 ELSE false END;
