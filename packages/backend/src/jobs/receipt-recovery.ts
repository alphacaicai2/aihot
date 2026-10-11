// Resume business work, preserving both the original uncertain call and its durable fallback route.
import { sql } from "../db.ts";
import { storyDigestNeedsUpdate } from "../events/digest.ts";
import { configuredDefaultFallback } from "../providers/llm.ts";
import { queueProcessing } from "./content.ts";
import { enqueue, ensureQueue, QUEUES } from "./queue.ts";

const ANALYSIS_TAGS: Record<string, RegExp> = {
  analyze_article: /^0$/, prefilter_article: /^0$/, score_article: /^score-[12]$/,
  structure_article: /^structure$/, understand_article: /^understand$/, summarize_article: /^summarize$/,
};
const GROUP_PURPOSES = new Set(["group_article", "group_review", "group_signal"]);

export async function recoverReceiptWork(id: number): Promise<{ state: string; requeued: boolean }> {
  const [target] = await sql<{ purpose: string; subject: string; logical_key: string }[]>`
    SELECT purpose, subject, logical_key FROM receipts WHERE id = ${id}`;
  if (!target) return { state: "missing", requeued: false };
  const tag = /:[a-f0-9]{64}:(.+)$/.exec(target.logical_key)?.[1];
  const analysis = ANALYSIS_TAGS[target.purpose];
  const article = /^article:([^@:]+)(?:@(\d+))?/.exec(target.subject ?? "");
  const story = /^story:(\d+)@/.exec(target.subject ?? "");
  const group = GROUP_PURPOSES.has(target.purpose);
  // Recovery must not turn a manually tagged evaluation into an unrelated default request.
  if (analysis ? !tag || !analysis.test(tag) : tag !== "0") return { state: "unsupported", requeued: false };
  const queue = analysis && article ? QUEUES.analyze : group && article ? QUEUES.group
    : target.purpose === "story_digest" && story ? QUEUES.digest : null;
  if (!queue) return { state: "unsupported", requeued: false };
  await ensureQueue(queue);
  return sql.begin(async (tx) => {
    const ref = article?.[1] ?? story![1]!;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`receipt-work:${queue}:${ref}`}))`;
    const [receipt] = await tx<{ status: string; fallback_model: string | null; fallback_status: string | null; fallback_error: string | null }[]>`
      SELECT r.status, f.fallback_model, b.status AS fallback_status, b.error AS fallback_error
      FROM receipts r LEFT JOIN model_fallback_routes f ON f.primary_receipt_id = r.id OR f.fallback_receipt_id = r.id
      LEFT JOIN receipts b ON b.id = f.fallback_receipt_id WHERE r.id = ${id}`;
    if (!receipt || receipt.status === "pending" || ["pending", "unknown"].includes(receipt.fallback_status ?? "")) {
      return { state: "blocked", requeued: false };
    }
    if (receipt.status === "unknown" && !receipt.fallback_model) return { state: "blocked", requeued: false };
    if (receipt.fallback_status === "failed" && !/^(?:Error: )?(HTTP (429|5\d\d):|connect failed:|自动放行：|人工核对：)/.test(receipt.fallback_error ?? "")) {
      return { state: "blocked", requeued: false };
    }
    const key = article ? "articleId" : "storyId";
    const busy = await tx`SELECT 1 FROM pgboss.job WHERE name = ${queue}
      AND data->>${key} = ${ref} AND state IN ('created', 'retry', 'active') LIMIT 1`;
    if (busy.length) return { state: "in-flight", requeued: false };
    if (analysis) {
      const [a] = await tx<{ revision: number; processing_state: string }[]>`SELECT revision, processing_state FROM articles WHERE id = ${ref} FOR UPDATE`;
      if (!a || !["new", "failed"].includes(a.processing_state)) return { state: "settled", requeued: false };
      if (article![2] && a.revision !== Number(article![2])) return { state: "stale", requeued: false };
      await tx`UPDATE articles SET processing_state = 'new', processing_attempts = 0,
        processing_retry_at = NULL, processing_error = NULL WHERE id = ${ref}`;
      const job = await queueProcessing(ref, { step: "analyze", db: tx });
      return { state: job ? "queued" : "in-flight", requeued: !!job };
    }
    if (group) {
      const [a] = await tx<{ grouped_at: Date | null; regroup_pending: boolean }[]>`
        SELECT grouped_at, EXISTS (SELECT 1 FROM regroup_pending rp WHERE rp.article_id = articles.id) AS regroup_pending
        FROM articles WHERE id = ${ref} FOR UPDATE`;
      if (!a || (a.grouped_at && !a.regroup_pending)) return { state: "settled", requeued: false };
      const job = await enqueue(queue, { articleId: ref, ...(target.purpose === "group_signal" ? { signalOnly: true } : {}) }, { singletonKey: ref }, tx);
      return { state: job ? "queued" : "in-flight", requeued: !!job };
    }
    if (!(await storyDigestNeedsUpdate(Number(ref), tx))) return { state: "settled", requeued: false };
    const job = await enqueue(queue, { storyId: Number(ref) }, { singletonKey: `story:${ref}` }, tx);
    return { state: job ? "queued" : "in-flight", requeued: !!job };
  }) as Promise<{ state: string; requeued: boolean }>;
}

/** Only unfinished business with a usable fallback is considered; unknown fallbacks stay blocked. */
export async function recoverFallbackWork(limit = 100): Promise<{ checked: number; requeued: number }> {
  const configured = configuredDefaultFallback();
  if (configured) {
    await sql`INSERT INTO model_fallback_routes(primary_key, fallback_model, primary_receipt_id, reason)
      SELECT r.logical_key, ${configured.fallback.key}, r.id, 'recover unfinished work without releasing the unknown primary'
      FROM receipts r LEFT JOIN articles a ON a.id = substring(r.subject FROM '^article:([^@:]+)')
      WHERE r.status = 'unknown' AND r.service = ${configured.primary.service} AND r.model = ${configured.primary.model}
        AND r.created_at > now() - interval '30 days'
        AND r.logical_key ~ '[a-f0-9]{64}:(0|score-[12]|structure|understand|summarize)$'
        AND EXISTS (SELECT 1 FROM budgets WHERE service = ${configured.fallback.service})
        AND ((r.purpose IN ('analyze_article','prefilter_article','score_article','structure_article','understand_article','summarize_article')
          AND a.processing_state IN ('new','failed') AND a.revision::text = substring(r.subject FROM '@([0-9]+)'))
          OR (r.purpose IN ('group_article','group_review','group_signal') AND a.id IS NOT NULL AND a.grouped_at IS NULL)
          OR r.purpose = 'story_digest')
        AND NOT EXISTS (SELECT 1 FROM model_fallback_routes f WHERE f.primary_key = r.logical_key
          OR f.primary_receipt_id = r.id OR f.fallback_receipt_id = r.id)
      ORDER BY r.updated_at LIMIT ${limit} ON CONFLICT (primary_key) DO NOTHING`;
  }
  const candidates = await sql<{ id: number }[]>`
    SELECT DISTINCT ON (split_part(r.subject, '@', 1)) r.id
    FROM model_fallback_routes f JOIN receipts r ON r.id = coalesce(f.primary_receipt_id, f.fallback_receipt_id)
    LEFT JOIN receipts b ON b.id = f.fallback_receipt_id
    LEFT JOIN articles a ON a.id = substring(r.subject FROM '^article:([^@:]+)')
    WHERE r.created_at > now() - interval '30 days'
      AND (r.status IN ('unknown', 'failed') OR (f.primary_receipt_id IS NULL AND r.status IN ('received', 'completed')))
      AND r.logical_key ~ '[a-f0-9]{64}:(0|score-[12]|structure|understand|summarize)$'
      AND (b.status IS NULL OR b.status IN ('received', 'completed', 'failed'))
      AND ((r.purpose IN ('analyze_article', 'prefilter_article', 'score_article', 'structure_article', 'understand_article', 'summarize_article')
              AND a.processing_state IN ('new', 'failed') AND a.revision::text = substring(r.subject FROM '@([0-9]+)')
              AND (a.processing_retry_at IS NULL OR a.processing_retry_at <= now()))
        OR (r.purpose IN ('group_article', 'group_review', 'group_signal') AND a.id IS NOT NULL
          AND (a.grouped_at IS NULL OR EXISTS (SELECT 1 FROM regroup_pending rp WHERE rp.article_id = a.id)))
        OR r.purpose = 'story_digest')
      AND NOT EXISTS (SELECT 1 FROM pgboss.job q WHERE q.state IN ('created','retry','active')
        AND ((q.name = 'content.analyze' AND q.data->>'articleId' = a.id)
          OR (q.name = 'events.group' AND q.data->>'articleId' = a.id)
          OR (q.name = 'events.digest' AND q.data->>'storyId' = substring(r.subject FROM '^story:([0-9]+)'))))
    ORDER BY split_part(r.subject, '@', 1), r.updated_at DESC LIMIT ${limit}`;
  let requeued = 0;
  for (const r of candidates) if ((await recoverReceiptWork(r.id)).requeued) requeued++;
  return { checked: candidates.length, requeued };
}
