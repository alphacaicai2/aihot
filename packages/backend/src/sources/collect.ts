// Collection run for one source: fetch listing → filter → store material → enqueue processing.
// A failed fetch never advances the success cursor; the source's health reflects consecutive failures.
import { sql, type Db, type Tx } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { identityKeyFor, upsertMaterial } from "../content/materials.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { queueProcessing } from "../jobs/content.ts";
import { BudgetExceededError } from "../providers/receipts.ts";
import { fetchRss, type RssRead } from "./rss.ts";
import { allowed, fetchDetail, fetchWebList, type DetailNeed } from "./web-list.ts";
import { unsupportedConfig } from "./config-keys.ts";
import { longFailedSource } from "./health.ts";
import { fetchJsonList } from "./json-list.ts";
import { fetchXSearch, planXShards, readXSearch, shardHandle, shardQuery, SHARDABLE_SQL, tweetToCandidate, type XBacklog, type XRead } from "./x.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";

export interface CollectResult {
  sourceId: string;
  status: "ok" | "failed" | "skipped";
  found: number;
  created: number;
  revised: number;
  error?: string;
}

const MAX_ITEMS_PER_RUN = 60;

export function noiseFiltered(c: Candidate, source: SourceRow): boolean {
  const f = source.config.ingestNoiseFilter;
  const cats: string[] = c.categories ?? [];
  if (source.config.denyCategories?.some((d: string) => cats.includes(d))) return true;
  if (source.config.allowCategories?.length && !source.config.allowCategories.some((a: string) => cats.includes(a))) return true;
  if (!f) return false;
  // Case-insensitive: the exemption "agent" keeps "Agent" (words in the lists are lower case).
  const has = (text: string, words: string[] | undefined) => (words ?? []).some((k) => text.includes(k.toLowerCase()));
  const title = c.title.toLowerCase();
  const hay = `${title}\n${(c.excerpt ?? "").toLowerCase()}`;
  if (has(hay, f.keepIfMatches)) return false;
  return has(title, f.dropMarkersTitleOnly) || has(hay, f.dropMarkers);
}

function rewriteUrl(c: Candidate, source: SourceRow): Candidate {
  const rw = source.config.itemUrlPrefixRewrite;
  if (rw?.from && rw?.to && c.url.startsWith(rw.from)) return { ...c, url: rw.to + c.url.slice(rw.from.length) };
  return c;
}

async function loadSource(id: string): Promise<SourceRow | null> {
  const [s] = await sql<SourceRow[]>`
    SELECT id, name, kind, config, tier, participation_mode, first_party, interval_minutes, enabled, cursor, fail_count
    FROM sources WHERE id = ${id}`;
  return s ?? null;
}

/** Titles of the articles already stored under these URLs. */
async function storedTitles(urls: string[]): Promise<Map<string, string>> {
  if (urls.length === 0) return new Map();
  const rows = await sql<{ url: string; title: string }[]>`SELECT url, title FROM articles WHERE url IN ${sql(urls)}`;
  return new Map(rows.map((r) => [r.url, r.title]));
}

const DAY_MS = 86_400_000;
/** A listing title that is no headline: a label that swallowed its summary, or a call to action. */
const needsTitle = (title: string) => title.length > 100 || /^(read more|learn more|continue reading|more|阅读全文|阅读更多|查看详情|了解更多)$/i.test(title.trim());

async function store(sourceId: string, candidates: Candidate[], backfill: string | null, tx?: Tx): Promise<{ created: number; revised: number }> {
  let created = 0;
  let revised = 0;
  const seen = new Set<string>();
  for (const c of candidates) {
    const material = { ...c, sourceId, via: "fetch" as const, backfill: c.backfill ?? backfill };
    // A listing that names one article twice (a featured card and its list entry, a feed repeating an
    // item) stores its first entry only; the later ones would otherwise revise it on every fetch.
    const key = identityKeyFor(material);
    if (seen.has(key)) continue;
    seen.add(key);
    const res = await upsertMaterial(material, tx);
    if (res.created) created += 1;
    if (res.revised) revised += 1;
    // Extraction first when the source wants full text and none came with the listing, else analysis.
    if (res.created || res.revised) await queueProcessing(res.articleId, { db: tx });
  }
  return { created, revised };
}

