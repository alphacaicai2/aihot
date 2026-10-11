// Runs view: task timeline, queue backlog, source lag, error classes, process
// heartbeats, and the receipts and deliveries whose outcome needs an operator.
import { sql } from "../db.ts";
import { audit } from "./auth.ts";
import { Conflict } from "./sources.ts";
import { failureGroupSql, requeueFailed } from "../jobs/content.ts";
import { recoverReceiptWork } from "../jobs/receipt-recovery.ts";
import { configuredDefaultFallback } from "../providers/llm.ts";

const STALE_HEARTBEAT_MS = 3 * 60_000;

export async function runsOverview() {
  const [heartbeats, latest, timeline, queues, failedJobs, lagging, receipts, receiptIssues, deliveries, errors, ingest, leaderboard, receiptRecovery] = await Promise.all([
    sql<{ key: string; value: Record<string, unknown>; updated_at: Date }[]>`SELECT key, value, updated_at FROM settings WHERE key LIKE 'heartbeat.%' ORDER BY key`,
    sql`
      WITH latest AS (
        SELECT DISTINCT ON (job) job, started_at, finished_at, status, left(error, 400) AS error
        FROM job_runs ORDER BY job, started_at DESC
      ), counts AS (
        SELECT job, count(*) FILTER (WHERE status = 'failed')::int AS failed_24h, count(*)::int AS runs_24h
        FROM job_runs WHERE started_at > now() - interval '24 hours' GROUP BY job
      )
      SELECT latest.*, coalesce(counts.failed_24h, 0) AS failed_24h, coalesce(counts.runs_24h, 0) AS runs_24h,
        (latest.status = 'failed' AND latest.job = 'reports.daily' AND EXISTS (
          SELECT 1 FROM reports p WHERE p.kind = 'daily'
            AND p.key = to_char(latest.started_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')
            AND p.generated_at > latest.finished_at)) AS recovered
      FROM latest LEFT JOIN counts USING (job) ORDER BY job`,
    sql`SELECT id, job, started_at, finished_at, status, left(error, 300) AS error FROM job_runs ORDER BY started_at DESC LIMIT 80`,
    sql<{ name: string; state: string; n: number; oldest: Date }[]>`
      SELECT name, state, count(*)::int AS n, min(created_on) AS oldest FROM pgboss.job
      WHERE state IN ('created', 'retry', 'active') GROUP BY 1, 2 ORDER BY 1, 2`,
    sql`
      WITH failed AS (
        SELECT *, coalesce(data->>'articleId', data->>'storyId', data::text, '') AS ref,
          substring(output->>'message' FROM '^Receipt ([0-9]+) has an unknown outcome')::bigint AS receipt_id
        FROM pgboss.job WHERE state = 'failed' AND completed_on > now() - interval '24 hours'
      ), succeeded AS (
        SELECT name, coalesce(data->>'articleId', data->>'storyId', data::text, '') AS ref, max(completed_on) AS at
        FROM pgboss.job WHERE state = 'completed' AND completed_on > now() - interval '24 hours'
          AND name IN (SELECT DISTINCT name FROM failed) GROUP BY 1, 2
      ), resolved AS (
        SELECT f.*, coalesce(q.at > f.completed_on, false)
          OR (f.name = 'events.group' AND EXISTS (SELECT 1 FROM articles a
            WHERE a.id = f.data->>'articleId' AND a.grouped_at IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM regroup_pending rp WHERE rp.article_id = a.id)))
          OR (f.name = 'events.digest' AND s.id IS NOT NULL AND (s.merged_into IS NOT NULL OR coalesce(s.digest_updated_at > f.completed_on, false)
            OR NOT EXISTS (SELECT 1 FROM facts x JOIN fact_articles fa ON fa.fact_id = x.id
              JOIN publications p ON p.article_id = fa.article_id
              WHERE x.story_id = s.id AND p.visibility = 'public' AND p.eligible)))
          OR (f.name = 'cron.reports.daily' AND EXISTS (SELECT 1 FROM reports p WHERE p.kind = 'daily'
            AND p.key = to_char(f.created_on AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AND p.generated_at > f.completed_on)) AS recovered
        FROM failed f LEFT JOIN succeeded q ON q.name = f.name AND q.ref = f.ref
        LEFT JOIN stories s ON f.name = 'events.digest' AND s.id::text = f.data->>'storyId'
      )
      SELECT name, count(*)::int AS failed, count(*) FILTER (WHERE recovered)::int AS recovered,
        count(*) FILTER (WHERE NOT recovered)::int AS unresolved, max(completed_on) AS last,
        left((array_agg(coalesce((SELECT a.error FROM receipt_attempts a WHERE a.receipt_id = f.receipt_id ORDER BY a.attempt DESC LIMIT 1),
          output->>'message', output::text) ORDER BY completed_on DESC))[1], 1200) AS last_output
      FROM resolved f GROUP BY name ORDER BY failed DESC`,
    sql`
      SELECT id, name, kind, health, fail_count, last_ok_at, last_fetch_at, next_fetch_at, interval_minutes, left(last_error, 200) AS last_error
      FROM sources
      WHERE enabled AND kind NOT IN ('mp_account', 'external')
        AND (health = 'failing' OR next_fetch_at < now() - interval '30 minutes' OR last_ok_at < now() - make_interval(mins => greatest(interval_minutes * 6, 360)))
      ORDER BY health = 'failing' DESC, next_fetch_at LIMIT 60`,
    sql<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM receipts WHERE created_at > now() - interval '7 days' GROUP BY 1`,
    sql`
      SELECT r.id, r.service, r.model, r.purpose, r.subject, r.status, r.attempts, r.error AS release_or_error,
        coalesce((SELECT a.error FROM receipt_attempts a WHERE a.receipt_id = r.id ORDER BY a.attempt DESC LIMIT 1), r.error) AS error,
        r.created_at, r.updated_at, f.fallback_model, f.fallback_receipt_id, b.status AS fallback_status,
        b.error AS fallback_error
      FROM receipts r LEFT JOIN LATERAL (SELECT * FROM model_fallback_routes f
        WHERE f.primary_receipt_id = r.id OR f.fallback_receipt_id = r.id ORDER BY f.created_at DESC LIMIT 1) f ON true
      LEFT JOIN receipts b ON b.id = f.fallback_receipt_id
      WHERE (r.status = 'unknown' AND r.billing_review IS NULL) OR (r.status = 'failed' AND r.updated_at > now() - interval '3 days') OR (r.status = 'pending' AND r.updated_at < now() - interval '15 minutes')
      ORDER BY r.status = 'unknown' DESC, r.updated_at DESC LIMIT 40`,
    sql`
      SELECT id, target_key, subject_kind, subject_id, status, attempts, left(response, 240) AS response, created_at, updated_at FROM deliveries
      WHERE status IN ('unknown', 'failed') OR (status = 'sending' AND updated_at < now() - interval '15 minutes')
      ORDER BY status = 'unknown' DESC, updated_at DESC LIMIT 40`,
    sql`
      SELECT ${failureGroupSql()} AS error, count(*)::int AS n, max(discovered_at) AS last,
             (array_agg(id ORDER BY discovered_at DESC))[1] AS example
      FROM articles WHERE processing_state = 'failed' AND discovered_at > now() - interval '30 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
    sql`SELECT client, kind, status, left(error, 200) AS error, summary, created_at FROM ingest_events ORDER BY created_at DESC LIMIT 20`,
    sql<{ value: { at: string; sources: Record<string, { ok: boolean; at: string; lastOkAt: string | null; changed?: boolean; rows?: number; error?: string }> } }[]>`
      SELECT value FROM settings WHERE key = 'leaderboard.fetch'`,
    sql<{ unknown: number; billing_unreviewed: number; billing_confirmed_zero: number; fallback_completed: number; fallback_received: number; fallback_pending: number; fallback_failed: number; fallback_unknown: number; fallback_not_sent: number; no_fallback: number; failed_articles: number }[]>`
      SELECT count(*)::int AS unknown,
        count(*) FILTER (WHERE r.billing_review IS NULL)::int AS billing_unreviewed,
        count(*) FILTER (WHERE r.billing_review @> '{"billed":true,"amount":0}')::int AS billing_confirmed_zero,
        count(*) FILTER (WHERE b.status = 'completed')::int AS fallback_completed,
        count(*) FILTER (WHERE b.status = 'received')::int AS fallback_received,
        count(*) FILTER (WHERE b.status = 'pending')::int AS fallback_pending,
        count(*) FILTER (WHERE b.status = 'failed')::int AS fallback_failed,
        count(*) FILTER (WHERE b.status = 'unknown')::int AS fallback_unknown,
        count(*) FILTER (WHERE f.primary_key IS NOT NULL AND b.id IS NULL)::int AS fallback_not_sent,
        count(*) FILTER (WHERE f.primary_key IS NULL)::int AS no_fallback,
        count(DISTINCT a.id) FILTER (WHERE a.processing_state = 'failed'
          AND a.revision::text = substring(r.subject FROM '@([0-9]+)'))::int AS failed_articles
      FROM receipts r LEFT JOIN LATERAL (SELECT * FROM model_fallback_routes f
        WHERE f.primary_receipt_id = r.id OR f.fallback_receipt_id = r.id ORDER BY f.created_at DESC LIMIT 1) f ON true
      LEFT JOIN receipts b ON b.id = f.fallback_receipt_id
      LEFT JOIN articles a ON a.id = substring(r.subject FROM '^article:([^@:]+)')
      WHERE r.status = 'unknown'`,
  ]);
  // Articles waiting to retry after a passing provider problem (they are not failed).
  const [retrying] = await sql<{ n: number; next: Date | null }[]>`
    SELECT count(*)::int AS n, min(processing_retry_at) AS next FROM articles
    WHERE processing_state = 'new' AND (processing_attempts > 0 OR processing_retry_at IS NOT NULL)`;
  const now = Date.now();
  return {
    checkedAt: new Date(now).toISOString(),
    processes: heartbeats.map((h) => ({
      role: h.key.slice("heartbeat.".length),
      ...h.value,
      at: h.updated_at,
      alive: now - h.updated_at.getTime() < STALE_HEARTBEAT_MS,
    })),
    jobs: latest,
    timeline,
    queues,
    failedJobs,
    lagging,
    receipts: { counts: Object.fromEntries(receipts.map((r) => [r.status, r.n])), issues: receiptIssues, recovery: receiptRecovery[0]! },
    deliveries,
    errors,
    retrying: { count: retrying?.n ?? 0, next: retrying?.next ?? null },
    ingest,
    leaderboard: leaderboard[0]
      ? { at: leaderboard[0].value.at, sources: Object.entries(leaderboard[0].value.sources).map(([key, v]) => ({ key, ...v })).sort((a, b) => Number(a.ok) - Number(b.ok) || a.key.localeCompare(b.key)) }
      : null,
  };
}

