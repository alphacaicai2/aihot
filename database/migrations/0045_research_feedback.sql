CREATE TABLE editorial_feedback (
  article_id text PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('missed', 'false_positive', 'duplicate', 'summary_error')),
  decision text NOT NULL CHECK (decision IN ('select', 'reject', 'either')),
  input_revision integer NOT NULL,
  sample jsonb NOT NULL,
  reason text NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE research_entities (
  name text PRIMARY KEY,
  aliases text[] NOT NULL,
  reviewed_by text NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now()
);
