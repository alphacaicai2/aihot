import { ENTITIES } from "@aihot/industry/taxonomy";
import { sql } from "../db.ts";

const literal = (s: string) => `%${s.toLowerCase().replace(/[\\%_]/g, c => `\\${c}`)}%`;

/** Known company aliases share one search; unknown names are still searchable. */
export function companyCondition(company?: string | null, target = sql`p.search_text`) {
  if (!company?.trim()) return sql``;
  const name = company.trim().toLowerCase();
  const found = Object.entries(ENTITIES).find(([id, e]) => id.toLowerCase() === name || e.aliases.some(a => a.toLowerCase() === name));
  const aliases = found ? [...new Set([found[0], ...found[1].aliases])].slice(0, 20) : [company.trim()];
  const conditions = aliases.map(a => sql`${target} LIKE ${literal(a)}`);
  return sql`AND (${conditions.reduce((a, b) => sql`${a} OR ${b}`)} OR EXISTS (
    SELECT 1 FROM research_entities e, unnest(e.aliases) alias
    WHERE EXISTS (SELECT 1 FROM unnest(e.aliases) needle WHERE lower(needle) = ${name})
      AND position(lower(alias) in ${target}) > 0))`;
}

// Older analyses store a single claim. An empty array is authoritative for reviewed roundups.
export const financingClaims = sql`CASE
  WHEN jsonb_typeof(an.output->'financingClaims')='array' THEN an.output->'financingClaims'
  WHEN jsonb_typeof(an.output->'financing')='object' THEN jsonb_build_array(an.output->'financing')
  ELSE '[]'::jsonb END`;
export const dealRows = sql`LATERAL (
  SELECT coalesce(review.claim, raw.claim) AS claim, raw.claim AS original_claim, review.round_id, review.preferred,
    row_number() OVER (ORDER BY raw.seq, review.part) AS seq
  FROM jsonb_array_elements(${financingClaims}) WITH ORDINALITY AS raw(claim, seq)
  LEFT JOIN financing_claim_reviews review ON review.article_id=an.article_id
    AND review.company=raw.claim->>'company' AND review.evidence=raw.claim->>'evidence'
    AND review.original_claim=raw.claim
  WHERE coalesce(review.listed, true)
) AS deal`;
export const namedDeal = sql`nullif(btrim(deal.claim->>'company'), '') IS NOT NULL
  AND nullif(btrim(deal.claim->>'evidence'), '') IS NOT NULL`;
export const dealInvestors = sql`jsonb_array_elements_text(CASE WHEN jsonb_typeof(deal.claim->'investors')='array'
  THEN deal.claim->'investors' ELSE '[]'::jsonb END) AS inv(name)`;

export function dealInvestorCondition(investor?: string | null, originals: string[] = [], exact = false) {
  if (!investor?.trim()) return sql``;
  const literalMatch = exact ? sql`false` : sql`lower(inv.name) LIKE ${literal(investor.trim())}`;
  const match = originals.length ? sql`(${literalMatch} OR btrim(inv.name) IN ${sql(originals)})` : literalMatch;
  return sql`AND EXISTS (SELECT 1 FROM ${dealInvestors} WHERE ${match})`;
}

export function investorCondition(investor?: string | null) {
  if (!investor?.trim()) return sql``;
  return sql`AND EXISTS (SELECT 1 FROM analyses an CROSS JOIN ${dealRows}
    WHERE an.id=p.analysis_id AND ${namedDeal} ${dealInvestorCondition(investor)})`;
}
