-- A content job owns one revision and one processing handoff. New queues/manual evaluations
-- supersede older jobs even when the article's content revision is unchanged.
ALTER TABLE articles ADD COLUMN processing_generation integer NOT NULL DEFAULT 0 CHECK (processing_generation >= 0);

-- Retain obsolete paid answers for audit without letting a later publication or grouping read
-- mistake an out-of-order judgement for the currently applied result.
ALTER TABLE analyses ADD COLUMN superseded boolean NOT NULL DEFAULT false;
