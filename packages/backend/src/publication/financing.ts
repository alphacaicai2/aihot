// All claims are joined through the currently published analysis, never a newer unpublished run.
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import type { FinancingClaim, FinancingResponse, FinancingReport } from "@aihot/contracts/financing";
import { researchDates } from "@aihot/contracts/research";
import { databaseClient, sql, type Db } from "../db.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import { financingIndexReady, financingJoins, financingSources, publicFinancing, type Mention } from "./financing-index.ts";
import { companyCondition, dealInvestorCondition } from "./research.ts";
import { financingInvestorNames } from "./investors.ts";
import { financingRounds } from "./financing-rounds.ts";
import { SearchBusyError, withSearchCapacity } from "./pool.ts";

export interface FinancingQuery { from?: string | null; to?: string | null; company?: string | null; companyHistory?: string; companiesOnly?: boolean; eventId?: string; investor?: string | null; investorExact?: boolean; cursor?: string | null; limit?: number }
type Cursor = { at: string; id: string; binding: string; before?: true } | null;
type Filter = ReturnType<typeof companyCondition>;
interface RoundPage {
  groups: { id: string; latest: number; members: Mention[] }[];
  historyRecords: number;
  latestReport: number;
  hasMore: boolean;
}

// Article ordinals can shift when an editor splits a digest. Anchor shared links to
// the source claim, so refreshed indices and later round merges keep the same target.
function evidenceId(article: string, claim: FinancingClaim) {
  const identity = [claim.kind, claim.company, claim.round, claim.evidence];
  const hash = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return `source:${article}:${hash}`;
}

type EventTarget = { roundId: string } | { article: string; seq: number };
async function resolveTarget(db: Db, id: string, now: Date): Promise<EventTarget | null> {
  if (id.startsWith("round:")) return { roundId:id };
  const article = id.split(":")[1]!;
  const rows = await db<{seq:number; claim:FinancingClaim; original_claim:FinancingClaim}[]>`
    SELECT deal.seq, deal.claim, deal.original_claim ${financingJoins}
    WHERE p.article_id=${article} AND ${publicFinancing(now)}`;
  const exact = rows.filter(r => evidenceId(article,r.claim) === id);
  const matches = exact.length ? exact : rows.filter(r => evidenceId(article,r.original_claim) === id);
  return matches.length === 1 ? {article, seq:matches[0]!.seq} : null;
}

async function livePage(db: Db, now: Date, filter: Filter, history: boolean, cursor: Cursor, limit: number, target?: EventTarget): Promise<RoundPage> {
  const groups = [];
  let historyRecords = 0;
  let latestReport = -Infinity;
  for (const [id, members] of financingRounds(await financingSources(db, now, filter))) {
    if (target && ("roundId" in target ? id !== target.roundId : !members.some(m => m.article_id === target.article && m.seq === target.seq))) continue;
    if (history) for (const m of members) m.timeline_at = m.reported_at ?? m.timeline_at;
    const matching = members.filter(m => m.matches);
    if (!matching.length) continue;
    const latest = Math.max(...matching.map(m => m.timeline_at.getTime()));
    historyRecords++;
    latestReport = Math.max(latestReport, latest);
    if (cursor) {
      const center = Date.parse(cursor.at);
      const relative = latest - center || (id === cursor.id ? 0 : id > cursor.id ? 1 : -1);
      if (cursor.before ? relative <= 0 : relative >= 0) continue;
    }
    groups.push({ id, latest, members });
  }
  groups.sort((a,b) => b.latest - a.latest || (a.id < b.id ? 1 : -1));
  return { groups: cursor?.before ? groups.slice(-limit) : groups.slice(0, limit), hasMore: groups.length > limit, historyRecords, latestReport };
}

