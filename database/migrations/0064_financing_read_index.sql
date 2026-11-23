-- Built from the public read model. A dirty index is never used to serve readers.
CREATE TABLE financing_index_state (
  singleton boolean PRIMARY KEY CHECK (singleton),
  built_at timestamptz,
  valid_until timestamptz
);
INSERT INTO financing_index_state(singleton) VALUES (true);

CREATE TABLE financing_index_members (
  article_id text NOT NULL,
  seq bigint NOT NULL,
  round_id text COLLATE "C" NOT NULL,
  timeline_at timestamptz NOT NULL,
  reported_at timestamptz,
  preferred boolean,
  claim jsonb NOT NULL,
  PRIMARY KEY (article_id, seq)
);
CREATE INDEX financing_index_round ON financing_index_members(round_id);
CREATE INDEX financing_index_company ON financing_index_members(lower(btrim(claim->>'company')));
CREATE INDEX financing_index_timeline ON financing_index_members(timeline_at DESC);

-- A writer only logs its own changed articles. The indexer consumes the changes visible
-- in its repeatable-read snapshot; a write that commits during a rebuild remains pending.
CREATE TABLE financing_index_changes (
  writer xid8 NOT NULL DEFAULT pg_current_xact_id(),
  article_id text NOT NULL,
  PRIMARY KEY (writer, article_id)
);
CREATE FUNCTION record_financing_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    INSERT INTO financing_index_changes(article_id) VALUES ('') ON CONFLICT DO NOTHING;
  ELSE
    IF TG_OP <> 'INSERT' THEN
      INSERT INTO financing_index_changes(article_id) VALUES (OLD.article_id) ON CONFLICT DO NOTHING;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      INSERT INTO financing_index_changes(article_id) VALUES (NEW.article_id) ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER financing_publication_added_removed AFTER INSERT OR DELETE ON publications
  FOR EACH ROW EXECUTE FUNCTION record_financing_change();
CREATE TRIGGER financing_publication_changed AFTER UPDATE ON publications FOR EACH ROW
  WHEN ((OLD.article_id, OLD.analysis_id, OLD.visibility, OLD.eligible, OLD.selected, OLD.visible_after,
         OLD.category, OLD.timeline_at, OLD.published_at) IS DISTINCT FROM
        (NEW.article_id, NEW.analysis_id, NEW.visibility, NEW.eligible, NEW.selected, NEW.visible_after,
         NEW.category, NEW.timeline_at, NEW.published_at)) EXECUTE FUNCTION record_financing_change();

CREATE TRIGGER financing_analysis_added AFTER INSERT ON analyses FOR EACH ROW
  WHEN (NEW.output ?| ARRAY['financingClaims','financing']) EXECUTE FUNCTION record_financing_change();
CREATE TRIGGER financing_analysis_removed AFTER DELETE ON analyses FOR EACH ROW
  WHEN (OLD.output ?| ARRAY['financingClaims','financing']) EXECUTE FUNCTION record_financing_change();
CREATE TRIGGER financing_analysis_changed AFTER UPDATE ON analyses FOR EACH ROW
  WHEN ((OLD.output->'financingClaims', OLD.output->'financing', OLD.article_id, OLD.id) IS DISTINCT FROM
        (NEW.output->'financingClaims', NEW.output->'financing', NEW.article_id, NEW.id))
  EXECUTE FUNCTION record_financing_change();

CREATE TRIGGER financing_review_changed AFTER INSERT OR UPDATE OR DELETE ON financing_claim_reviews
  FOR EACH ROW EXECUTE FUNCTION record_financing_change();
CREATE TRIGGER financing_round_changed AFTER INSERT OR UPDATE OR DELETE ON financing_round_sources
  FOR EACH ROW EXECUTE FUNCTION record_financing_change();
CREATE TRIGGER financing_reviews_cleared AFTER TRUNCATE ON financing_claim_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION record_financing_change();
CREATE TRIGGER financing_rounds_cleared AFTER TRUNCATE ON financing_round_sources
  FOR EACH STATEMENT EXECUTE FUNCTION record_financing_change();
CREATE TRIGGER financing_publications_cleared AFTER TRUNCATE ON publications
  FOR EACH STATEMENT EXECUTE FUNCTION record_financing_change();
CREATE TRIGGER financing_analyses_cleared AFTER TRUNCATE ON analyses
  FOR EACH STATEMENT EXECUTE FUNCTION record_financing_change();