/** Confirm zero billing without releasing/retrying an unknown response or changing provider data. */
export async function confirmZeroCostReceipts(input: { receiptIds: number[]; note: string }, actor: string) {
  if (!Array.isArray(input.receiptIds) || !input.receiptIds.length || input.receiptIds.length > 5000
    || input.receiptIds.some(id => !Number.isSafeInteger(id) || id <= 0)
    || typeof input.note !== 'string' || !input.note.trim() || !actor.trim()) {
    throw Object.assign(new Error("receiptIds (1–5000 positive integers), note and actor are required"), { statusCode: 400 });
  }
  const ids = [...new Set(input.receiptIds)].sort((a, b) => a - b);
  return sql.begin(async tx => {
    const rows = await tx<{ id: number; status: string; billing_review: { billed: boolean; amount: number } | null }[]>`
      SELECT id,status,billing_review FROM receipts WHERE id IN ${tx(ids)} ORDER BY id FOR UPDATE`;
    if (rows.length !== ids.length || rows.some(r => r.status !== 'unknown')) {
      throw new Conflict("只能确认指定的结果未知回执；回执缺失或状态已变化");
    }
    if (rows.some(r => r.billing_review && (r.billing_review.billed !== true || r.billing_review.amount !== 0))) {
      throw new Conflict("已有不同的计费确认，不能覆盖");
    }
    const review = { billed: true, amount: 0, source: 'operator', actor, note: input.note.trim(), at: new Date().toISOString() };
    const changed = await tx`UPDATE receipts SET billing_review=${tx.json(review)}
      WHERE id IN ${tx(ids)} AND billing_review IS NULL RETURNING id`;
    if (changed.length) await tx`INSERT INTO audit_log(actor,action,subject,reason,before,after)
      VALUES (${actor},'receipt.billing-confirm-zero','receipts',${input.note.trim()},
        ${tx.json({ receiptIds: changed.map(r => r.id), status: 'unknown', billingReviewed: false })},
        ${tx.json({ status: 'unknown', billed: true, amount: 0, source: 'operator', confirmed: changed.length, released: false, requeued: false })})`;
    return { requested: ids.length, confirmed: changed.length, alreadyConfirmed: ids.length - changed.length, released: false, requeued: false };
  });
}

