// Content diagnostics and corrections (F19). Find any item by id, URL or title and see its whole
// chain: source → discoveries → revisions → model receipts → decisions → publication and sync
// ledger → grouping → deliveries. Visibility changes and manual corrections go through editorial
// overrides with a version check, are re-projected to every public exit, and are audited.
import { z } from "zod";
import { ARTICLE_ID_PATTERN, CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { sql, type Db } from "../db.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { queueProcessing } from "../jobs/content.ts";
import { normalizeUrl } from "../lib/url.ts";
import { publishArticleTx } from "../publication/publish.ts";

import { mergeStoryInto } from "../events/merge.ts";
import { invalidateStoryDigests } from "../events/digest-invalidation.ts";
import { audit } from "./auth.ts";
import { Conflict } from "./sources.ts";
import { sha256, stableJson } from "../lib/ids.ts";

export async function searchContent(q: string) {
  const term = q.trim();
  if (!term) return [];
  const byId = ARTICLE_ID_PATTERN.test(term) ? term : null;
  const url = /^https?:\/\//i.test(term) ? normalizeUrl(term) : null;
  return sql`
    SELECT a.id, coalesce(p.title, a.title) AS title, a.url, s.name AS source, a.discovered_at, a.processing_state,
           p.visibility, p.selected, p.score
    FROM articles a JOIN sources s ON s.id = a.source_id LEFT JOIN publications p ON p.article_id = a.id
    WHERE (${byId}::text IS NOT NULL AND a.id = ${byId})
       OR (${url}::text IS NOT NULL AND (a.url = ${url} OR a.identity_key = ${url} OR a.url = ${term}))
       OR (${url}::text IS NULL AND (a.title ILIKE ${`%${term}%`} OR p.title ILIKE ${`%${term}%`}))
    ORDER BY a.discovered_at DESC LIMIT 50`;
}

export async function contentChain(id: string) {
  return sql.begin("isolation level repeatable read read only", async tx => {
    const [article] = await tx`
      SELECT a.id, a.source_id, a.url, a.identity_key, a.title, a.author, a.language, a.published_at, a.published_at_claim, a.discovered_at,
             a.timeline_at, a.backfill, a.body_status, a.revision, a.processing_state, a.processing_error, a.grouped_at, length(a.body_text) AS body_chars,
             s.name AS source_name, s.kind AS source_kind, s.tier, s.participation_mode, s.site_fulltext, s.syndicate_fulltext
      FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${id}`;
    if (!article) return null;
    const [discoveries, revisions, analyses, publication, override, ledger, membership, decisions, deliveries, history] = await Promise.all([
      tx`SELECT source_id, via, discovered_at FROM article_discoveries WHERE article_id = ${id} ORDER BY discovered_at`,
      tx`SELECT revision, title, content_hash, created_at FROM article_revisions WHERE article_id = ${id} ORDER BY revision DESC LIMIT 10`,
      tx`
        SELECT an.id, an.origin, an.model, an.prompt_version, an.input_revision, an.superseded, an.relevance, an.category, an.score, an.selected, an.title_zh, an.reason_zh,
               an.created_at,
               (SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'service', r.service, 'model', r.model,
                    'cost', coalesce(r.cost, e.amount), 'currency', CASE WHEN r.cost IS NOT NULL THEN r.currency WHEN e.amount IS NOT NULL THEN 'CNY' END,
                    'cost_basis', coalesce(r.cost_basis, CASE WHEN e.amount IS NOT NULL THEN 'estimated' END), 'at', r.created_at) ORDER BY r.id), '[]'::jsonb)
                  FROM receipts r LEFT JOIN LATERAL (
                    SELECT estimate_deepseek_v41_flash_cny(r.usage, r.created_at) AS amount
                    WHERE r.model IN ('deepseek-v4.1-flash', 'deepseek-flash') AND r.origin = 'live'
                  ) e ON true WHERE r.id = ANY(an.receipt_ids)) AS receipts
        FROM analyses an WHERE an.article_id = ${id} ORDER BY an.created_at DESC LIMIT 10`,
      tx`SELECT * FROM publications WHERE article_id = ${id}`,
      tx`SELECT fields, visibility, reason, version, updated_by, updated_at FROM editorial_overrides WHERE article_id = ${id}`,
      tx`SELECT seq, op, visible_at, changed_at FROM selected_ledger WHERE article_id = ${id} ORDER BY seq DESC LIMIT 10`,
      tx`
        SELECT fa.fact_id, fa.role, fa.manual, f.public_id AS fact_public_id, f.title AS fact_title, st.id AS story_id, st.public_id AS story_public_id, st.title AS story_title
        FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id LEFT JOIN stories st ON st.id = f.story_id WHERE fa.article_id = ${id}`,
      tx`SELECT verdict, fact_id, story_id, receipt_id, candidates, created_at FROM grouping_decisions WHERE article_id = ${id} ORDER BY created_at DESC LIMIT 5`,
      tx`SELECT target_key, dedupe_key, status, attempts, response, created_at, sent_at FROM deliveries WHERE subject_id = ${id} ORDER BY created_at DESC`,
      tx`SELECT created_at, actor, action, reason, before, after FROM audit_log WHERE subject = ${`content:${id}`} ORDER BY created_at DESC LIMIT 20`,
    ]);
    const groupingVersion = await membershipVersion(id,tx);
    const heatSignals = await tx`SELECT ss.story_id,ss.kind,s.public_id AS story_public_id,s.title AS story_title
      FROM story_signals ss JOIN stories s ON s.id=ss.story_id WHERE ss.article_id=${id} ORDER BY ss.story_id`;
    return { groupingVersion, heatSignals, article, discoveries, revisions, analyses, publication: publication[0] ?? null, override: override[0] ?? null, ledger, membership, decisions, deliveries, history };
  });
}


const STALE = "这条内容的人工设置已被修改，请刷新后再操作";

/** The exact grouping decision shown to an editor, including heat-only membership and pending work. */
async function membershipVersion(id: string, db: Db): Promise<string> {
  const [article, members, signals, manual, pending] = await Promise.all([
    db`SELECT revision,processing_generation,grouped_at FROM articles WHERE id=${id}`,
    db`SELECT fa.fact_id,fa.role,fa.manual,f.story_id,s.merged_into FROM fact_articles fa
      JOIN facts f ON f.id=fa.fact_id LEFT JOIN stories s ON s.id=f.story_id WHERE fa.article_id=${id} ORDER BY fa.fact_id`,
    db`SELECT story_id,kind FROM story_signals WHERE article_id=${id} ORDER BY story_id`,
    db`SELECT reason,actor,created_at FROM grouping_overrides WHERE article_id=${id}`,
    db`SELECT requested_at FROM regroup_pending WHERE article_id=${id}`,
  ]);
  return sha256(stableJson({article,members,signals,manual,pending}));
}

const factPeers = (db: Db, id: string) => db<{ article_id: string }[]>`SELECT ${id}::text AS article_id
  UNION SELECT other.article_id FROM fact_articles own JOIN fact_articles other ON other.fact_id=own.fact_id
  WHERE own.article_id=${id} ORDER BY article_id`;
class FactPeersChanged extends Error {}

async function overrideRow(id: string, db: Db) {
  const [o] = await db<{ fields: Record<string, unknown>; visibility: string | null; version: number }[]>`SELECT fields, visibility, version FROM editorial_overrides WHERE article_id = ${id}`;
  return o ?? { fields: {}, visibility: null, version: 0 };
}

/**
 * Public / summary-only / withdrawn. Applies to the site, API, RSS, MCP, the sync ledger and the
 * search index through the one publication projection; ETags change with the content.
 */
export async function setVisibility(id: string, input: { visibility: "public" | "summary-only" | "withdrawn"; reason: string; version: number }, actor: string) {
  if (!input.reason?.trim()) throw new Error("reason is required");
  if (!["public", "summary-only", "withdrawn"].includes(input.visibility)) throw Object.assign(new Error("unknown visibility"), { statusCode: 400 });
  return sql.begin(async tx => {
    if (!(await tx`SELECT id FROM articles WHERE id=${id} FOR UPDATE`).length) return null;
    const before = await overrideRow(id, tx);
    if (before.version !== input.version) throw new Conflict(STALE);
    const written = await tx`
      INSERT INTO editorial_overrides (article_id, visibility, reason, version, updated_by) VALUES (${id}, ${input.visibility}, ${input.reason}, 1, ${actor})
      ON CONFLICT (article_id) DO UPDATE SET visibility = EXCLUDED.visibility, reason = EXCLUDED.reason, version = editorial_overrides.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()
      WHERE editorial_overrides.version = ${input.version}
      RETURNING version`;
    if (!written.count) throw new Conflict(STALE);
    const published = await publishArticleTx(tx, id);
    // Saved rankings already validate current visibility on reads; refresh their scores in the worker.
    if (published?.reduced || (before.visibility ?? "public") !== input.visibility) {
      await enqueue("cron.hot.rank", {}, { singletonKey: `publication:${id}` }, tx);
    }
    await audit(actor, "content.visibility", `content:${id}`, input.reason, { visibility: before.visibility }, { visibility: input.visibility }, undefined, tx);
    return published;
  });
}

/** Marks a detail page for search indexing (sitemap, IndexNow, robots) or removes the mark. */
export async function setSeoIndexed(id: string, input: { indexed: boolean; reason: string }, actor: string) {
  if (!input.reason?.trim()) throw new Error("reason is required");
  if (typeof input.indexed !== "boolean") throw Object.assign(new Error("indexed must be boolean"), { statusCode: 400 });
  return sql.begin(async tx => {
    if (!(await tx`SELECT id FROM articles WHERE id=${id} FOR UPDATE`).length) return null;
    const [before] = await tx<{ seo_indexed_at: Date | null; indexable: boolean }[]>`SELECT seo_indexed_at, indexable FROM publications WHERE article_id = ${id}`;
    if (!before) return null;
    // Marking indexes the page; unmarking excludes it, so a selected page is not indexed again automatically.
    await tx`UPDATE publications SET seo_indexed_at = ${input.indexed ? (before.seo_indexed_at ?? new Date()) : null},
                seo_excluded_at = ${input.indexed ? null : new Date()} WHERE article_id = ${id}`;
    const published = await publishArticleTx(tx, id);
    await audit(actor, "content.seo", `content:${id}`, input.reason, { indexed: before.indexable }, { indexed: input.indexed }, undefined, tx);
    return published;
  });
}

const FieldsSchema = z
  .object({
    title: z.string().min(1).max(300),
    summary: z.string().max(2000),
    reason: z.string().max(1000),
    category: z.enum(CATEGORY_KEYS as unknown as [string, ...string[]]),
    tags: z.array(z.string().max(60)).max(20),
    selected: z.boolean(),
    silent: z.boolean(),
  })
  .partial()
  .strict();

/** Manual corrections win over model output; null clears a correction. */
export async function overrideFields(id: string, input: { fields: unknown; clear?: string[]; reason: string; version: number }, actor: string) {
  if (!input.reason?.trim()) throw new Error("reason is required");
  const fields = FieldsSchema.parse(input.fields ?? {});
  return sql.begin(async tx => {
    if (!(await tx`SELECT id FROM articles WHERE id=${id} FOR UPDATE`).length) return null;
    const before = await overrideRow(id, tx);
    if (before.version !== input.version) throw new Conflict(STALE);
    const next = { ...before.fields, ...fields };
    for (const k of input.clear ?? []) delete (next as Record<string, unknown>)[k];
    const written = await tx`
      INSERT INTO editorial_overrides (article_id, fields, reason, version, updated_by) VALUES (${id}, ${tx.json(next as never)}, ${input.reason}, 1, ${actor})
      ON CONFLICT (article_id) DO UPDATE SET fields = EXCLUDED.fields, reason = EXCLUDED.reason, version = editorial_overrides.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()
      WHERE editorial_overrides.version = ${input.version}
      RETURNING version`;
    if (!written.count) throw new Conflict(STALE);
    const published = await publishArticleTx(tx, id);
    await audit(actor, "content.override", `content:${id}`, input.reason, before.fields, next, undefined, tx);
    return published;
  });
}

/**
 * Re-runs a pipeline step for the current revision. Re-evaluation is a new paid model call bound to
 * the request id, so submitting the same request twice neither enqueues nor pays twice.
 */
export async function rerun(id: string, step: "extract" | "analyze" | "group", requestId: string, actor: string) {
  if (!["extract", "analyze", "group"].includes(step)) throw Object.assign(new Error("unknown pipeline step"), { statusCode: 400 });
  if (!/^[\w-]{8,80}$/.test(requestId)) throw Object.assign(new Error("a stable request id is required"), { statusCode: 400 });
  return sql.begin(async tx => {
    const [input]=await tx<{revision:number;generation:number}[]>`SELECT revision,processing_generation AS generation FROM articles WHERE id=${id} FOR UPDATE`;
    if (!input) return null;
    // Queue singleton keys expire when jobs finish. The committed command audit survives that expiry.
    const [previous]=await tx<{after:{jobId:string|null}}[]>`SELECT after FROM audit_log
      WHERE subject=${`content:${id}`} AND action=${`content.rerun.${step}`} AND request_id=${requestId} ORDER BY id LIMIT 1`;
    if (previous) return { jobId: previous.after.jobId };
    let jobId: string | null;
    if (step === "group") {
      jobId=await enqueue(QUEUES.group,{articleId:id,force:true,revision:input.revision,generation:input.generation},
        {singletonKey:`manual:group:${id}:${requestId}`},tx);
      if(jobId){
        await tx`DELETE FROM grouping_overrides WHERE article_id=${id}`;
        await tx`INSERT INTO regroup_pending(article_id) VALUES(${id}) ON CONFLICT(article_id) DO UPDATE SET requested_at=now()`;
      }
    } else {
      await tx`UPDATE articles SET processing_state='new',processing_error=NULL,processing_attempts=0,processing_retry_at=NULL,
        body_status=CASE WHEN ${step==='extract'} THEN 'pending' ELSE body_status END WHERE id=${id}`;
      jobId=await (step==='analyze'
        ? queueProcessing(id,{step:'analyze',attemptTag:`admin:${requestId}`,db:tx})
        : queueProcessing(id,{step:'extract',db:tx}));
    }
    await audit(actor, `content.rerun.${step}`, `content:${id}`, null, null, { jobId, requestId }, requestId, tx);
    return { jobId };
  });
}

/**
 * Takes an article out of its fact; it is shown on its own again and stays that way (automatic
 * grouping, retries and later revisions do not re-attach it; an explicit regroup does). Its heat
 * evidence leaves the old story, whose digest is rewritten.
 */
export async function detachFromFact(id: string, reason: string, actor: string, options: { version?: string } = {}) {
  if (typeof reason !== 'string' || !reason.trim()) throw Object.assign(new Error('reason is required'),{statusCode:400});
  for (let attempt=0;attempt<4;attempt++) {
    try { return await sql.begin(async tx => {
      const peers=await factPeers(tx,id),ids=peers.map(p=>p.article_id);
      // Republish the other reports under the same article → story → fact → publication lock order as a merge.
      const locked=await tx<{id:string}[]>`SELECT id FROM articles WHERE id=ANY(${ids}) ORDER BY id FOR UPDATE`;
      if (!locked.some(a=>a.id===id)) return null;
      await tx`SELECT pg_advisory_xact_lock_shared(hashtext('report_candidates'))`;
      const affected=await tx<{id:number}[]>`SELECT s.id FROM stories s WHERE s.id IN (
        SELECT f.story_id FROM fact_articles fa JOIN facts f ON f.id=fa.fact_id WHERE fa.article_id=ANY(${ids})) OR s.id IN (
        SELECT p.story_id FROM publications p WHERE p.article_id=ANY(${ids})) OR s.id IN (
        SELECT ss.story_id FROM story_signals ss WHERE ss.article_id=${id}) ORDER BY s.id FOR UPDATE`;
      if (stableJson(peers)!==stableJson(await factPeers(tx,id))) throw new FactPeersChanged();
      if (options.version!==undefined && options.version!==await membershipVersion(id,tx)) throw new Conflict('事件归属已改变，请刷新后再操作');
      await tx`SELECT f.id FROM facts f WHERE EXISTS(SELECT 1 FROM fact_articles fa WHERE fa.fact_id=f.id AND fa.article_id=${id}) ORDER BY f.id FOR UPDATE`;
      await tx`SELECT article_id FROM publications WHERE article_id=ANY(${ids}) ORDER BY article_id FOR UPDATE`;
      await tx`SELECT id FROM sources WHERE id IN (SELECT source_id FROM articles WHERE id=ANY(${ids})) ORDER BY id FOR SHARE`;
      const removed = await tx<{ fact_id: number }[]>`DELETE FROM fact_articles WHERE article_id = ${id} RETURNING fact_id`;
      const factIds = removed.map((r) => r.fact_id);
      const storyRows = factIds.length ? await tx<{ story_id: number }[]>`SELECT DISTINCT story_id FROM facts WHERE id = ANY(${factIds}) AND story_id IS NOT NULL` : [];
      const signals=await tx<{story_id:number}[]>`DELETE FROM story_signals WHERE article_id=${id} RETURNING story_id`;
      const storyIds = [...new Set([...storyRows.map(r=>r.story_id),...signals.map(r=>r.story_id)])].sort((a,b)=>a-b);
      await tx`INSERT INTO grouping_overrides (article_id, reason, actor) VALUES (${id}, ${reason}, ${actor})
               ON CONFLICT (article_id) DO UPDATE SET reason = EXCLUDED.reason, actor = EXCLUDED.actor, created_at = now()`;
      await tx`DELETE FROM regroup_pending WHERE article_id=${id}`;
      await tx`UPDATE articles SET grouped_at = clock_timestamp() WHERE id = ${id}`;
      await invalidateStoryDigests(tx,storyIds,id,factIds);
      await publishArticleTx(tx,id);
      // The detached projection must leave before the remaining reports choose their new anchor.
      for (const other of ids) if (other!==id) await publishArticleTx(tx,other);
      if (storyIds.length || affected.length) await enqueue('cron.hot.rank',{}, {singletonKey:`publication:${id}`},tx);
      await audit(actor,'content.detach',`content:${id}`,reason,{facts:factIds,stories:storyIds},null,undefined,tx);
      return {detached:factIds.length};
    }); } catch(error) { if (!(error instanceof FactPeersChanged)) throw error; }
  }
  throw new Conflict('事件报道已改变，请刷新后再操作');
}

/** Merges one story into another: facts move, the old public id keeps working as an alias. */
export async function mergeStories(fromId: number, intoId: number, reason: string, actor: string) {
  if (fromId === intoId) throw new Error("cannot merge a story into itself");
  const done = await mergeStoryInto(fromId, intoId, reason, actor);
  if (done) return done;
  const found = await sql<{ id: number }[]>`SELECT id FROM stories WHERE id IN (${fromId}, ${intoId})`;
  if (found.length < 2) throw new Error("story not found");
  throw new Conflict("两个事件都必须是未合并的事件");
}
