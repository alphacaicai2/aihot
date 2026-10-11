-- Official V4.1 Flash USD rates, verified 2026-10-11:
-- https://api-docs.deepseek.com/quick_start/pricing/
-- Peak: cache miss $0.30, cache hit $0.006, output $1.20 / million tokens.
-- Off-peak: half price. Mon-Fri 01:00-04:00 and 06:00-10:00 UTC are peak,
-- excluding Chinese public holidays; weekends remain off-peak even on makeup workdays.
-- Holiday calendar: https://www.beijing.gov.cn/cs/gncs/zcwj/202603/t20260327_4568275.html
-- Keep the verified tariff and holiday calendar current when official rules change.
INSERT INTO service_prices (service, model, currency, input_per_mtok, cached_per_mtok, output_per_mtok, source_url, verified_on, note)
SELECT service, model, 'USD', 0.30, 0.006, 1.20, 'https://api-docs.deepseek.com/quick_start/pricing/', '2026-10-11',
       'DeepSeek 官方估算：缓存命中单独计价，按请求时间分峰谷（闲时半价），含 2026 中国节假日；缓存数据缺失按未命中算。'
FROM (VALUES ('llm', 'deepseek-v4.1-flash'), ('deepseek', 'deepseek-flash')) AS models(service, model)
ON CONFLICT (service, model) DO UPDATE SET currency = EXCLUDED.currency, input_per_mtok = EXCLUDED.input_per_mtok,
  cached_per_mtok = EXCLUDED.cached_per_mtok, output_per_mtok = EXCLUDED.output_per_mtok,
  source_url = EXCLUDED.source_url, verified_on = EXCLUDED.verified_on, note = EXCLUDED.note, updated_at = now();

-- Read-time estimate: historical usage is valued at this verified tariff, never rewritten as a bill.
CREATE FUNCTION estimate_deepseek_v41_flash(u jsonb, requested_at timestamptz) RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  WITH usage AS (
    SELECT CASE WHEN jsonb_typeof(u->'prompt_tokens') = 'number' THEN (u->>'prompt_tokens')::numeric END AS input,
           CASE WHEN jsonb_typeof(u->'completion_tokens') = 'number' THEN (u->>'completion_tokens')::numeric END AS output,
           CASE WHEN jsonb_typeof(u->'prompt_cache_hit_tokens') = 'number' THEN (u->>'prompt_cache_hit_tokens')::numeric
                WHEN jsonb_typeof(u#>'{prompt_tokens_details,cached_tokens}') = 'number' THEN (u#>>'{prompt_tokens_details,cached_tokens}')::numeric
                ELSE 0 END AS cached,
           requested_at AT TIME ZONE 'UTC' AS at
  ), tariff AS (
    SELECT input, output, greatest(0, least(input, cached)) AS cached,
      CASE WHEN extract(isodow FROM at) BETWEEN 1 AND 5
        AND (at::time >= time '01:00' AND at::time < time '04:00' OR at::time >= time '06:00' AND at::time < time '10:00')
        AND NOT (at::date BETWEEN date '2026-01-01' AND date '2026-01-03'
          OR at::date BETWEEN date '2026-02-15' AND date '2026-02-23'
          OR at::date BETWEEN date '2026-04-04' AND date '2026-04-06'
          OR at::date BETWEEN date '2026-05-01' AND date '2026-05-05'
          OR at::date BETWEEN date '2026-06-19' AND date '2026-06-21'
          OR at::date BETWEEN date '2026-09-25' AND date '2026-09-27'
          OR at::date BETWEEN date '2026-10-01' AND date '2026-10-07')
        THEN 1 ELSE 0.5 END AS weight
    FROM usage
  )
  SELECT CASE WHEN input >= 0 AND output >= 0 AND requested_at IS NOT NULL
    THEN ((input - cached) * 0.30 + cached * 0.006 + output * 1.20) * weight / 1000000 END FROM tariff
$$;
