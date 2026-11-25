// All claims are joined through the currently published analysis, never a newer unpublished run.
import { createHash } from "node:crypto";
import type { FinancingClaim, FinancingResponse, FinancingReport } from "@aihot/contracts/financing";
import { researchDates } from "@aihot/contracts/research";
import { sql, type Db } from "../db.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import { financingIndexReady, financingJoins, financingSources, publicFinancing, type Mention } from "./financing-index.ts";
import { companyCondition, dealInvestorCondition } from "./research.ts";
import { financingInvestorNames } from "./investors.ts";
import { financingRounds } from "./financing-rounds.ts";
import { withSearchCapacity } from "./pool.ts";

export interface FinancingQuery { from?: string | null; to?: string | null; company?: string | null; companyHistory?: string; companiesOnly?: boolean; eventId?: string; investor?: string | null; investorExact?: boolean; cursor?: string | null; limit?: number }
type Cursor = { at: string; id: string; binding: string } | null;
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
    if (cursor && (latest > Date.parse(cursor.at) || (latest === Date.parse(cursor.at) && id >= cursor.id))) continue;
    groups.push({ id, latest, members });
  }
  groups.sort((a,b) => b.latest - a.latest || (a.id < b.id ? 1 : -1));
  return { groups: groups.slice(0, limit), hasMore: groups.length > limit, historyRecords, latestReport };
}

async function indexedPage(db: Db, filter: Filter, history: boolean, cursor: Cursor, limit: number, target?: EventTarget): Promise<RoundPage> {
  const timeline = history ? sql`coalesce(deal.reported_at,deal.timeline_at)` : sql`deal.timeline_at`;
  const after = cursor ? sql`WHERE (latest,round_id) < (${new Date(cursor.at)}, ${cursor.id})` : sql``;
  const selected = !target ? sql`` : "roundId" in target ? sql`AND deal.round_id=${target.roundId}`
    : sql`AND deal.round_id=(SELECT round_id FROM financing_index_members WHERE article_id=${target.article} AND seq=${target.seq})`;
  const rounds = await db<{ round_id: string; latest: Date; records: number; latest_report: Date }[]>`
    WITH matching AS (
      SELECT deal.round_id, max(${timeline}) AS latest FROM financing_index_members deal
      WHERE true ${filter} ${selected} GROUP BY deal.round_id
    )
    SELECT * FROM (SELECT matching.* ${history ? sql`, count(*) OVER () AS records, max(latest) OVER () AS latest_report` : sql``}
      FROM matching) rounds ${after} ORDER BY latest DESC, round_id DESC LIMIT ${limit+1}`;
  const groups = rounds.slice(0, limit).map(r => ({ id: r.round_id, latest: r.latest.getTime(), members: [] as Mention[] }));
  if (groups.length) {
    const byId = new Map(groups.map(g => [g.id, g.members]));
    const mentions = await db<(Mention & {round_id: string})[]>`
      SELECT deal.round_id, deal.article_id, deal.seq, deal.preferred, ${timeline} AS timeline_at
      FROM financing_index_members deal WHERE deal.round_id IN ${sql(groups.map(g => g.id))}
      ORDER BY deal.timeline_at DESC, deal.article_id DESC, deal.seq`;
    for (const m of mentions) byId.get(m.round_id)!.push(m);
  }
  return { groups, hasMore: rounds.length > limit, historyRecords: rounds[0]?.records ?? 0,
    latestReport: rounds[0]?.latest_report?.getTime() ?? -Infinity };
}

export function loadFinancing(query: FinancingQuery, now = new Date()) {
  return withSearchCapacity(db => readFinancing(db, query, now), true);
}

