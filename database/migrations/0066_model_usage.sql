-- Keep receipt labels and attempt metrics separate. Each mirrors one source row in the
-- same transaction, including corrections made after the day on which an attempt started.
CREATE TABLE model_usage_receipts (
  id bigint PRIMARY KEY, purpose text, prompt_version text, score_slot integer
);
CREATE TABLE model_usage_attempts (
  id bigint PRIMARY KEY, receipt_id bigint NOT NULL, started_at timestamptz NOT NULL,
  service text NOT NULL, model text NOT NULL, status text NOT NULL, latency_ms integer,
  tokens_in text, tokens_out text, actual_cost numeric, currency text, official_estimate numeric
);
-- The SQL functions inline for the live fallback and for ID-bounded backfill batches.
CREATE FUNCTION model_usage_receipt_source() RETURNS SETOF model_usage_receipts LANGUAGE sql STABLE PARALLEL SAFE AS $$
SELECT id, purpose, request->>'promptVersion' AS prompt_version,
       CASE WHEN purpose='score_article' THEN CASE WHEN logical_key LIKE '%:score-2' THEN 2 ELSE 1 END END AS score_slot
FROM receipts;
$$;
CREATE FUNCTION model_usage_attempt_source() RETURNS SETOF model_usage_attempts LANGUAGE sql STABLE PARALLEL SAFE AS $$
SELECT id, receipt_id, started_at, service, model, status, latency_ms,
       usage->>'prompt_tokens' AS tokens_in, usage->>'completion_tokens' AS tokens_out,
       CASE WHEN cost_basis='actual' THEN cost END AS actual_cost, currency,
       CASE WHEN model IN ('deepseek-v4.1-flash','deepseek-flash')
            THEN estimate_deepseek_v41_flash_cny(usage, started_at) END AS official_estimate
FROM receipt_attempts WHERE origin='live' AND model IS NOT NULL;
$$;
CREATE INDEX model_usage_attempts_time ON model_usage_attempts (started_at);

-- No historical source row is changed or copied under the migration's DDL locks.
CREATE TABLE model_usage_backfill (
  source text PRIMARY KEY CHECK (source IN ('receipts','attempts')),
  last_id bigint,
  complete boolean NOT NULL DEFAULT false
);
INSERT INTO model_usage_backfill (source) VALUES ('receipts'), ('attempts');

-- Most writes upsert the new value. The backfill only inserts missing IDs. Deletes
-- and changes of eligibility must also serialize with a batch that saw the old row:
-- lock the small progress row, never the historical receipt or attempt.
CREATE FUNCTION sync_model_usage_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND (TG_OP='DELETE' OR OLD.id<>NEW.id) THEN
    PERFORM 1 FROM model_usage_backfill WHERE source='receipts' AND NOT complete FOR SHARE;
    DELETE FROM model_usage_receipts WHERE id=OLD.id;
  END IF;
  IF TG_OP='DELETE' THEN RETURN NULL; END IF;
  INSERT INTO model_usage_receipts SELECT * FROM model_usage_receipt_source() WHERE id=NEW.id
  ON CONFLICT (id) DO UPDATE SET (purpose,prompt_version,score_slot) =
    (EXCLUDED.purpose,EXCLUDED.prompt_version,EXCLUDED.score_slot);
  RETURN NULL;
END $$;
CREATE TRIGGER model_usage_receipt AFTER INSERT OR DELETE OR UPDATE OF id,purpose,request,logical_key ON receipts
FOR EACH ROW EXECUTE FUNCTION sync_model_usage_receipt();

CREATE FUNCTION sync_model_usage_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND (TG_OP='DELETE' OR OLD.id<>NEW.id OR NEW.origin<>'live' OR NEW.model IS NULL) THEN
    PERFORM 1 FROM model_usage_backfill WHERE source='attempts' AND NOT complete FOR SHARE;
    DELETE FROM model_usage_attempts WHERE id=OLD.id;
  END IF;
  IF TG_OP<>'DELETE' AND NEW.origin='live' AND NEW.model IS NOT NULL THEN
    INSERT INTO model_usage_attempts SELECT * FROM model_usage_attempt_source() WHERE id=NEW.id
    ON CONFLICT (id) DO UPDATE SET
      (receipt_id,started_at,service,model,status,latency_ms,tokens_in,tokens_out,actual_cost,currency,official_estimate) =
      (EXCLUDED.receipt_id,EXCLUDED.started_at,EXCLUDED.service,EXCLUDED.model,EXCLUDED.status,EXCLUDED.latency_ms,
       EXCLUDED.tokens_in,EXCLUDED.tokens_out,EXCLUDED.actual_cost,EXCLUDED.currency,EXCLUDED.official_estimate);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER model_usage_attempt AFTER INSERT OR DELETE OR UPDATE ON receipt_attempts FOR EACH ROW EXECUTE FUNCTION sync_model_usage_attempt();

CREATE FUNCTION truncate_model_usage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='receipts' THEN TRUNCATE model_usage_receipts;
  ELSE TRUNCATE model_usage_attempts;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER model_usage_receipt_truncate AFTER TRUNCATE ON receipts EXECUTE FUNCTION truncate_model_usage();
CREATE TRIGGER model_usage_attempt_truncate AFTER TRUNCATE ON receipt_attempts EXECUTE FUNCTION truncate_model_usage();
