// All claims are joined through the currently published analysis, never a newer unpublished run.
import type { FinancingClaim, FinancingResponse, FinancingReport } from "@aihot/contracts/financing";
import { researchDates } from "@aihot/contracts/research";
import { sql } from "../db.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import { listedCondition } from "./items.ts";
import { companyCondition, dealInvestorCondition, dealRows, financingClaims, namedDeal } from "./research.ts";
import { financingInvestorNames } from "./investors.ts";
import { financingRounds, type RoundSource } from "./financing-rounds.ts";
import { withSearchCapacity } from "./pool.ts";

export interface FinancingQuery { from?: string | null; to?: string | null; company?: string | null; companyHistory?: string; investor?: string | null; investorExact?: boolean; cursor?: string | null; limit?: number }
export async function loadFinancing(query: FinancingQuery, now = new Date()): Promise<FinancingResponse> {
  const range = researchDates(query.from, query.to);
  const limit = Math.max(1, Math.min(100, query.limit ?? 40));
  const binding = queryBinding({ from: query.from ?? null, to: query.to ?? null, company: query.company ?? null, investor: query.investor ?? null, ...(query.companyHistory ? { companyHistory: query.companyHistory } : {}), ...(query.investorExact ? {exact:true} : {}) });
  const cursor = query.cursor ? decodeCursor<{ at: string; id: string; binding: string }>("fin1", query.cursor) : null;
  if (cursor && (cursor.binding !== binding || typeof cursor.id !== "string" || !Number.isFinite(Date.parse(cursor.at)))) throw new InvalidCursorError("financing cursor does not match filters");
  // A roundup has only one article-level fact. It cannot identify each of its transactions.
  const key = sql`CASE WHEN jsonb_array_length(${financingClaims}) > 1 THEN 'deal:' || p.article_id || ':' || deal.seq
    ELSE coalesce('fact:' || f.public_id || ':' || lower(btrim(deal.claim->>'company')), 'item:' || p.article_id) END`;
  const joins = sql`FROM publications p JOIN analyses an ON an.id=p.analysis_id AND an.article_id=p.article_id
    LEFT JOIN facts f ON f.id=p.fact_id CROSS JOIN ${dealRows}`;
  const publicDeal = sql`${listedCondition(now)} AND p.eligible AND (p.category='financing' OR an.output ? 'financingClaims') AND ${namedDeal}`;
  // Profile names identify recipients. Topic keywords and substring searches can also match other companies.
  const recipient = sql`lower(btrim(deal.claim->>'company'))`;
  const company = query.companyHistory?.trim().toLowerCase();
  const companyFilter = company ? sql`AND deal.claim->>'kind'='company_round' AND (
    ${recipient} = ${company} OR ${recipient} IN (
      SELECT lower(btrim(alias)) FROM research_entities e, unnest(array_prepend(e.name, e.aliases)) alias
      WHERE EXISTS (SELECT 1 FROM unnest(array_prepend(e.name, e.aliases)) n WHERE lower(btrim(n)) = ${company})))`
    : companyCondition(query.company, sql`lower(deal.claim->>'company')`);
  return withSearchCapacity(async db => {
    const originals = query.investor?.trim() ? await financingInvestorNames(db, now, query.investor, !!query.investorExact) : [];
    type Member = RoundSource & { seq: number; timeline_at: Date; preferred: boolean | null; matches: boolean };
    const sources = await db<Member[]>`
      SELECT ${key} AS base_id, p.article_id, deal.seq, coalesce(deal.round_id,review.round_id) AS reviewed_id, deal.preferred,
        ${company ? sql`coalesce(p.published_at,p.timeline_at)` : sql`p.timeline_at`} AS timeline_at, p.published_at AS reported_at, deal.claim->>'company' AS company,
        deal.claim->>'round' AS stage, deal.claim->>'amountText' AS amount, deal.claim->>'currency' AS currency,
        deal.claim->>'kind' AS kind, deal.claim->>'amountBasis' AS basis, deal.claim->>'status' AS status,
        deal.claim->'investors' AS investors, deal.claim->>'recordType' AS record_type, deal.claim->>'evidence' AS evidence,
        (true ${range ? sql`AND p.timeline_at >= ${range.start} AND p.timeline_at < ${range.end}` : sql``}
         ${companyFilter}
         ${dealInvestorCondition(query.investor, originals, query.investorExact)}) AS matches
      ${joins} LEFT JOIN financing_round_sources review ON review.article_id=p.article_id
        AND review.company=deal.claim->>'company' AND review.evidence=deal.claim->>'evidence'
      WHERE ${publicDeal}
      ORDER BY p.timeline_at DESC,p.article_id DESC,deal.seq`;
    const groups = [];
    let historyRecords = 0;
    let latestReport = -Infinity;
    for (const [id, members] of financingRounds(sources)) {
      const matching = members.filter(m => m.matches);
      if (!matching.length) continue;
      const latest = Math.max(...matching.map(m => m.timeline_at.getTime()));
      if (company) {
        historyRecords++;
        latestReport = Math.max(latestReport, latest);
      }
      if (cursor && (latest > Date.parse(cursor.at) || (latest === Date.parse(cursor.at) && id >= cursor.id))) continue;
      groups.push({ id, latest, members });
    }
    groups.sort((a,b) => b.latest - a.latest || (a.id < b.id ? 1 : -1));
    const page = groups.slice(0, limit);
    if (!page.length) return { events: [], hasMore: false, nextCursor: null };

    const articleIds = [...new Set(page.flatMap(g => g.members.map(m => m.article_id)))];
    const details = await db<{ id: string; seq: number; title: string; url: string; source_name: string; published_at: Date | null; claim: FinancingClaim }[]>`
      SELECT p.article_id AS id,deal.seq,p.title,p.url,s.name AS source_name,p.published_at,deal.claim
      ${joins} JOIN sources s ON s.id=p.source_id
      WHERE p.article_id IN ${sql(articleIds)} AND ${publicDeal}`;
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
      return { id, latestAt: new Date(latest).toISOString(), reports, reportCount: reports.length, differingClaims: signatures.size > 1 };
    });
    const hasMore = groups.length > limit;
    const last = events.at(-1)!;
    return { events, hasMore, ...(company ? { historySummary: {
      records: historyRecords, latestAt: new Date(latestReport).toISOString(),
    } } : {}), nextCursor: hasMore ? encodeCursor("fin1", { at: last.latestAt, id: last.id, binding }) : null };
  }, true);
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