// A single repeatable-read snapshot covers the index generation, matches and original reports.
export async function readFinancing(db: Db, query: FinancingQuery, now: Date, useIndex = true): Promise<FinancingResponse> {
  const target = query.eventId ? await resolveTarget(db,query.eventId,now) : undefined;
  if (target === null) return {events:[], hasMore:false, nextCursor:null};
  const range = researchDates(query.from, query.to);
  const limit = Math.max(1, Math.min(100, query.limit ?? 40));
  const binding = queryBinding({ from: query.from ?? null, to: query.to ?? null, company: query.company ?? null, investor: query.investor ?? null, ...(query.companyHistory ? { companyHistory: query.companyHistory } : {}), ...(query.companiesOnly ? {companiesOnly:true} : {}), ...(query.investorExact ? {exact:true} : {}) });
  const cursor = query.cursor ? decodeCursor<{ at: string; id: string; binding: string }>("fin1", query.cursor) : null;
  if (cursor && (cursor.binding !== binding || typeof cursor.id !== "string" || !Number.isFinite(Date.parse(cursor.at)))) throw new InvalidCursorError("financing cursor does not match filters");
  // Profile names identify recipients. Topic keywords and substring searches can also match other companies.
  const recipient = sql`lower(btrim(deal.claim->>'company'))`;
  const company = query.companyHistory?.trim().toLowerCase();
  const companyFilter = company ? sql`AND deal.claim->>'kind'='company_round' AND (
    ${recipient} = ${company} OR ${recipient} IN (
      SELECT lower(btrim(alias)) FROM research_entities e, unnest(array_prepend(e.name, e.aliases)) alias
      WHERE EXISTS (SELECT 1 FROM unnest(array_prepend(e.name, e.aliases)) n WHERE lower(btrim(n)) = ${company})))`
    : companyCondition(query.company, sql`lower(deal.claim->>'company')`);
  const indexed = useIndex && await financingIndexReady(db, now);
  const originals = query.investor?.trim() ? await financingInvestorNames(db, now, query.investor, !!query.investorExact, indexed) : [];
  const dateColumn = indexed ? sql`deal.timeline_at` : sql`p.timeline_at`;
  const filter = sql`${range ? sql`AND ${dateColumn} >= ${range.start} AND ${dateColumn} < ${range.end}` : sql``}
    ${companyFilter} ${query.companiesOnly ? sql`AND deal.claim->>'kind'='company_round'` : sql``} ${dealInvestorCondition(query.investor, originals, query.investorExact)}`;
  const { groups: page, hasMore, historyRecords, latestReport } = indexed
    ? await indexedPage(db, filter, !!company || !!query.companiesOnly, cursor, limit, target)
    : await livePage(db, now, filter, !!company || !!query.companiesOnly, cursor, limit, target);
  if (!page.length) return { events: [], hasMore: false, nextCursor: null };

  const articleIds = [...new Set(page.flatMap(g => g.members.map(m => m.article_id)))];
  const details = await db<{ id: string; seq: number; title: string; url: string; source_name: string; published_at: Date | null; claim: FinancingClaim }[]>`
    SELECT p.article_id AS id,deal.seq,p.title,p.url,s.name AS source_name,p.published_at,deal.claim
    ${financingJoins} JOIN sources s ON s.id=p.source_id
    WHERE p.article_id IN ${sql(articleIds)} AND ${publicFinancing(now)}`;
  const reportsByKey = new Map(details.map(r => [r.id + ":" + r.seq, {
    id: r.id, title: r.title, url: r.url, sourceName: r.source_name, publishedAt: r.published_at?.toISOString() ?? null, claim: r.claim,
  }]));
  const events = page.map(({ id, latest, members }) => {
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
  const last = events.at(-1)!;
  return { events, hasMore, ...(company || query.companiesOnly ? { historySummary: {
    records: historyRecords, latestAt: new Date(latestReport).toISOString(),
  } } : {}), nextCursor: hasMore ? encodeCursor("fin1", { at: last.latestAt, id: last.id, binding }) : null };
}

/** CSV exports stay bounded to the same page and cannot execute spreadsheet formulas. */
export function financingCsv(data: FinancingResponse): string {
  const cell = (v: unknown) => {
    let text = String(v ?? "");
    if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const rows: unknown[][] = [["事件", "公司/基金", "轮次", "金额原文", "币种", "金额口径", "状态", "投资机构", "来源", "发布日期", "原文链接", "证据", "口径有差异", "记录类型"]];
  for (const e of data.events) for (const r of e.reports) for (const claim of [r.claim,...r.additionalClaims ?? []]) rows.push([e.id, claim.company, claim.round, claim.amountText,
    claim.currency, claim.amountBasis, claim.status, claim.investors.join("; "), r.sourceName, r.publishedAt, r.url, claim.evidence, e.differingClaims ? "是" : "否",
    claim.recordType === "aggregate_disclosure" ? "合计披露" : claim.recordType === "unresolved" ? "交易归属待核实" : "交易"]);
  return "\uFEFF" + rows.map(row => row.map(cell).join(",")).join("\r\n");
}
