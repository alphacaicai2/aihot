// Content processing: body extraction when the source needs it → analysis → publish → event grouping.
// Every article reaches the queues through queueProcessing, which records when it was queued, so the
// safety net only picks up articles nothing is working on and sends those still waiting for a body to
// extraction first. A provider outage makes an article wait and retry with backoff; only a permanent
// refusal or exhausted retries end in "failed", which the admin re-queues in bulk.
import type { PgBoss } from "pg-boss";
import { sql, type Db } from "../db.ts";
import { extractArticleBody, pageFetchable } from "../content/extract.ts";
import { analyzeArticle, AnalysisInterruptedError } from "../editorial/analyze.ts";
import { isHistorical } from "../content/materials.ts";
import { processingInput, type ProcessingInput } from "../content/processing.ts";
import { publishArticle } from "../publication/publish.ts";
import { BudgetExceededError, ProviderRejectedError, ReceiptBusyError, ReceiptUnknownError } from "../providers/receipts.ts";
import { ModelOutputError } from "../providers/llm.ts";
import { ensureQueue, enqueue, QUEUES, shutdownSignal } from "./queue.ts";

/** Minutes to wait after the n-th failed attempt; one more failure after the last ends in "failed". */
const RETRY_MINUTES = [5, 10, 20, 40, 60, 120, 240, 360];
/** Unusable model output is retried less: each retry is a paid call. */
const MAX_OUTPUT_FAILURES = 3;
/** Extraction gives up after this many errors and the article is judged on what it has. */
const MAX_EXTRACT_FAILURES = 3;
/** A queued article whose job left no trace for this long is queued again. */
const QUEUED_STALE = "30 minutes";

type Step = "extract" | "analyze";

interface Route {
  step: Step;
  /** Not an editorial source: no analysis; the post goes straight to event grouping as discussion evidence. */
  signal: boolean;
  historical: boolean;
}

/**
 * The article's next step: its body first while none is confirmed and the source asks for full text,
 * when there is only a title or a feed summary (the analysis judges the whole article), or when an
 * X post links an X Article (fetched before judging; for a discussion post only while it is news, as
 * history adds no heat).
 */