interface RssBacklog {
  fetchId: number;
  nextPage: number;
  pages: number;
  mode: string;
  validator: RssRead["validator"];
}

type SavedEntry = Omit<Candidate, "publishedAt" | "sourceUpdatedAt" | "discoveredAt"> & {
  publishedAt?: string | null; sourceUpdatedAt?: string | null; discoveredAt?: string;
};

async function readRssPage(sourceId: string, backlog: RssBacklog) {
  const [row] = await sql<{ entries: SavedEntry[] }[]>`
    SELECT entries FROM source_rss_pages WHERE source_id=${sourceId} AND fetch_id=${backlog.fetchId} AND page=${backlog.nextPage}`;
  return row?.entries.map(c => ({ ...c,
    publishedAt: c.publishedAt ? new Date(c.publishedAt) : null,
    sourceUpdatedAt: c.sourceUpdatedAt ? new Date(c.sourceUpdatedAt) : null,
    discoveredAt: c.discoveredAt ? new Date(c.discoveredAt) : undefined,
  }));
}

/** Check the cursor again after fetching outside the transaction. */
async function lockSourceCursor(tx: Tx, source: SourceRow) {
  const [current] = await tx`SELECT id FROM sources WHERE id=${source.id} AND kind=${source.kind}
    AND config=${tx.json(source.config as never)} AND participation_mode=${source.participation_mode}
    AND cursor IS NOT DISTINCT FROM ${source.cursor ? tx.json(source.cursor as never) : null}::jsonb FOR NO KEY UPDATE`;
  return !!current;
}

