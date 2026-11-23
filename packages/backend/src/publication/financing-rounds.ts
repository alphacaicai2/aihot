export interface RoundSource {
  article_id: string;
  base_id: string;
  reviewed_id: string | null;
  reported_at: Date | null;
  company: string;
  stage: string | null;
  amount: string | null;
  currency: string | null;
  kind: string;
  basis: string;
  status: string;
  record_type?: string | null;
  evidence?: string | null;
  investors?: readonly string[] | null;
}

function indexBy<T>(items: Iterable<T>, key: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    const group = groups.get(id);
    if (group) group.push(item);
    else groups.set(id, [item]);
  }
  return groups;
}

function normalize(text: string) {
  return text.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " ");
}

const earlyStages = new Map([["种子轮", "seed"], ["seed", "seed"], ["seedround", "seed"], ["天使轮", "angel"], ["angelround", "angel"]]);
const scales = new Map([["亿", 8], ["万", 4], ["billion", 9], ["bn", 9], ["million", 6], ["m", 6], ["b", 9], ["k", 3]]);

// Scale explicit numeric amounts without rounding. Bounds and approximate amounts
// retain their qualifiers, and an unfamiliar expression only matches its exact wording.
function amountKey(value: string) {
  const text = normalize(value).replace(/\s+/g, "");
  const m = /^(近|约|approximately|about|nearly|~)?(?:us\$|[$€£¥]|usd|cny|rmb|eur|gbp)?(\d+)(?:\.(\d+))?(亿|万|million|billion|bn|[mbk])?(?:美元|人民币|元|欧元|英镑|usd|cny|rmb|eur|gbp)?$/.exec(text);
  if (!m) return null;
  const digits = (m[2]! + (m[3] ?? "")).replace(/^0+/, "");
  const mantissa = digits.replace(/0+$/, "");
  const exponent = (scales.get(m[4] ?? "") ?? 0) - (m[3]?.length ?? 0) + digits.length - mantissa.length;
  return mantissa ? (m[1] ? "~" : "") + mantissa + "e" + exponent : null;
}

function stageKey(value: string | null) {
  const stage = normalize(value ?? "").replace(/\s+/g, "").replace(/–|—/g, "-");
  if (!stage || ["新一轮", "新一轮融资", "融资", "fundinground", "latestround"].includes(stage)) return null;
  const series = /^(?:series)?((?:pre-?)?[a-z]\d*\+*)(?:轮(?:融资)?)?$/.exec(stage);
  return series?.[1]?.replace(/^pre-?/, "pre-") ?? earlyStages.get(stage) ?? stage;
}

const fortnight = 14 * 86400_000;

function terms(row: RoundSource) {
  if (row.record_type || !row.reported_at || !["announced", "closed"].includes(row.status)) return null;
  const fund = row.kind === "fund_raise";
  if (fund) {
    // A manager can raise several vehicles in parallel. Require an identified fund
    // and an explicit closing/target phase, even when two quoted sizes are equal.
    const name = normalize(row.stage || row.company);
    if (!/\bfund\s+(?:[ivxl]+|\d+)\b|[一二三四五六七八九十0-9]+期|基金.{0,4}[一二三四五六七八九十0-9]+号/iu.test(name)) return null;
  } else if (row.kind !== "company_round") return null;
  if (!["round","unknown",...(fund ? ["target"] : [])].includes(row.basis)) return null;
  const amount = row.amount ? amountKey(row.amount) : null;
  if (row.amount && (!amount || row.basis === "unknown")) return null;
  const stage = stageKey(row.stage);
  // An unfamiliar or compound round name can veto a match, but cannot establish one.
  const specific = !!stage && /^(?:(?:pre-)?[a-z]\d*\+*|seed|angel|pre-seed)$/.test(stage);
  const quote = normalize(row.evidence ?? "");
  const phase = !fund ? null : /first clos(?:e|ing)|initial clos(?:e|ing)|首关|首次关账|首次关闭/i.test(quote) ? "first" :
    /final clos(?:e|ing)|终关|最终关账|最终关闭/i.test(quote) ? "final" : row.basis === "target" ? "target" : null;
  if (fund && !phase) return null;
  return { stage, specific, amount, currency:row.currency, fund, phase,
    investors:new Set((row.investors ?? []).map(normalize).filter(Boolean)) };
}