async function route(articleId: string, db: Db): Promise<Route | null> {
  const [row] = await db<{ body_status: string; participation_mode: string; kind: string; config: Record<string, unknown>; url: string; bare: boolean; backfill: boolean; published_at: Date | null; discovered_at: Date }[]>`
    SELECT a.body_status, s.participation_mode, s.kind, s.config, a.url, (coalesce(a.body_text, '') = '' AND a.x_post IS NULL) AS bare,
           a.backfill, a.published_at, a.discovered_at
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!row) return null;
  const historical = isHistorical(row);
  const signal = row.participation_mode !== "editorial";
  const pending = row.body_status === "pending";
  const wantsBody = row.config.fetchPublicContent === true || !!row.config.detail || row.kind === "web_list";
  const needsPage = !signal && (wantsBody || (row.bare && pageFetchable(row.url, row.kind)));
  const needsXArticle = row.kind === "x_search" && (!signal || (row.participation_mode === "hot_signal" && !historical));
  return { step: pending && (needsPage || needsXArticle) ? "extract" : "analyze", signal, historical };
}

/**
 * Queue order (pg-boss serves higher priority first): live work before history, so a new source's
 * first import or a backfill never holds up today's news; discussion evidence waits behind reports
 * in the serial grouping queue, history behind both.
 */
const PRIORITY = { live: 0, liveSignal: -1, history: -2 } as const;

/**
 * The one way to hand an article to processing. `attemptTag` makes an explicit re-evaluation a new
 * (paid) request; the same tag reuses its receipt. With `db`, the job commits with the caller's write.
 * Posts of non-editorial sources skip the analysis queue: they only need recording and grouping.
 */
export async function queueProcessing(articleId: string, opts: { step?: Step; attemptTag?: string; db?: Db; expected?: ProcessingInput } = {}): Promise<string | null> {
  const run = async (db: Db) => {
    const [current] = await db<{ revision:number; generation:number }[]>`SELECT revision,processing_generation AS generation FROM articles WHERE id=${articleId} FOR UPDATE`;
    if (!current || (opts.expected && (current.revision !== opts.expected.revision || current.generation !== opts.expected.generation))) return null;
    const r = await route(articleId, db);
    if (!r) return null;
    const step = opts.step ?? r.step;
    const generation=current.generation+1;
    const tagged=!!opts.attemptTag;
    const name=step==='extract' ? QUEUES.extractBody : r.signal && !tagged ? QUEUES.group : QUEUES.analyze;
    const singletonKey=name===QUEUES.analyze && tagged ? `manual:analyze:${articleId}:${opts.attemptTag}` : articleId;
    const data={articleId,revision:current.revision,generation,
      ...(name===QUEUES.analyze && tagged ? {attemptTag:opts.attemptTag} : {}),
      ...(name===QUEUES.group ? {signalOnly:true} : {})};
    const priority=r.historical ? PRIORITY.history : name===QUEUES.group ? PRIORITY.liveSignal : PRIORITY.live;
    let jobId=await enqueue(name,data,{singletonKey,priority},db);
    if (!jobId) {
      // pg-boss short queues deduplicate only created jobs. Promote that pending job to the
      // current input rather than leaving a job pinned to an obsolete revision/generation.
      const [pending]=await db<{id:string}[]>`UPDATE pgboss.job SET data=${db.json(data)},priority=${priority}
        WHERE name=${name} AND singleton_key=${singletonKey} AND state='created' RETURNING id`;
      jobId=pending?.id ?? await enqueue(name,data,{singletonKey,priority},db);
      if (!jobId) throw new Error('processing handoff raced with queue activation; retry the handoff');
    }
    await db`UPDATE articles SET processing_queued_at=now(),processing_generation=${generation} WHERE id=${articleId}`;
    return jobId;
  };
  const db=opts.db ?? sql;
  return "begin" in db ? (db as typeof sql).begin(run) : run(db);
}

/**
 * A post of a non-editorial source: recorded (hot_signal material only feeds heat; isolated material
 * never reaches public surfaces). Returns whether it is discussion evidence to group.
 */
export async function settleNonEditorial(articleId: string, expected?: ProcessingInput): Promise<{ group: boolean }> {
  const [row] = await sql<{ participation_mode: string; backfill: boolean; published_at: Date | null; discovered_at: Date }[]>`
    UPDATE articles a SET processing_state = 'skipped', processing_attempts = 0, processing_retry_at = NULL, processing_queued_at = NULL
    FROM sources s WHERE s.id = a.source_id AND a.id = ${articleId} AND s.participation_mode <> 'editorial'
      AND (${!expected} OR (a.revision=${expected?.revision ?? null} AND a.processing_generation=${expected?.generation ?? null}))
    RETURNING s.participation_mode, a.backfill, a.published_at, a.discovered_at`;
  if (!row) return { group: false };
  await publishArticle(articleId);
  return { group: row.participation_mode === "hot_signal" && !isHistorical(row) };
}

/** attemptTag makes an explicit re-evaluation a new (paid) request; the same tag reuses its receipt. */
export async function processArticle(articleId: string, opts: { attemptTag?: string; processingInput?:ProcessingInput } = {}): Promise<{ state: string }> {
  const [found] = await sql<{ participation_mode: string; processing_state: string; revision: number; generation:number; backfill: boolean; published_at: Date | null; discovered_at: Date }[]>`
    SELECT s.participation_mode, a.processing_state, a.revision, a.processing_generation AS generation, a.backfill, a.published_at, a.discovered_at FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!found) return { state: "missing" };
  const input=opts.processingInput ?? {revision:found.revision,generation:found.generation};
  if (found.revision!==input.revision || found.generation!==input.generation) return {state:"stale"};
  const row = { ...found, historical: isHistorical(found) };
  if (row.participation_mode !== "editorial") {
    // Normally queued straight for grouping (queueProcessing); an explicit re-evaluation lands here.
    const { group } = await settleNonEditorial(articleId,input);
    if (group) await enqueue(QUEUES.group, { articleId, signalOnly: true }, { singletonKey: articleId, priority: PRIORITY.liveSignal });
    return { state: "skipped" };
  }
  let afterAnalysis=false;
  const publish=async (relevance:string)=>{
    await publishArticle(articleId);
    if (relevance==='pass' && !row.historical) await enqueue(QUEUES.group,{articleId},{singletonKey:articleId,priority:PRIORITY.live});
    return {state:relevance};
  };
  try {
    if (found.processing_state!=='new') {
      if (!['analyzed','blocked'].includes(found.processing_state)) return {state:"settled"};
      // Restart after the judgement committed but publication/group handoff did not. Resume
      // from the applied judgement without another model request (or a new analysis row).
      const [saved]=await sql<{relevance:string}[]>`SELECT relevance FROM analyses WHERE article_id=${articleId}
        AND input_revision=${input.revision} AND NOT superseded ORDER BY id DESC LIMIT 1`;
      if (!saved) return {state:"settled"};
      afterAnalysis=true;
      return await publish(saved.relevance);
    }
    const result = await analyzeArticle(articleId, { attemptTag: opts.attemptTag, processingInput:input });
    if (!result) return { state: "missing" };
    if (result.stale) return { state: "stale" }; // newer work owns both the input and bookkeeping
    // Only a title or a feed summary: the article page first; extraction queues the analysis again.
    if (result.needsBody || !result.output) {
      await queueProcessing(articleId, { step: "extract", expected:input });
      return { state: "fetching-body" };
    }
    afterAnalysis=true;
    return await publish(result.output.relevance);
  } catch (error) {
    if (error instanceof AnalysisInterruptedError || shutdownSignal.signal.aborted) throw error;
    if (error instanceof ReceiptUnknownError) {
      // The uncertain paid outcome stays on its receipt; only the work that still owns the
      // article may stop its processing. An obsolete error cannot fail a newer revision.
      const written=await sql`UPDATE articles SET processing_state='failed',processing_error=${`receipt ${error.receiptId} outcome unknown`},
        processing_retry_at=NULL,processing_queued_at=NULL WHERE id=${articleId} AND revision=${input.revision}
        AND processing_generation=${input.generation} AND processing_state='new' RETURNING id`;
      return {state:written.count ? "unknown-receipt" : "stale"};
    }
    return afterFailure(articleId,input,error,afterAnalysis);
  }
}

