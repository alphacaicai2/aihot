-- A reviewed identity belongs to the quoted transaction, not the entire article.
-- New analysis or reordered roundup entries retain the decision only for matching evidence.
CREATE TABLE financing_round_sources (
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  company text NOT NULL,
  evidence text NOT NULL,
  round_id uuid NOT NULL,
  PRIMARY KEY (article_id, company, evidence),
  UNIQUE (round_id, article_id)
);
