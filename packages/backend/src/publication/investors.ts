import { INVESTOR_ALIASES } from "@aihot/industry/investors";
import { investorSearchKey, type InvestorOption } from "@aihot/contracts/financing";
import { type Db } from "../db.ts";
import { listedCondition } from "./items.ts";
import { dealInvestors, dealRows, namedDeal } from "./research.ts";
import { withSearchCapacity } from "./pool.ts";

const known = new Map(INVESTOR_ALIASES.flatMap(group => group.map(alias => [investorSearchKey(alias), group] as const)));
type Entry = InvestorOption & { originals: string[]; popularity: number };

export function groupInvestorNames(rows: { name: string; reports: number }[]): Entry[] {
  const groups = new Map<string, Entry>();
  for (const { name, reports } of rows) {
    const key = investorSearchKey(name);
    if (!key) continue;
    let identity = known.get(key);
    // Merge parenthetical spellings only when both halves identify the same institution.
    const pair = /^(.+?)\s*[（(]([^（）()]+)[)）]$/.exec(name);
    if (pair) {
      const first = known.get(investorSearchKey(pair[1]!));
      if (first && first === known.get(investorSearchKey(pair[2]!))) identity = first;
    }
    const id = identity ? investorSearchKey(identity[0]) : key;
    const group = groups.get(id) ?? { name: identity?.[0] ?? name, aliases: identity?.slice(1) ?? [], originals: [], popularity: 0 };
    group.originals.push(name);
    group.popularity += reports;
    groups.set(id, group);
  }
  return [...groups.values()].sort((a,b) => b.popularity - a.popularity || a.name.localeCompare(b.name, "zh-CN"));
}

export async function investorDirectory(db: Db, now: Date) {
  const rows = await db<{name:string; reports:number}[]>`
    SELECT btrim(inv.name) AS name, count(DISTINCT p.article_id)::int AS reports
    FROM publications p JOIN analyses an ON an.id=p.analysis_id
    CROSS JOIN ${dealRows} CROSS JOIN LATERAL ${dealInvestors}
    WHERE ${listedCondition(now)} AND ${namedDeal} AND p.eligible AND (p.category='financing' OR an.output ? 'financingClaims') AND btrim(inv.name)<>''
    GROUP BY btrim(inv.name) ORDER BY reports DESC, name`;
  return groupInvestorNames(rows);
}

export function loadInvestorOptions(now = new Date()) {
  return withSearchCapacity(async db => (await investorDirectory(db,now)).map(({name, aliases}) => ({ name, aliases })));
}

export async function financingInvestorNames(db: Db, now: Date, input: string, exact: boolean) {
  const key = investorSearchKey(input);
  if (!exact && !known.has(key)) return [];
  const directory = await investorDirectory(db,now);
  return directory.find(group => [group.name,...group.aliases].some(name => investorSearchKey(name) === key))?.originals ?? [];
}
