-- A release is an operator decision, not a replacement for the provider attempt's outcome.
ALTER TABLE receipt_attempts ADD COLUMN release_note text;
ALTER TABLE receipt_attempts ADD COLUMN released_at timestamptz;

-- Only the owner of the current circuit generation may settle its recovery probe.
ALTER TABLE model_circuits ADD COLUMN generation uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE model_circuits ADD COLUMN probe_token uuid;

-- Bound primary requests across workers; expired leases recover after a process crash.
CREATE TABLE model_primary_leases (
  token uuid PRIMARY KEY,
  provider_key text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX model_primary_leases_provider_idx ON model_primary_leases(provider_key, expires_at);