async function indexedPage(db: Db, filter: Filter, history: boolean, cursor: Cursor, limit: number, target?: EventTarget): Promise<RoundPage> {
  const timeline = history ? sql`coalesce(deal.reported_at,deal.timeline_at)` : sql`deal.timeline_at`;
  const after = cursor ? sql`WHERE (latest,round_id) ${cursor.before ? sql`>` : sql`<`} (${new Date(cursor.at)}, ${cursor.id})` : sql``;
  const order = cursor?.before ? sql`latest ASC, round_id ASC` : sql`latest DESC, round_id DESC`;
  const selected = !target ? sql`` : "roundId" in target ? sql`AND deal.round_id=${target.roundId}`
    : sql`AND deal.round_id=(SELECT round_id FROM financing_index_members WHERE article_id=${target.article} AND seq=${target.seq})`;
  const rounds = await db<{ round_id: string; latest: Date; records: number; latest_report: Date }[]>`
    WITH matching AS (
      SELECT deal.round_id, max(${timeline}) AS latest FROM financing_index_members deal
      WHERE true ${filter} ${selected} GROUP BY deal.round_id
    )
    SELECT * FROM (SELECT matching.* ${history ? sql`, count(*) OVER () AS records, max(latest) OVER () AS latest_report` : sql``}
      FROM matching) rounds ${after} ORDER BY ${order} LIMIT ${limit+1}`;
  const groups = rounds.slice(0, limit).map(r => ({ id: r.round_id, latest: r.latest.getTime(), members: [] as Mention[] }));
  if (cursor?.before) groups.reverse();
  await indexedMembers(db, groups, timeline);
  return { groups, hasMore: rounds.length > limit, historyRecords: rounds[0]?.records ?? 0,
    latestReport: rounds[0]?.latest_report?.getTime() ?? -Infinity };
}

async function indexedMembers(db: Db, groups: RoundPage["groups"], timeline: Filter) {
  if (groups.length) {
    const byId = new Map(groups.map(g => [g.id, g.members]));
    const mentions = await db<(Mention & {round_id: string})[]>`
      SELECT deal.round_id, deal.article_id, deal.seq, deal.preferred, ${timeline} AS timeline_at
      FROM financing_index_members deal WHERE deal.round_id IN ${sql(groups.map(g => g.id))}
      ORDER BY deal.timeline_at DESC, deal.article_id DESC, deal.seq`;
    for (const m of mentions) byId.get(m.round_id)!.push(m);
  }
}

// Count recipients across the complete filter, including all pages. Only reviewed aliases
// merge different spellings. Ambiguous aliases stay separate from their possible owners.
async function countCompanies(db: Db, filter: Filter, indexed: boolean, now: Date) {
  const source = indexed ? sql`FROM financing_index_members deal WHERE true` : sql`${financingJoins} WHERE ${publicFinancing(now)}`;
  const names = await db<{name:string}[]>`SELECT DISTINCT deal.claim->>'company' AS name ${source} ${filter}`;
  const entities = await db<{name:string;aliases:string[]}[]>`SELECT name, aliases FROM research_entities`;
  const normalize = (value: string) => value.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " ");
  const owners = new Map<string,string | null>();
  for (const entity of entities) {
    const owner = normalize(entity.name);
    for (const alias of [entity.name, ...entity.aliases]) {
      const key = normalize(alias);
      owners.set(key, owners.has(key) && owners.get(key) !== owner ? null : owner);
    }
  }
  return new Set(names.map(({name}) => {
    const key = normalize(name);
    return owners.get(key) ?? key;
  })).size;
}

export function loadFinancing(query: FinancingQuery, now = new Date()) {
  return withSearchCapacity(db => readFinancing(db, query, now), true);
}

