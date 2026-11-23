-- Financing queries include reviewed aliases when the site's research tools have supplied them.
-- Existing production installations already contain this table.
CREATE TABLE IF NOT EXISTS research_entities (
  name text PRIMARY KEY,
  aliases text[] NOT NULL,
  reviewed_by text NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now()
);