/** Waits and retries for passing trouble; marks "failed" for refusals and exhausted retries. */
async function afterFailure(articleId: string, input:ProcessingInput,error:unknown,afterAnalysis=false): Promise<{ state: string; retryAt?: Date }> {
  // A deploy leaves restart recovery to pg-boss; sent paid responses have already settled.
  if (error instanceof AnalysisInterruptedError || shutdownSignal.signal.aborted) throw error;
  const message = String(error instanceof Error ? error.message : error).slice(0, 500);
  return sql.begin(async tx=>{
    const [a]=await tx<{ processing_attempts:number }[]>`SELECT processing_attempts FROM articles WHERE id=${articleId}
      AND revision=${input.revision} AND processing_generation=${input.generation}
      AND processing_state=ANY(${afterAnalysis ? ['new','analyzed','blocked'] : ['new']}::text[]) FOR UPDATE`;
    if (!a) return {state:"stale"};
    if (error instanceof ReceiptBusyError || error instanceof BudgetExceededError) {
      const seconds = error instanceof BudgetExceededError ? error.retryAfterSeconds : 60;
      const retryAt = new Date(Date.now() + seconds * 1000);
      await tx`UPDATE articles SET processing_state='new',processing_error=${message},processing_retry_at=${retryAt},processing_queued_at=NULL WHERE id=${articleId}`;
      return {state:"waiting",retryAt};
    }
    const attempts=a.processing_attempts+1;
    const refused=error instanceof ProviderRejectedError && !error.retryable;
    const exhausted=attempts>RETRY_MINUTES.length || (error instanceof ModelOutputError && attempts>=MAX_OUTPUT_FAILURES);
    const retryAt=refused || exhausted ? null : new Date(Date.now()+RETRY_MINUTES[attempts-1]!*60_000);
    await tx`UPDATE articles SET processing_state=${retryAt ? 'new' : 'failed'},processing_error=${message},processing_attempts=${attempts},
      processing_retry_at=${retryAt},processing_queued_at=NULL WHERE id=${articleId}`;
    return retryAt ? {state:"retrying",retryAt} : {state:"failed"};
  });
}

export async function registerContentJobs(boss: PgBoss, concurrency = Number(process.env.ANALYZE_CONCURRENCY || 6)) {
  await ensureQueue(QUEUES.analyze);
  await boss.work<{ articleId:string;attemptTag?:string;revision?:number;generation?:number }>(QUEUES.analyze, { localConcurrency: concurrency, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return;
    const {articleId,attemptTag,revision,generation}=job.data;
    return processArticle(articleId,{attemptTag,processingInput:revision!==undefined && generation!==undefined ? {revision,generation} : undefined});
  });
}

