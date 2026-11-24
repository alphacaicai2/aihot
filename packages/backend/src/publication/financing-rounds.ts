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
// retain their qualifiers. A vague range is only supporting evidence.
function amountKey(value: string) {
  // Ignore only a trailing currency conversion. A parenthetical debt/equity split,
  // valuation, target or cumulative amount is part of the reported terms.
  const text = normalize(value).replace(/\s+/g, "")
    .replace(/\((?:约合|约折合|折合|相当于|约)(?:[a-z]{3}|[￥¥$€£])?[\d,.]+(?:亿|[千百十]?万|billion|million|bn|[mbk])?(?:美元|人民币|欧元|英镑|元|usd|cny|rmb|eur|gbp)\)$/, "")
    .replace(/^(近|约|超|逾)(亿|万)(?=美元|人民币|欧元|英镑|元|$)/, (_, qualifier: string, scale: string) => qualifier + "1" + scale);
  const vague = /^(数[十百千]?[亿万])(?:元)?(?:人民币|美元|欧元|英镑)?$/.exec(text);
  if (vague) return "?" + vague[1];
  const magnitude = /^([千百十]?[亿万])(?:元)?级(?:人民币|美元|欧元|英镑)?$/.exec(text);
  if (magnitude) return "?" + magnitude[1] + "级";
  const m = /^(近|约|超|逾|approximately|about|nearly|~)?(?:us\$|[$€£¥]|usd|cny|rmb|eur|gbp)?(\d+)(?:\.(\d+))?(亿|万|million|billion|bn|[mbk])?(?:美元|元?人民币|元|欧元|英镑|usd|cny|rmb|eur|gbp)?$/.exec(text);
  if (!m) return null;
  const digits = (m[2]! + (m[3] ?? "")).replace(/^0+/, "");
  const mantissa = digits.replace(/0+$/, "");
  const exponent = (scales.get(m[4] ?? "") ?? 0) - (m[3]?.length ?? 0) + digits.length - mantissa.length;
  const qualifier = m[1] === "超" || m[1] === "逾" ? ">" : m[1] ? "~" : "";
  return mantissa ? qualifier + mantissa + "e" + exponent : null;
}

function stageKey(value: string | null) {
  const stage = normalize(value ?? "").replace(/\s+/g, "").replace(/–|—/g, "-");
  if (!stage || ["新一轮", "新一轮融资", "融资", "fundinground", "latestround"].includes(stage)) return null;
  const series = /^(?:series)?((?:pre-?)?[a-z]\d*\+*)(?:轮(?:融资)?)?$/.exec(stage);
  const early = /^(天使|种子)(\++)轮$/.exec(stage);
  if (early) return earlyStages.get(early[1] + "轮")! + early[2];
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
  const primary = normalize(row.amount ?? "").split("(",1)[0]!;
  const code = /美元|us\$|\busd\b/.test(primary) ? "USD" : /人民币|\b(?:cny|rmb)\b/.test(primary) ? "CNY" :
    /欧元|€|\beur\b/.test(primary) ? "EUR" : /英镑|£|\bgbp\b/.test(primary) ? "GBP" : null;
  if (code && row.currency && code !== row.currency) return null;
  const stage = stageKey(row.stage);
  // An unfamiliar or compound round name can veto a match, but cannot establish one.
  const specific = !!stage && /^(?:(?:pre-)?[a-z]\d*\+*|(?:seed|angel)\+*|pre-seed)$/.test(stage);
  const quote = normalize(row.evidence ?? "");
  const phase = !fund ? null : /first clos(?:e|ing)|initial clos(?:e|ing)|首关|首次关账|首次关闭/i.test(quote) ? "first" :
    /final clos(?:e|ing)|终关|最终关账|最终关闭/i.test(quote) ? "final" : row.basis === "target" ? "target" : null;
  if (fund && !phase) return null;
  return { stage, specific, amount, currency:row.currency ?? code, fund, phase,
    investors:new Set((row.investors ?? []).map(normalize).filter(Boolean)) };
}

type Terms = NonNullable<ReturnType<typeof terms>>;
function sameTerms(a: Terms, b: Terms) {
  if ((a.currency && b.currency && a.currency !== b.currency) || (a.amount && b.amount && a.amount !== b.amount) ||
      (a.stage && b.stage && a.stage !== b.stage)) return false;
  const sameAmount = !!a.amount && a.amount === b.amount && !!a.currency && a.currency === b.currency;
  const definiteAmount = sameAmount && !/^[>?]/.test(a.amount!);
  if (a.fund || b.fund) return a.fund && b.fund && a.phase === b.phase && a.stage === b.stage && definiteAmount;
  const investors = [...a.investors].filter(name => b.investors.has(name));
  if (a.specific && a.stage === b.stage) return definiteAmount || investors.length >= 2 || (sameAmount && investors.length > 0);
  if ((a.stage && !a.specific) || (b.stage && !b.specific)) return false;
  return definiteAmount && investors.length > 0;
}

// Read an alias only from a declaration attached to this exact recipient. Other
// companies, investors and parent/subsidiary relationships can occur in the same quote.
function declaredAliases(row: RoundSource) {
  const name = normalize(row.company);
  const text = normalize(row.evidence ?? "");
  const aliases: string[] = [];
  for (let from = 0; name && from < text.length;) {
    const at = text.indexOf(name, from);
    if (at < 0) break;
    from = at + name.length;
    if (at && /[a-z0-9]/.test(name[0]!) && /[a-z0-9]/.test(text[at-1]!)) continue;
    const alias = /^\s*\((?:[^(),，;；。]{1,40}\s*[,，]\s*)?(?:以下简称|下称|简称)\s*[：:]?\s*[“「『"]([^”」』"]{2,60})[”」』"]\s*\)/u
      .exec(text.slice(from))?.[1]?.trim();
    if (alias && alias !== name && !/[，、;；。]/u.test(alias)) aliases.push(alias);
  }
  return aliases;
}

/** Each claim starts with its own identity. A shared news fact may describe several
 * financings. Only a transaction review or corroborated financing terms can join them. */
export function financingRounds<T extends RoundSource>(rows: T[]): Map<string, T[]> {
  const groups = indexBy(rows, r => r.reviewed_id ? "round:" + r.reviewed_id :
    r.base_id.startsWith("fact:") ? "item:" + r.article_id : r.base_id);
  // An abbreviation used by two distinct recipients cannot establish identity.
  const ownerByAlias = new Map<string, string | null>();
  for (const row of rows) {
    if (row.kind !== "company_round") continue;
    const name = normalize(row.company);
    const declared = declaredAliases(row);
    // A bilingual recipient printed in one field can corroborate both stand-alone
    // names. Overlapping brands and legal suffixes do not establish identity.
    const pair = /^([\p{Script=Han}·]{2,50})\s*\(\s*([a-z][a-z0-9 .&'-]{2,50})\s*\)$/u.exec(name);
    const owner = pair?.[1] ?? name;
    if (pair) declared.push(name,pair[2]!.trim());
    for (const alias of declared) {
      const previous = ownerByAlias.get(alias);
      ownerByAlias.set(alias, previous === undefined || previous === owner ? owner : null);
    }
  }
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
    const companies = new Set(a.sources.map(s => {
      const name = normalize(s.company);
      return s.kind === "company_round" ? ownerByAlias.get(name) ?? name : name;
    }));
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