/**
 * A receipt whose outcome is unknown is not re-sent by the request that lost it. Releasing it marks it
 * failed, so the next attempt calls again; an article that stopped on it goes straight back to
 * processing (one action, not two). Only an unknown receipt is released, once.
 */
async function release(id: number, error: string, actor: string, note: string, billed: boolean | null) {
  const before = await sql.begin(async (tx) => {
    const [row] = await tx<{ subject: string | null; purpose: string }[]>`
      UPDATE receipts SET status = 'failed', error = ${error}, updated_at = now() WHERE id = ${id} AND status = 'unknown' RETURNING subject, purpose`;
    if (row) await tx`UPDATE receipt_attempts SET release_note = ${error}, released_at = now()
      WHERE receipt_id = ${id} AND status = 'unknown' AND released_at IS NULL`;
    return row;
  });
  if (!before) return null;
  const { requeued } = await recoverReceiptWork(id);
  await audit(actor, "receipt.release", `receipt:${id}`, note, { status: "unknown" }, { status: "failed", billed, requeued });
  return { id, status: "failed", subject: before.subject, purpose: before.purpose, requeued };
}

/** Admin, after checking the provider's console: records whether it was billed and releases it. */
export async function releaseReceipt(id: number, input: { billed: boolean; note: string }, actor: string) {
  if (!input.note?.trim()) throw new Error("note is required");
  const [row] = await sql<{ status: string }[]>`SELECT status FROM receipts WHERE id = ${id}`;
  if (!row) return null;
  if (row.status !== "unknown") throw new Conflict("只有结果未知的回执需要人工核对");
  const error = `人工核对：${input.billed ? "供应商已计费但结果未取回" : "供应商未计费"}。${input.note}`;
  return release(id, error, actor, input.note, input.billed);
}