/**
 * Body extraction before analysis. Failures are retried a few times; after that the article is judged
 * on the excerpt it has ("unconfirmed" body, never a wrong one).
 */
export async function registerExtractionJobs(boss: PgBoss) {
  await ensureQueue(QUEUES.extractBody);
  await boss.work<{ articleId:string;revision?:number;generation?:number }>(QUEUES.extractBody, { localConcurrency: 4, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return;
    const {articleId}=job.data;
    const current=await processingInput(articleId);
    if (!current) return {state:"missing"};
    const input=job.data.revision!==undefined && job.data.generation!==undefined ? {revision:job.data.revision,generation:job.data.generation} : current;
    if (input.revision!==current.revision || input.generation!==current.generation) return {state:"stale"};
    try {
      const state=await extractArticleBody(articleId,undefined,input);
      if (state==="stale") return {state};
      await queueProcessing(articleId,{step:"analyze",expected:{...input,revision:input.revision+(state==="ok" ? 1 : 0)}});
      return {state};
    } catch (error) {
      if (error instanceof AnalysisInterruptedError || shutdownSignal.signal.aborted) throw error;
      const message=String(error instanceof Error ? error.message : error).slice(0,500);
      return sql.begin(async tx=>{
        const [a]=await tx<{processing_attempts:number;body_status:string}[]>`SELECT processing_attempts,body_status FROM articles WHERE id=${articleId}
          AND revision=${input.revision} AND processing_generation=${input.generation} AND processing_state='new' FOR UPDATE`;
        if (!a || a.body_status==='ok') return {state:"stale"};
        const attempts=a.processing_attempts+1;
        if (attempts<MAX_EXTRACT_FAILURES) {
          await tx`UPDATE articles SET processing_attempts=${attempts},processing_error=${`extract: ${message}`},processing_queued_at=NULL,
            processing_retry_at=now()+interval '10 minutes' WHERE id=${articleId}`;
          return {state:"retrying"};
        }
        await tx`UPDATE articles SET body_status='unconfirmed',processing_attempts=0,processing_error=${`extract: ${message}`},
          processing_retry_at=NULL,processing_queued_at=NULL WHERE id=${articleId}`;
        await queueProcessing(articleId,{step:"analyze",expected:input,db:tx});
        return {state:"unconfirmed"};
      });
    }
  });
}

/**
 * Safety net: articles waiting for processing that no queue holds (crash between write and enqueue,
 * a lost job, a retry that came due). Articles already queued or running are left alone.
 */
export async function sweepUnprocessed(): Promise<{ enqueued: number }> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM articles
    WHERE processing_state = 'new' AND created_at < now() - interval '3 minutes'
      AND (processing_retry_at IS NULL OR processing_retry_at <= now())
      AND (processing_queued_at IS NULL OR processing_queued_at < now() - ${QUEUED_STALE}::interval)
    ORDER BY discovered_at DESC LIMIT 500`;
  for (const r of rows) await queueProcessing(r.id);
  return { enqueued: rows.length };
}

/** How the runs page groups failures: the message with ids and numbers masked. */
export const failureGroupSql = (column = "processing_error") =>
  sql.unsafe(`regexp_replace(left(coalesce(${column}, '(no message)'), 120), '[0-9a-f]{8,}|[0-9]{4,}', '…', 'g')`);

/**
 * Admin: failed articles of the last 30 days back into processing, all or one failure group. The
 * first ones are queued now; the safety net picks up the rest within minutes.
 */
export async function requeueFailed(group: string | null): Promise<{ requeued: number }> {
  const rows = await sql<{ id: string }[]>`
    UPDATE articles SET processing_state='new',processing_attempts=0,processing_retry_at=NULL,processing_error=NULL,
      processing_queued_at=NULL,processing_generation=processing_generation+1
    WHERE processing_state='failed' AND discovered_at > now() - interval '30 days'
      AND (${group}::text IS NULL OR ${failureGroupSql()} = ${group})
    RETURNING id`;
  for (const r of rows.slice(0, 500)) await queueProcessing(r.id);
  return { requeued: rows.length };
}
