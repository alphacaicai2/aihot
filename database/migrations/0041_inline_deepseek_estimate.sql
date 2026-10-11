-- Same verified tariff as 0040. A single expression allows SQL-function inlining;
-- per-row SQL function dispatch made large historical admin summaries slow.
CREATE OR REPLACE FUNCTION estimate_deepseek_v41_flash(u jsonb, requested_at timestamptz) RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(u->'prompt_tokens') = 'number'
      AND jsonb_typeof(u->'completion_tokens') = 'number' THEN
    CASE WHEN (u->>'prompt_tokens')::numeric >= 0 AND (u->>'completion_tokens')::numeric >= 0 AND requested_at IS NOT NULL THEN
      ((u->>'prompt_tokens')::numeric * 0.30 - greatest(0, least((u->>'prompt_tokens')::numeric,
      CASE WHEN jsonb_typeof(u->'prompt_cache_hit_tokens') = 'number' THEN (u->>'prompt_cache_hit_tokens')::numeric
           WHEN jsonb_typeof(u#>'{prompt_tokens_details,cached_tokens}') = 'number' THEN (u#>>'{prompt_tokens_details,cached_tokens}')::numeric
           ELSE 0 END)) * 0.294
        + (u->>'completion_tokens')::numeric * 1.20) * CASE WHEN extract(isodow FROM requested_at AT TIME ZONE 'UTC') BETWEEN 1 AND 5
        AND ((requested_at AT TIME ZONE 'UTC')::time >= time '01:00' AND (requested_at AT TIME ZONE 'UTC')::time < time '04:00' OR (requested_at AT TIME ZONE 'UTC')::time >= time '06:00' AND (requested_at AT TIME ZONE 'UTC')::time < time '10:00')
        AND NOT ((requested_at AT TIME ZONE 'UTC')::date BETWEEN date '2026-01-01' AND date '2026-01-03'
          OR (requested_at AT TIME ZONE 'UTC')::date BETWEEN date '2026-02-15' AND date '2026-02-23'
          OR (requested_at AT TIME ZONE 'UTC')::date BETWEEN date '2026-04-04' AND date '2026-04-06'
          OR (requested_at AT TIME ZONE 'UTC')::date BETWEEN date '2026-05-01' AND date '2026-05-05'
          OR (requested_at AT TIME ZONE 'UTC')::date BETWEEN date '2026-06-19' AND date '2026-06-21'
          OR (requested_at AT TIME ZONE 'UTC')::date BETWEEN date '2026-09-25' AND date '2026-09-27'
          OR (requested_at AT TIME ZONE 'UTC')::date BETWEEN date '2026-10-01' AND date '2026-10-07')
        THEN 1 ELSE 0.5 END / 1000000
    END
  END
$$;