export async function collectSource(sourceId: string, opts: { force?: boolean } = {}): Promise<CollectResult> {
  const source = await loadSource(sourceId);
  if (!source) return { sourceId, status: "skipped", found: 0, created: 0, revised: 0, error: "missing" };
  if (!source.enabled && !opts.force) return { sourceId, status: "skipped", found: 0, created: 0, revised: 0, error: "paused" };
  if (source.kind === "mp_account" || source.kind === "external") {
    // WeChat accounts are reconciled by the mp job; external sources only receive reports.
    return { sourceId, status: "skipped", found: 0, created: 0, revised: 0 };
  }

  const [run] = await sql<{ id: number }[]>`INSERT INTO fetch_runs (source_id) VALUES (${sourceId}) RETURNING id`;
  const firstImport = !source.cursor?.initializedAt;
  let created = 0;
  let revised = 0;
  let found = 0;
  let warning: string | null = null;
  const superseded = async (): Promise<CollectResult> => {
    await sql`UPDATE fetch_runs SET status='skipped', finished_at=now() WHERE id=${run!.id}`;
    return { sourceId, status: "skipped", found, created: 0, revised: 0 };
  };
  try {
    // A config entry this kind does not implement fails the run, visibly, instead of being ignored.
    const unsupported = unsupportedConfig(source.kind, source.config);
    if (unsupported.length) throw new FetchError(`unsupported config: ${unsupported.join(", ")}`);
    let candidates: Candidate[];
    const nextCursor: Record<string, unknown> = { ...(source.cursor ?? {}) };
    let detail: Record<string, unknown> | null = null;
    const nativeRss = source.kind === "rss" && source.config.minifluxFeedId === undefined;
    const saved = source.cursor?.rssBacklog as RssBacklog | undefined;
    let backlog = nativeRss && saved?.mode === source.participation_mode &&
      saved.validator.configHash === sha256(stableJson(source.config)) ? saved : undefined;
    let validator: RssRead["validator"] | undefined;
    delete nextCursor.rssBacklog;
    if (backlog) {
      const entries = await readRssPage(sourceId, backlog);
      if (!entries) {
        // Another collector may have committed this page while we were loading it.
        const current = await loadSource(sourceId);
        if (current?.cursor?.rssBacklog?.fetchId !== backlog.fetchId ||
            current.cursor.rssBacklog.nextPage !== backlog.nextPage) return superseded();
        throw new Error("RSS backlog page missing");
      }
      candidates = entries;
      validator = backlog.validator;
      if (backlog.nextPage + 1 < backlog.pages) nextCursor.rssBacklog = { ...backlog, nextPage: backlog.nextPage + 1 };
      else nextCursor.rss = validator;
    } else if (source.kind === "rss") {
      // Older collectors could save validators after storing only the first 60 entries.
      const legacyWindow = nativeRss && !source.cursor?.rss?.fullWindow;
      const rss = await fetchRss(source, { force: opts.force || legacyWindow });
      candidates = rss.candidates;
      validator = rss.validator;
      warning = rss.warning ?? null;
      // The first import has a smaller backfill cap than later runs: allow the next run to read
      // the ordinary window before accepting 304s. Persist validators only after store succeeds.
      if (!firstImport || rss.validator.miniflux) nextCursor.rss = rss.validator;
      else delete nextCursor.rss;
      if (rss.notModified) detail = { notModified: true, httpStatus: 304 };
    }
    else if (source.kind === "web_list") candidates = await fetchWebList(source);
    else if (source.kind === "json_list") candidates = await fetchJsonList(source);
    else {
      const x = await fetchXSearch(source);
      candidates = x.candidates;
      if (x.lastId) nextCursor.lastTweetId = x.lastId;
      // A search longer than one run keeps its position for the next runs (shown in the admin).
      if (x.backlog.length) nextCursor.xBacklog = x.backlog;
      else delete nextCursor.xBacklog;
      detail = { pages: x.pages, truncated: x.truncated, backlog: x.backlog.length, backlogPages: x.backlogPages, dropped: x.dropped };
    }
    found = candidates.length;
    if (!backlog) {
      candidates = candidates.filter((c) => allowed(c.url, source)).map((c) => rewriteUrl(c, source)).filter((c) => !noiseFiltered(c, source));
      if (source.config.sortByPublishedAt) candidates.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
    }

    // An opt-in subscription baseline keeps the unimported stock out of later live polls. A new
    // URL still enters normally; changed stock is collected as an update to an existing baseline.
    let initialRemainder: Record<string, string> | null = null;
    if (source.config._aihot?.skipInitialRemainder === true && source.kind !== "x_search" && source.config.minifluxFeedId === undefined) {
      initialRemainder = { ...(source.cursor?.initialRemainder ?? {}) };
      const seen = new Set<string>();
      if (!backlog) candidates = candidates.filter((c) => {
        const key = sha256(identityKeyFor({ ...c, sourceId, via: "fetch" }));
        if (seen.has(key)) return false;
        seen.add(key);
        const signature = sha256(stableJson({ title: c.title, excerpt: c.excerpt ?? null,
          bodyText: c.bodyText ?? null, publishedAt: c.publishedAt?.toISOString() ?? null }));
        if (firstImport) { initialRemainder![key] = signature; return true; }
        if (initialRemainder![key] === signature) return false;
        if (initialRemainder![key]) c.backfill ??= "initial-baseline-update";
        return true;
      });
    }

    // First import of a new source: bounded, and archived by source time (never "today", never pushed).
    const backfillLimit = Number(source.config._aihot?.initialBackfillLimit ?? 30);
    const backfillMonths = Number(source.config._aihot?.initialBackfillMonths ?? 12);
    if (firstImport) {
      const cutoff = Date.now() - backfillMonths * 30 * 86400000;
      candidates = candidates.filter((c) => !c.publishedAt || c.publishedAt.getTime() >= cutoff).slice(0, backfillLimit);
    } else if (nativeRss && candidates.length > MAX_ITEMS_PER_RUN) {
      // Keep the first mention, including when a duplicate would land on a later page.
      const seen = new Set<string>();
      const unique = candidates.filter(c => {
        const key = identityKeyFor({ ...c, sourceId, via: "fetch" });
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      candidates = unique.slice(0, MAX_ITEMS_PER_RUN);
      if (unique.length > MAX_ITEMS_PER_RUN) {
        const snapshot: RssBacklog = { fetchId: run!.id, nextPage: 0, pages: Math.ceil(unique.length / MAX_ITEMS_PER_RUN),
          mode: source.participation_mode, validator: validator! };
        const stagedCursor = { ...source.cursor, rssBacklog: snapshot };
        const observedAt = new Date();
        const staged = await sql.begin(async tx => {
          if (!await lockSourceCursor(tx, source)) return false;
          await tx`DELETE FROM source_rss_pages WHERE source_id=${sourceId}`;
          for (let page = 0; page < snapshot.pages; page++) {
            const entries = unique.slice(page * MAX_ITEMS_PER_RUN, (page + 1) * MAX_ITEMS_PER_RUN)
              .map(entry => ({ ...entry, discoveredAt: observedAt }));
            await tx`INSERT INTO source_rss_pages(source_id, fetch_id, page, entries)
              VALUES (${sourceId}, ${snapshot.fetchId}, ${page}, ${tx.json(entries as never)})`;
          }
          await tx`UPDATE sources SET cursor=${tx.json(stagedCursor as never)} WHERE id=${sourceId}`;
          return true;
        });
        if (!staged) return superseded();
        source.cursor = stagedCursor;
        backlog = snapshot;
        candidates = candidates.map(entry => ({ ...entry, discoveredAt: observedAt }));
        nextCursor.rssBacklog = { ...snapshot, nextPage: 1 };
        // Do not acknowledge this response until all its material and jobs have committed.
        if (source.cursor.rss) nextCursor.rss = source.cursor.rss;
        else delete nextCursor.rss;
      }
    } else if (source.kind !== "x_search") {
      // X keeps every post it read: its watermark already covers them, so a cut here would lose them.
      candidates = candidates.slice(0, MAX_ITEMS_PER_RUN);
    }

    if (nativeRss && !nextCursor.rssBacklog && nextCursor.rss) {
      nextCursor.rss = { ...nextCursor.rss, fullWindow: true };
    }

    // Detail pages only for material we have not seen (bounded per run), and only for what the listing lacks.
    const d = source.config.detail;
    const known = await storedTitles(candidates.map((c) => c.url));
    const detailBudget = Number(d?.maxFetches ?? 0);
    let detailUsed = 0;
    for (const c of candidates) {
      // Listing dates the source marks unreliable are dropped; the detail page's rule decides.
      if (d?.publishedAtAuthoritative === true) c.publishedAt = null;
      const stored = known.get(c.url);
      if (stored !== undefined) {
        // The title came from the detail page: the listing's own rendering must not revise it back.
        if (d?.titleSelector || d?.titleRegex) c.title = stored;
        continue;
      }
      if (!d || detailUsed >= detailBudget) continue;
      const need: DetailNeed = {
        date: !c.publishedAt || d.upgradeDatePrecision === true,
        title: !!(d.titleSelector || d.titleRegex) && (d.titleAuthoritative === true || needsTitle(c.title)),
        summary: !!d.summarySelector && !c.excerpt,
        body: source.participation_mode === "editorial" && !c.bodyText && (!c.bodyStatus || c.bodyStatus === "pending"),
      };
      if (!need.date && !need.title && !need.summary) continue;
      detailUsed += 1;
      try {
        const got = await fetchDetail(c.url, source, need);
        if (got.title) c.title = got.title;
        if (got.summary) c.excerpt = got.summary;
        // The same Readability path as extraction, using bytes already fetched for the detail rules.
        // A confirmed body enters through normal material revisions and skips the redundant fetch job.
        if (got.body) {
          c.bodyHtml = got.body.html;
          c.bodyText = got.body.text;
          c.bodyStatus = "ok";
          if (!c.media?.length) c.media = got.body.images;
        }
        // A date-only listing value gives way to the detail page's time on the same day.
        if (got.publishedAt && (!c.publishedAt || Math.abs(got.publishedAt.getTime() - c.publishedAt.getTime()) < DAY_MS)) c.publishedAt = got.publishedAt;
      } catch {
        // detail is best effort
      }
    }

    // Only a successful storage removes a changed entry from the suppressed baseline. Entries
    // beyond this run's cap stay suppressed (or pending when changed) until a later successful run.
    if (initialRemainder) {
      for (const c of candidates) delete initialRemainder[sha256(identityKeyFor({ ...c, sourceId, via: "fetch" }))];
      nextCursor.initialRemainder = initialRemainder;
    }

    if (firstImport) nextCursor.initializedAt = new Date().toISOString();
    nextCursor.lastOkAt = new Date().toISOString();
    const savePage = async (tx?: Tx) => {
      const db = tx ?? sql;
      ({ created, revised } = await store(sourceId, candidates, firstImport ? "first-import" : null, tx));
      await db`
        UPDATE sources SET last_fetch_at = now(), last_ok_at = now(), fail_count = 0,
          health = ${warning ? "degraded" : "ok"}, last_error = ${warning}, cursor = ${db.json(nextCursor as never)}, updated_at = now(),
          next_fetch_at = now() + make_interval(mins => CASE WHEN ${!!nextCursor.rssBacklog} THEN 0 ELSE interval_minutes END)
        WHERE id = ${sourceId}`;
    };
    if (nativeRss || saved) {
      const committed = await sql.begin(async tx => {
        // Serialize commits, not network reads. A manual and a scheduled poll may overlap.
        if (!await lockSourceCursor(tx, source)) return false;
        if (saved && !backlog) await tx`DELETE FROM source_rss_pages WHERE source_id=${sourceId}`;
        if (backlog) await tx`DELETE FROM source_rss_pages WHERE source_id=${sourceId} AND fetch_id=${backlog.fetchId} AND page=${backlog.nextPage}`;
        await savePage(tx);
        return true;
      });
      if (!committed) return superseded();
    } else {
      await savePage();
    }
    await sql`UPDATE fetch_runs SET status = 'ok', finished_at = now(), found_count = ${found}, new_count = ${created},
                detail = ${detail ? sql.json(detail as never) : null} WHERE id = ${run!.id}`;
    return { sourceId, status: "ok", found, created, revised };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 1000);
    const budget = error instanceof BudgetExceededError;
    const recordFailure = (db: Db) => db`
      UPDATE sources SET last_fetch_at = now(),
        fail_count = CASE WHEN ${budget} THEN fail_count ELSE fail_count + 1 END,
        last_error = ${message},
        health = CASE WHEN ${budget} THEN health WHEN fail_count + 1 >= 5 THEN 'failing' ELSE 'degraded' END,
        next_fetch_at = now() + make_interval(mins => CASE WHEN ${budget} THEN 15 WHEN ${longFailedSource(true)} THEN greatest(interval_minutes, 1440) ELSE LEAST(interval_minutes * (fail_count + 2), 360) END),
        updated_at = now()
      WHERE id = ${sourceId}`;
    if (source.kind === "rss" && source.config.minifluxFeedId === undefined) {
      const current = await sql.begin(async tx => {
        if (!await lockSourceCursor(tx, source)) return false;
        await recordFailure(tx);
        return true;
      });
      if (!current) return superseded();
    } else {
      await recordFailure(sql);
    }
    await sql`UPDATE fetch_runs SET status = 'failed', finished_at = now(), found_count = ${found}, new_count = ${created}, error = ${message} WHERE id = ${run!.id}`;
    return { sourceId, status: "failed", found, created, revised, error: message };
  }
}

/** X ids begin with their millisecond timestamp (since 2010-11-04): the smallest id of a post made at `ms`. */
const xIdAt = (ms: number) => (BigInt(Math.max(0, ms - 1288834974657)) << 22n);

/**
 * Where an account's posts are known to be read up to. A quiet account's newest post can be months
 * old, but its last successful check read everything up to then; bounding a shard's search by the
 * post alone would re-read months of the other accounts' posts. Ten minutes before the check allows
 * for posts that reach the search late.
 */
function coveredTo(m: SourceRow): bigint {
  const own = BigInt(m.cursor!.lastTweetId);
  const checked = Date.parse(String(m.cursor?.lastOkAt ?? ""));
  if (!Number.isFinite(checked)) return own;
  const byTime = xIdAt(checked - 10 * 60_000);
  return byTime > own ? byTime : own;
}

/** Minutes between reads of a shard: editorial accounts every half hour, hot-signal accounts hourly. */
const X_SHARD_MINUTES: Record<string, number> = { editorial: 30, hot_signal: 60 };
const shardMinutes = (mode: string) => X_SHARD_MINUTES[mode] ?? 60;

/**
 * One search for a shard of X accounts (planXShards). Each post goes to the source whose handle wrote
 * it, and every account keeps its own fetch run, health and cursor. The oldest watermark bounds the
 * search, so no account misses a post (the others only see posts they already have again); afterwards
 * every account is covered up to the newest post the search saw, and the stretches still unread are
 * kept in each account's cursor, so they survive a change of shards.
 */
export async function collectXShard(key: string, sourceIds: string[]): Promise<{ key: string; status: "ok" | "failed" | "skipped"; accounts: number; found: number; created: number; error?: string }> {
  const members = (
    await sql<SourceRow[]>`
      SELECT id, name, kind, config, tier, participation_mode, first_party, interval_minutes, enabled, cursor, fail_count
      FROM sources WHERE id IN ${sql(sourceIds)}`
  ).filter((m) => m.enabled && shardHandle(m));
  if (members.length === 0) return { key, status: "skipped", accounts: 0, found: 0, created: 0 };
  const minutes = shardMinutes(members[0]!.participation_mode);
  const runs = new Map<string, number>();
  for (const m of members) runs.set(m.id, (await sql<{ id: number }[]>`INSERT INTO fetch_runs (source_id) VALUES (${m.id}) RETURNING id`)[0]!.id);

  const since = members.map(coveredTo).reduce((a, b) => (b < a ? b : a));
  const backlog: XBacklog[] = [];
  const stretches = new Set<string>();
  for (const m of members) {
    for (const b of (Array.isArray(m.cursor?.xBacklog) ? m.cursor.xBacklog : []) as XBacklog[]) {
      if (!stretches.has(`${b.query} ${b.next}`)) backlog.push(b);
      stretches.add(`${b.query} ${b.next}`);
    }
  }
  let read: XRead;
  try {
    read = await readXSearch(shardQuery(members.map((m) => shardHandle(m)!)), { lastId: String(since), backlog, subject: `x-shard:${key}` });
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 1000);
    const budget = error instanceof BudgetExceededError;
    for (const m of members) {
      await sql`
        UPDATE sources SET last_fetch_at = now(),
          fail_count = CASE WHEN ${budget} THEN fail_count ELSE fail_count + 1 END,
          last_error = ${message},
          health = CASE WHEN ${budget} THEN health WHEN fail_count + 1 >= 5 THEN 'failing' ELSE 'degraded' END,
          next_fetch_at = now() + make_interval(mins => CASE WHEN ${budget} THEN 15 ELSE LEAST(${minutes} * (fail_count + 2), 360) END),
          updated_at = now()
        WHERE id = ${m.id}`;
      await sql`UPDATE fetch_runs SET status = 'failed', finished_at = now(), error = ${message}, detail = ${sql.json({ shard: key, accounts: members.length })} WHERE id = ${runs.get(m.id)!}`;
    }
    return { key, status: "failed", accounts: members.length, found: 0, created: 0, error: message };
  }

  const detail = { shard: key, accounts: members.length, pages: read.pages, truncated: read.truncated, backlog: read.backlog.length, backlogPages: read.backlogPages, dropped: read.dropped };
  let found = 0;
  let created = 0;
  for (const m of members) {
    const handle = shardHandle(m)!.toLowerCase();
    const mine = read.tweets.filter((t) => t.user.screen_name.toLowerCase() === handle);
    const stored = await store(m.id, mine.map(tweetToCandidate).map((c) => rewriteUrl(c, m)).filter((c) => !noiseFiltered(c, m)), null);
    found += mine.length;
    created += stored.created;
    const own = String(m.cursor!.lastTweetId);
    const cursor: Record<string, unknown> = { ...m.cursor, lastTweetId: read.lastId && BigInt(read.lastId) > BigInt(own) ? read.lastId : own, lastOkAt: new Date().toISOString() };
    if (read.backlog.length) cursor.xBacklog = read.backlog;
    else delete cursor.xBacklog;
    await sql`
      UPDATE sources SET last_fetch_at = now(), last_ok_at = now(), fail_count = 0, last_error = NULL,
        health = 'ok', cursor = ${sql.json(cursor as never)}, interval_minutes = ${minutes}, updated_at = now(),
        next_fetch_at = now() + make_interval(mins => ${minutes})
      WHERE id = ${m.id}`;
    await sql`UPDATE fetch_runs SET status = 'ok', finished_at = now(), found_count = ${mine.length}, new_count = ${stored.created},
                detail = ${sql.json(detail as never)} WHERE id = ${runs.get(m.id)!}`;
  }
  return { key, status: "ok", accounts: members.length, found, created };
}