type Terms = NonNullable<ReturnType<typeof terms>>;
function sameTerms(a: Terms, b: Terms) {
  if ((a.currency && b.currency && a.currency !== b.currency) || (a.amount && b.amount && a.amount !== b.amount) ||
      (a.stage && b.stage && a.stage !== b.stage)) return false;
  const sameAmount = !!a.amount && a.amount === b.amount && !!a.currency && a.currency === b.currency;
  if (a.fund || b.fund) return a.fund && b.fund && a.phase === b.phase && a.stage === b.stage && sameAmount;
  const investors = [...a.investors].filter(name => b.investors.has(name));
  if (a.specific && a.stage === b.stage) return sameAmount || investors.length >= 2;
  if ((a.stage && !a.specific) || (b.stage && !b.specific)) return false;
  return sameAmount && investors.length > 0;
}

/** Each claim starts with its own identity. A shared news fact may describe several
 * financings. Only a transaction review or corroborated financing terms can join them. */
export function financingRounds<T extends RoundSource>(rows: T[]): Map<string, T[]> {
  const groups = indexBy(rows, r => r.reviewed_id ? "round:" + r.reviewed_id :
    r.base_id.startsWith("fact:") ? "item:" + r.article_id : r.base_id);
  const candidates = [...groups].map(([id, sources]) => {
    const dates = sources.map(s => s.reported_at?.getTime() ?? NaN);
    return { id, sources, terms:sources.map(terms).filter(t => t !== null),
      stages:new Set(sources.map(s => stageKey(s.stage)).filter(Boolean)),
      start:Math.min(...dates), end:Math.max(...dates), neighbors:new Set<number>() };
  });
  const byCompany = new Map<string, number[]>();
  for (const [i, a] of candidates.entries()) {
    if (!Number.isFinite(a.start) || a.end - a.start > fortnight) continue;
    if (!a.terms.length) continue;
    const companies = new Set(a.sources.map(s => normalize(s.company)));
    const possible = new Set([...companies].flatMap(name => byCompany.get(name) ?? []));
    for (const j of possible) {
      const b = candidates[j]!;
      // Include conflicting reviewed identities in the ambiguity check below. A new
      // source matching both must remain separate, even if one is encountered first.
      if (Math.max(a.end,b.end) - Math.min(a.start,b.start) > fortnight ||
          new Set([...a.stages,...b.stages]).size > 1 ||
          !a.terms.some(x => b.terms.some(y => sameTerms(x,y)))) continue;
      a.neighbors.add(j);
      b.neighbors.add(i);
    }
    for (const name of companies) {
      const bucket = byCompany.get(name) ?? [];
      bucket.push(i);
      byCompany.set(name,bucket);
    }
  }
  const seen = new Set<number>();
  for (const [i, candidate] of candidates.entries()) {
    if (seen.has(i) || !candidate.neighbors.size) continue;
    const stack = [i], component = [];
    seen.add(i);
    while (stack.length) {
      const current = candidates[stack.pop()!]!;
      component.push(current);
      for (const neighbor of current.neighbors) if (!seen.has(neighbor)) {
        seen.add(neighbor);
        stack.push(neighbor);
      }
    }
    // Require pairwise agreement. An unstaged report must never bridge A and A+,
    // or two neighboring announcements more than a fortnight apart.
    if (component.some(c => c.neighbors.size !== component.length - 1)) continue;
    const reviewed = component.filter(c => c.id.startsWith("round:"));
    const sources = component.flatMap(c => c.sources);
    const articles = component.flatMap(c => [...new Set(c.sources.map(s => s.article_id))]);
    if (reviewed.length > 1 || new Set(articles).size !== articles.length) continue;
    const id = reviewed[0]?.id ?? component.map(c => c.id).sort()[0]!;
    for (const c of component) groups.delete(c.id);
    groups.set(id,sources);
  }
  return groups;
}