// A single repeatable-read snapshot covers the index generation, matches and original reports.
export async function readFinancing(db: Db, query: FinancingQuery, now: Date, useIndex = true, boundedExport = false): Promise<FinancingResponse> {
  const target = query.eventId ? await resolveTarget(db,query.eventId,now) : undefined;
  if (target === null) return {events:[], hasMore:false, nextCursor:null};
  const limit = Math.max(1, Math.min(100, query.limit ?? 40));
  const binding = queryBinding({ from: query.from ?? null, to: query.to ?? null, company: query.company ?? null, investor: query.investor ?? null, ...(query.companyHistory ? { companyHistory: query.companyHistory } : {}), ...(query.companiesOnly ? {companiesOnly:true} : {}), ...(query.investorExact ? {exact:true} : {}) });
  const cursor = query.cursor ? decodeCursor<NonNullable<Cursor>>("fin1", query.cursor) : null;
  if (cursor && (cursor.binding !== binding || (cursor.before !== undefined && cursor.before !== true) || typeof cursor.id !== "string" || !Number.isFinite(Date.parse(cursor.at)))) throw new InvalidCursorError("financing cursor does not match filters");
  const { history, indexed, filter } = await financingFilter(db, query, now, useIndex, boundedExport);
  const { groups: page, hasMore: moreInDirection, historyRecords, latestReport } = indexed
    ? await indexedPage(db, filter, history, cursor, limit, target)
    : await livePage(db, now, filter, history, cursor, limit, target);
  if (!page.length) {
    const empty = { events: [], hasMore: false, nextCursor: null };
    if (!cursor) return empty;
    // A withdrawal may invalidate the last page while the profile still exists.
    const first = await readFinancing(db, { ...query, cursor: null, limit: 1 }, now, useIndex, boundedExport);
    return first.events.length ? { ...empty, pageReset: true, historySummary: first.historySummary } : empty;
  }

  const events = await financingEvents(db, page, now);
  const first = events[0]!;
  const last = events.at(-1)!;
  const hasPrevious = cursor?.before ? moreInDirection : !!cursor;
  const hasMore = cursor?.before || moreInDirection;
  return { events, hasMore, ...(history ? { historySummary: {
    records: historyRecords, latestAt: new Date(latestReport).toISOString(),
    ...(query.companiesOnly ? {companies:await countCompanies(db, filter, indexed, now)} : {}),
  } } : {}), previousCursor: hasPrevious ? encodeCursor("fin1", { at:first.latestAt, id:first.id, binding, before:true }) : null,
    nextCursor: hasMore ? encodeCursor("fin1", { at: last.latestAt, id: last.id, binding }) : null };
}

async function financingFilter(db: Db, query: FinancingQuery, now: Date, useIndex: boolean, boundedExport = false) {
  const range = researchDates(query.from, query.to);
  // Profile names identify recipients. Topic keywords and substring searches can also match other companies.
  const recipient = sql`lower(btrim(deal.claim->>'company'))`;
  const company = query.companyHistory?.trim().toLowerCase();
  const companyFilter = company ? sql`AND deal.claim->>'kind'='company_round' AND (
    ${recipient} = ${company} OR ${recipient} IN (
      SELECT lower(btrim(alias)) FROM research_entities e, unnest(array_prepend(e.name, e.aliases)) alias
      WHERE EXISTS (SELECT 1 FROM unnest(array_prepend(e.name, e.aliases)) n WHERE lower(btrim(n)) = ${company})))`
    : companyCondition(query.company, sql`lower(deal.claim->>'company')`);
  const indexed = useIndex && await financingIndexReady(db, now);
  if (!indexed && boundedExport) {
    // Exact live grouping needs the entire visible set, even for a narrow filter.
    // Keep this check on the server; no claim text crosses the wire when over budget.
    const [excess] = await db`SELECT 1 ${financingJoins} WHERE ${publicFinancing(now)}
      LIMIT 1 OFFSET 2000`;
    if (excess) throw new FinancingExportBusy("index", 60);
  }
  const originals = query.investor?.trim() ? await financingInvestorNames(db, now, query.investor, !!query.investorExact, indexed) : [];
  const dateColumn = indexed ? sql`deal.timeline_at` : sql`p.timeline_at`;
  const filter = sql`${range ? sql`AND ${dateColumn} >= ${range.start} AND ${dateColumn} < ${range.end}` : sql``}
    ${companyFilter} ${query.companiesOnly ? sql`AND deal.claim->>'kind'='company_round'` : sql``} ${dealInvestorCondition(query.investor, originals, query.investorExact)}`;
  return { history: !!company || !!query.companiesOnly, indexed, filter };
}