/** X accounts read by shard: a plain query and a watermark (the first fetch of an account is its own). */
const sharded = () => sql`kind = 'x_search' AND config->>'query' ~* ${SHARDABLE_SQL} AND coalesce(config->>'searchType', 'Latest') = 'Latest' AND cursor->>'lastTweetId' IS NOT NULL`;

/** Every minute: a shard is read when any of its accounts is due, all of them at once. */
async function scheduleXShards(): Promise<number> {
  const rows = await sql<Array<Pick<SourceRow, "id" | "kind" | "config" | "cursor" | "participation_mode"> & { due: boolean }>>`
    SELECT id, kind, config, cursor, participation_mode, (next_fetch_at IS NULL OR next_fetch_at <= now()) AS due
    FROM sources WHERE enabled AND ${sharded()}`;
  const due = new Set(rows.filter((r) => r.due).map((r) => r.id));
  let enqueued = 0;
  for (const shard of planXShards(rows)) {
    if (!shard.sourceIds.some((id) => due.has(id))) continue;
    await enqueue(QUEUES.fetchXShard, { key: shard.key, sourceIds: shard.sourceIds }, { singletonKey: shard.key });
    await sql`UPDATE sources SET next_fetch_at = now() + interval '10 minutes' WHERE id IN ${sql(shard.sourceIds)}`;
    enqueued += 1;
  }
  return enqueued;
}