const AUTO_RELEASE_AFTER_MS = 30 * 60_000;
const AUTO_RELEASE_NOTE = "自动放行：结果未知超过 30 分钟，未核对是否计费";

/**
 * Every 10 minutes: preserve model requests with an independent fallback for bill review. Other
 * unknown receipts older than half an hour may be released once; another loss waits for the admin.
 */
export async function autoReleaseUnknownReceipts(now = Date.now()) {
  const route = configuredDefaultFallback();
  const rows = await sql<{ id: number }[]>`
    SELECT r.id FROM receipts r
    WHERE r.status = 'unknown' AND r.updated_at < ${new Date(now - AUTO_RELEASE_AFTER_MS)}
      AND r.billing_review IS NULL
      AND NOT EXISTS (SELECT 1 FROM receipt_attempts a WHERE a.receipt_id = r.id
        AND (a.released_at IS NOT NULL OR a.error LIKE ${AUTO_RELEASE_NOTE + "%"}))
      AND NOT EXISTS (SELECT 1 FROM model_fallback_routes f WHERE f.primary_receipt_id = r.id OR f.fallback_receipt_id = r.id)
      AND NOT (${!!route} AND r.service = ${route?.primary.service ?? ""} AND r.model = ${route?.primary.model ?? ""})
    ORDER BY r.id LIMIT 200`;
  let released = 0;
  let requeued = 0;
  for (const r of rows) {
    const done = await release(r.id, AUTO_RELEASE_NOTE, "ops.recover", "结果未知，自动放行一次", null);
    if (done) released += 1;
    if (done?.requeued) requeued += 1;
  }
  return { released, requeued };
}

/** Failed articles (one failure group, or all of the last 30 days) back into processing. */
export async function requeueFailedArticles(input: { group: string | null; reason: string }, actor: string) {
  if (!input.reason?.trim()) throw new Error("reason is required");
  const result = await requeueFailed(input.group);
  await audit(actor, "processing.requeue", input.group ? `failure:${input.group.slice(0, 80)}` : "failure:all", input.reason, null, result);
  return result;
}

/** An in-doubt delivery: confirmed as arrived, given up, or sent again after checking the group. */
export async function resolveDelivery(id: number, input: { outcome: "sent" | "drop" | "resend"; note: string }, actor: string) {
  if (!input.note?.trim()) throw new Error("note is required");
  const [before] = await sql<{ status: string }[]>`SELECT status FROM deliveries WHERE id = ${id}`;
  if (!before) return null;
  if (before.status !== "unknown" && before.status !== "failed") throw new Conflict("这条投递不需要处理");
  let status: string;
  if (input.outcome === "sent") {
    await sql`UPDATE deliveries SET status = 'sent', sent_at = coalesce(sent_at, now()), response = ${`人工确认已送达：${input.note}`}, updated_at = now() WHERE id = ${id}`;
    status = "sent";
  } else if (input.outcome === "drop") {
    await sql`UPDATE deliveries SET status = 'failed', response = ${`人工放弃：${input.note}`}, updated_at = now() WHERE id = ${id}`;
    status = "failed";
  } else {
    const { resendDelivery } = await import("../notify/deliver.ts");
    status = (await resendDelivery(id)).status;
  }
  await audit(actor, `delivery.${input.outcome}`, `delivery:${id}`, input.note, { status: before.status }, { status });
  return { id, status };
}
