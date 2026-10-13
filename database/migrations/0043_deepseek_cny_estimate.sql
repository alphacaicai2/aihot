-- Official CNY tariff verified 2026-10-13. Keep the USD function for older API versions.
-- Peak cache miss ¥2, cache hit ¥0.04, output ¥8 / million tokens; off-peak half price.
-- https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
UPDATE service_prices SET currency = 'CNY', input_per_mtok = 2, cached_per_mtok = 0.04,
  output_per_mtok = 8, source_url = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  verified_on = '2026-10-13', updated_at = now(),
  note = 'DeepSeek 人民币官方估算：按缓存命中和请求时间分峰谷，含 2026 中国节假日；不是账户账单。'
WHERE (service, model) IN (('deepseek', 'deepseek-flash'), ('llm', 'deepseek-v4.1-flash'));

CREATE OR REPLACE FUNCTION estimate_deepseek_v41_flash_cny(u jsonb, requested_at timestamptz) RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(u->'prompt_tokens') = 'number'
      AND jsonb_typeof(u->'completion_tokens') = 'number' THEN
    CASE WHEN (u->>'prompt_tokens')::numeric >= 0 AND (u->>'completion_tokens')::numeric >= 0 AND requested_at IS NOT NULL THEN
      ((u->>'prompt_tokens')::numeric * 2.00 - greatest(0, least((u->>'prompt_tokens')::numeric,
      CASE WHEN jsonb_typeof(u->'prompt_cache_hit_tokens') = 'number' THEN (u->>'prompt_cache_hit_tokens')::numeric
           WHEN jsonb_typeof(u#>'{prompt_tokens_details,cached_tokens}') = 'number' THEN (u#>>'{prompt_tokens_details,cached_tokens}')::numeric
           ELSE 0 END)) * 1.96
        + (u->>'completion_tokens')::numeric * 8.00) * CASE WHEN extract(isodow FROM requested_at AT TIME ZONE 'UTC') BETWEEN 1 AND 5
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
