import { sql, type Db } from "../db.ts";

export interface UsageRow {
  purpose: string;
  service: string;
  model: string | null;
  prompt_version: string | null;
  score_slot: number | null;
  calls: number;
  ok: number;
  failed: number;
  unknown: number;
  p50: number | null;
  p95: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  actual_cost: number | null;
  actual_calls: number;
  currency: string | null;
  official_estimate: number | null;
  estimated_calls: number;
}

export async function modelUsage(db: Db, since: Date, until: Date, separateScores: boolean) {
  const [state] = await db`SELECT bool_and(complete) AS ready FROM model_usage_backfill`;
  const attempts = state?.ready ? sql`model_usage_attempts` : sql`model_usage_attempt_source()`;
  const receipts = state?.ready ? sql`model_usage_receipts` : sql`model_usage_receipt_source()`;
  return db<UsageRow[]>`
    SELECT r.purpose, a.service, a.model, r.prompt_version, ${separateScores ? sql`r.score_slot` : sql`NULL::int`} AS score_slot,
           count(*)::int AS calls, count(*) FILTER (WHERE a.status='received')::int AS ok,
           count(*) FILTER (WHERE a.status='failed')::int AS failed, count(*) FILTER (WHERE a.status='unknown')::int AS unknown,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY a.latency_ms) AS p50,
           percentile_disc(0.95) WITHIN GROUP (ORDER BY a.latency_ms) AS p95,
           sum(a.tokens_in::bigint) AS tokens_in, sum(a.tokens_out::bigint) AS tokens_out,
           sum(a.actual_cost) AS actual_cost, a.currency, count(a.actual_cost)::int AS actual_calls,
           sum(a.official_estimate) AS official_estimate, count(a.official_estimate)::int AS estimated_calls
    FROM ${attempts} a JOIN ${receipts} r ON r.id=a.receipt_id
    WHERE a.started_at>=${since} AND a.started_at<${until}
    GROUP BY 1,2,3,4,5,a.currency ORDER BY 1,6 DESC`;
}

/** Each batch locks only its progress row. Live writers upsert and the initial copy never overwrites them.
 * The recurring worker and an operator can both resume from the last committed batch. */
export async function backfillModelUsageBatch() {
  return sql.begin(async tx => {
    const [next] = await tx<{ source: "receipts" | "attempts"; last_id: number | null }[]>`
      SELECT source,last_id FROM model_usage_backfill WHERE NOT complete ORDER BY source DESC
      LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!next) return false;
    await tx`SET LOCAL lock_timeout='500ms'`;
    const receipts = next.source === "receipts";
    const source = receipts ? sql`model_usage_receipt_source()` : sql`model_usage_attempt_source()`;
    const target = receipts ? sql`model_usage_receipts` : sql`model_usage_attempts`;
    const [result] = await tx<{ last_id: number | null }[]>`
      WITH batch AS MATERIALIZED (
        SELECT * FROM ${source} ${next.last_id === null ? sql`` : sql`WHERE id>${next.last_id}`}
        ORDER BY id LIMIT 2000
      ), copied AS (
        INSERT INTO ${target} SELECT * FROM batch ON CONFLICT (id) DO NOTHING
      ) SELECT max(id) AS last_id FROM batch`;
    await tx`UPDATE model_usage_backfill SET last_id=coalesce(${result!.last_id}::bigint,last_id),
      complete=${result!.last_id === null} WHERE source=${next.source}`;
    return true;
  });
}

export async function backfillModelUsage() {
  // Limit the I/O budget per worker tick. Each committed batch is also safe to retry.
  const deadline = Date.now() + 3000;
  do {
    if (!await backfillModelUsageBatch()) return;
  } while (Date.now() < deadline);
}
