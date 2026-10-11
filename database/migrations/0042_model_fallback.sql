-- A failed model step chooses its fallback durably. Recovery reuses that choice even if the
-- original unknown receipt is later released; it never buys the original answer again.
CREATE TABLE model_fallback_routes (
  primary_key text PRIMARY KEY,
  fallback_model text NOT NULL,
  primary_receipt_id bigint REFERENCES receipts(id),
  fallback_receipt_id bigint REFERENCES receipts(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_fallback_primary_receipt_idx ON model_fallback_routes(primary_receipt_id);
CREATE INDEX model_fallback_receipt_idx ON model_fallback_routes(fallback_receipt_id);

-- Shared by API/worker processes: repeated transport failures bypass the primary briefly.
CREATE TABLE model_circuits (
  provider_key text PRIMARY KEY,
  failures integer NOT NULL DEFAULT 0,
  open_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
