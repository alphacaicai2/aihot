-- Keep the original extraction intact. One passage may substantiate several named
-- rounds without stating an individual amount for any of them.
CREATE TABLE financing_claim_reviews (
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  company text NOT NULL,
  evidence text NOT NULL,
  part integer NOT NULL CHECK (part > 0),
  original_claim jsonb NOT NULL,
  claim jsonb NOT NULL,
  round_id uuid NOT NULL,
  reason text NOT NULL DEFAULT '',
  listed boolean NOT NULL DEFAULT true,
  preferred boolean NOT NULL DEFAULT false,
  PRIMARY KEY (article_id, company, evidence, part)
);
