-- Keep batch membership and model input stable across worker restarts and receipt reuse.
CREATE TABLE financing_extraction_batches (
  id bigserial PRIMARY KEY,
  material jsonb NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  next_run timestamptz NOT NULL DEFAULT now(),
  last_error text,
  finished_at timestamptz
);
CREATE INDEX financing_extraction_due ON financing_extraction_batches(next_run, id) WHERE finished_at IS NULL;