async function financingEvents(db: Db, page: RoundPage["groups"], now: Date) {
  const articleIds = [...new Set(page.flatMap(g => g.members.map(m => m.article_id)))];
  const details = await db<{ id: string; seq: number; title: string; url: string; source_name: string; published_at: Date | null; claim: FinancingClaim }[]>`
    SELECT p.article_id AS id,deal.seq,p.title,p.url,s.name AS source_name,p.published_at,deal.claim
    ${financingJoins} JOIN sources s ON s.id=p.source_id
    WHERE p.article_id IN ${sql(articleIds)} AND ${publicFinancing(now)}`;
  const reportsByKey = new Map(details.map(r => [r.id + ":" + r.seq, {
    id: r.id, title: r.title, url: r.url, sourceName: r.source_name, publishedAt: r.published_at?.toISOString() ?? null, claim: r.claim,
  }]));
  return page.map(({ id, latest, members }) => {
    members.sort((a,b) => Number(!!b.preferred) - Number(!!a.preferred) || b.timeline_at.getTime() - a.timeline_at.getTime() || b.article_id.localeCompare(a.article_id));
    const mentions = members.map(m => reportsByKey.get(m.article_id + ":" + m.seq)!);
    const byArticle = new Map<string, FinancingReport>();
    for (const report of mentions) {
      const existing = byArticle.get(report.id);
      if (existing) (existing.additionalClaims ??= []).push(report.claim);
      else byArticle.set(report.id,{...report});
    }
    const reports = [...byArticle.values()];
    const signatures = new Set(mentions.map(r => JSON.stringify([r.claim.round, r.claim.amountText, r.claim.currency, r.claim.amountBasis, r.claim.status])));
    const shareId = id.startsWith("round:") ? id : evidenceId(reports[0]!.id,reports[0]!.claim);
    return { id, shareId, latestAt: new Date(latest).toISOString(), reports, reportCount: reports.length, differingClaims: signatures.size > 1 };
  });
}

