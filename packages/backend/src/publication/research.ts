import { ENTITIES } from "@aihot/industry/taxonomy";
import { sql } from "../db.ts";

const literal = (s: string) => `%${s.toLowerCase().replace(/[\\%_]/g, c => `\\${c}`)}%`;

/** Known company aliases share one search; unknown names are still searchable. */
export function companyCondition(company?: string | null) {
  if (!company?.trim()) return sql``;
  const name = company.trim().toLowerCase();
  const found = Object.entries(ENTITIES).find(([id, e]) => id.toLowerCase() === name || e.aliases.some(a => a.toLowerCase() === name));
  const aliases = found ? [...new Set([found[0], ...found[1].aliases])].slice(0, 20) : [company.trim()];
  const conditions = aliases.map(a => sql`p.search_text LIKE ${literal(a)}`);
  return sql`AND (${conditions.reduce((a, b) => sql`${a} OR ${b}`)} OR EXISTS (
    SELECT 1 FROM research_entities e, unnest(e.aliases) alias
    WHERE EXISTS (SELECT 1 FROM unnest(e.aliases) needle WHERE lower(needle) = ${name})
      AND position(lower(alias) in p.search_text) > 0))`;
}

export function investorCondition(investor?: string | null) {
  if (!investor?.trim()) return sql``;
  return sql`AND EXISTS (SELECT 1 FROM analyses an,
    jsonb_array_elements_text(CASE WHEN jsonb_typeof(an.output->'financing'->'investors') = 'array'
      THEN an.output->'financing'->'investors' ELSE '[]'::jsonb END) AS inv(name)
    WHERE an.id = p.analysis_id AND lower(inv.name) LIKE ${literal(investor.trim())})`;
}
