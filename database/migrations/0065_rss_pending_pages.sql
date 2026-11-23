-- Only outstanding pages of oversized native RSS/Atom responses. The source cursor holds
-- their fetch id and next page, so collection can finish even if the upstream feed rotates.
CREATE TABLE source_rss_pages (
  source_id text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  fetch_id bigint NOT NULL,
  page integer NOT NULL,
  entries jsonb NOT NULL,
  PRIMARY KEY (source_id, fetch_id, page)
);