/** Preserve source-level rows, quoting and spreadsheet formula protection for both export scopes. */
export function financingCsv(data: FinancingResponse, header = true): string {
  const cell = (v: unknown) => {
    let text = String(v ?? "");
    if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const rows: unknown[][] = header ? [["事件", "公司/基金", "轮次", "金额原文", "币种", "金额口径", "状态", "投资机构", "来源", "发布日期", "原文链接", "证据", "口径有差异", "记录类型"]] : [];
  for (const e of data.events) for (const r of e.reports) for (const claim of [r.claim,...r.additionalClaims ?? []]) rows.push([e.id, claim.company, claim.round, claim.amountText,
    claim.currency, claim.amountBasis, claim.status, claim.investors.join("; "), r.sourceName, r.publishedAt, r.url, claim.evidence, e.differingClaims ? "是" : "否",
    claim.recordType === "aggregate_disclosure" ? "合计披露" : claim.recordType === "unresolved" ? "交易归属待核实" : "交易"]);
  return (header ? "\uFEFF" : "") + rows.map(row => row.map(cell).join(",")).join("\r\n");
}


// Full downloads have their own database connections and a bounded number of readers.
const exportLimit = 2;
const activeExports = {page:0, all:0};

export class FinancingExportBusy extends SearchBusyError {
  readonly reason: "index" | "capacity";
  constructor(reason: "index" | "capacity", retryAfter: number) {
    super(retryAfter);
    this.reason = reason;
  }
}

async function* allFinancingBatches(db: Db, query: FinancingQuery, now: Date) {
  const { indexed, filter } = await financingFilter(db, query, now, true, true);
  const batchSize = 100;
  if (indexed) {
    // PostgreSQL keeps the ordered result in a cursor. Fetch only what the receiver can drain.
    await db`DECLARE financing_export_rounds NO SCROLL CURSOR FOR
      SELECT deal.round_id, max(deal.timeline_at) AS latest FROM financing_index_members deal
      WHERE true ${filter} GROUP BY deal.round_id ORDER BY latest DESC, deal.round_id DESC`;
    for (;;) {
      const rows = await db<{round_id: string; latest: Date}[]>`FETCH FORWARD 100 FROM financing_export_rounds`;
      const groups = rows.map(row => ({ id: row.round_id, latest: row.latest.getTime(), members: [] as Mention[] }));
      if (!groups.length) return;
      await indexedMembers(db, groups, sql`deal.timeline_at`);
      yield await financingEvents(db, groups, now);
      if (rows.length < batchSize) return;
    }
  } else {
    // Reconcile live source identities once when the index is invalid. Hydrate reports by batch.
    const { groups } = await livePage(db, now, filter, false, null, Infinity);
    for (let start = 0; start < groups.length; start += batchSize) {
      yield await financingEvents(db, groups.slice(start, start + batchSize), now);
    }
  }
}

export async function exportFinancingCsv(query: FinancingQuery, all: boolean, signal: AbortSignal) {
  signal.throwIfAborted();
  const scope = all ? "all" : "page";
  if (activeExports[scope] >= exportLimit) throw new FinancingExportBusy("capacity", 5);
  activeExports[scope]++;
  const client = databaseClient(2);
  const ready = Promise.withResolvers<PassThrough>();
  const stream = new PassThrough();
  // A disconnect may arrive between resolving the first batch and Fastify attaching its pipe.
  stream.on("error", () => {});
  const now = new Date();
  let pid: number | undefined;
  let cancelling: Promise<unknown> | undefined;
  // The second dedicated connection can interrupt a running query; the export backend
  // cannot be reassigned to another reader while this cancellation is in flight.
  const interrupt = () => {
    if (pid !== undefined) cancelling ??= client`SELECT pg_cancel_backend(${pid})`.catch(() => {});
  };
  signal.addEventListener("abort", interrupt, { once: true });
  void client.begin("isolation level repeatable read read only", async db => {
    signal.throwIfAborted();
    const [backend] = await db`SELECT pg_backend_pid() AS pid, set_config('statement_timeout','10000',true),
      set_config('lock_timeout','2000',true), set_config('plan_cache_mode','force_custom_plan',true)`;
    pid = backend!.pid;
    signal.throwIfAborted();
    if (!all) {
      const page = await readFinancing(db, query, now, true, true);
      signal.throwIfAborted();
      ready.resolve(stream);
      if (!stream.write(financingCsv(page))) await once(stream, "drain", { signal });
      return;
    }
    let header = true;
    for await (const events of allFinancingBatches(db, query, now)) {
      signal.throwIfAborted();
      const csv = financingCsv({ events, hasMore:false, nextCursor:null }, header);
      ready.resolve(stream);
      if (!stream.write(header ? csv : "\r\n" + csv)) await once(stream, "drain", { signal });
      header = false;
    }
    if (header) stream.write(financingCsv({ events:[], hasMore:false, nextCursor:null }));
  }).then(() => {
    ready.resolve(stream);
    stream.end();
  }).catch(error => {
    ready.reject(error);
    stream.destroy(error);
  }).finally(async () => {
    signal.removeEventListener("abort", interrupt);
    await cancelling;
    await client.end({ timeout: 1 });
    activeExports[scope]--;
  });
  return ready.promise;
}
