-- A queue handoff has its own generation; network attempts remain independently traceable.
ALTER TABLE deliveries ADD COLUMN dispatch_generation bigint NOT NULL DEFAULT 0;
ALTER TABLE deliveries ADD COLUMN content_at timestamptz;
CREATE TABLE delivery_attempts (
  delivery_id bigint NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  generation bigint NOT NULL,
  attempt integer,
  status text NOT NULL CHECK (status IN ('pending','sending','sent','failed','unknown','skipped')),
  payload jsonb,
  response text,
  late_response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY(delivery_id,generation)
);