/** Every minute: enqueue due sources (enabled, not WeChat/external), oldest due first; X accounts by shard. */
export async function scheduleDueSources(limit = Number(process.env.FETCH_SCHEDULE_BATCH || 40)): Promise<{ enqueued: number; shards: number }> {
  const kinds: string[] = (process.env.COLLECT_KINDS || "rss,web_list,json_list,x_search").split(",");
  // Listings fetched through Jina Reader are paid; development can leave them out.
  const skipJina = process.env.COLLECT_SKIP_JINA === "true";
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM sources
    WHERE enabled AND kind IN ${sql(kinds)} AND (next_fetch_at IS NULL OR next_fetch_at <= now()) AND NOT (${sharded()})
      ${skipJina ? sql`AND config::text NOT LIKE '%r.jina.ai%'` : sql``}
    ORDER BY next_fetch_at NULLS FIRST LIMIT ${limit}`;
  for (const r of rows) {
    await enqueue(QUEUES.fetchSource, { sourceId: r.id }, { singletonKey: r.id });
    await sql`UPDATE sources SET next_fetch_at = now() + interval '10 minutes' WHERE id = ${r.id}`;
  }
  const shards = kinds.includes("x_search") ? await scheduleXShards() : 0;
  return { enqueued: rows.length, shards };
}

/**
 * Daily: adapt each source's interval to its recent output (active 15 min … quiet 120 min).
 * hot_signal sources are allowed to be slower.
 */
export async function adaptIntervals(): Promise<{ updated: number }> {
  const rows = await sql<Array<Pick<SourceRow, "id" | "participation_mode" | "kind" | "config" | "cursor"> & { paid_listing: boolean; per_day: number }>>`
    SELECT s.id, s.participation_mode, s.kind, s.config, s.cursor, coalesce(s.config->>'url', '') LIKE 'https://r.jina.ai/%' AS paid_listing,
      (SELECT count(*) FROM articles a WHERE a.source_id = s.id AND a.discovered_at > now() - interval '7 days' AND NOT a.backfill) / 7.0 AS per_day
    FROM sources s WHERE s.enabled AND s.kind IN ('rss', 'web_list', 'json_list', 'x_search')`;
  let updated = 0;
  for (const r of rows) {
    const perDay = Number(r.per_day);
    // Editorial sites and feeds are looked at hourly at least (they cost nothing);
    // editorial X and listings read through Jina stop at two hours (paid per call, within their budgets);
    // hot signals may wait longer.
    const max = r.participation_mode === "hot_signal" ? 180 : r.kind === "x_search" || r.paid_listing ? 120 : 60;
    // Listings read through Jina are not looked at more than hourly: busy ones would outrun its daily budget.
    const min = r.paid_listing ? 60 : 15;
    // X accounts read by shard follow the shard's pace, whatever their own volume.
    const target = shardHandle(r) ? shardMinutes(r.participation_mode) : perDay <= 0.15 ? max : Math.round(Math.min(max, Math.max(min, (24 * 60) / (perDay * 3))));
    const res = await sql`UPDATE sources SET interval_minutes = ${target} WHERE id = ${r.id} AND interval_minutes <> ${target}`;
    updated += res.count;
  }
  return { updated };
}
