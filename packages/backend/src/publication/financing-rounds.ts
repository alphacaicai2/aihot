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
  if (!m) return text;
  const digits = (m[2]! + (m[3] ?? "")).replace(/^0+/, "");
  const mantissa = digits.replace(/0+$/, "");
  const exponent = (scales.get(m[4] ?? "") ?? 0) - (m[3]?.length ?? 0) + digits.length - mantissa.length;
  return (m[1] ? "~" : "") + mantissa + "e" + exponent;
}

// Generic round descriptions, totals and proposed financings do not identify a transaction.
function signature(row: RoundSource) {
  if (!row.reported_at || row.kind !== "company_round" || row.basis !== "round" ||
      !["announced", "closed"].includes(row.status) || !row.currency || !row.amount || !/\d/.test(row.amount)) return null;
  const stage = normalize(row.stage ?? "").replace(/\s+/g, "");
  const series = /^(?:series)?((?:pre-?)?[a-h]\d*\+*)(?:轮(?:融资)?)?$/.exec(stage);
  const round = series?.[1] ?? earlyStages.get(stage);
  if (!round) return null;
  return JSON.stringify([normalize(row.company), round, amountKey(row.amount), row.currency]);
}

const fortnight = 14 * 86400_000;
type SourceGroup<T> = { id: string; sources: T[]; start: number; end: number };

/** Resolve identities before applying filters or paginating. Explicit reviews can link
 * aliases and differing terms. Automatic matches require a specific stage and amount. */
export function financingRounds<T extends RoundSource>(rows: T[]): Map<string, T[]> {
  const base = indexBy(rows, r => r.base_id);
  const explicit = new Map<string, T[]>();
  for (const [id, reports] of base) {
    const decisions = new Set(reports.map(r => r.reviewed_id).filter(Boolean));
    const inherited = decisions.size === 1 ? [...decisions][0] : null;
    for (const r of reports) {
      const reviewed = r.reviewed_id ?? inherited;
      const key = reviewed ? "round:" + reviewed : id;
      const group = explicit.get(key);
      if (group) group.push(r);
      else explicit.set(key, [r]);
    }
  }

  const result = new Map(explicit);
  const bySignature = new Map<string, SourceGroup<T>[]>();
  for (const [id, sources] of explicit) {
    // A reviewed group can contain reports that use an alias or omit the stage.
    const signatures = new Set(sources.map(signature));
    if (id.startsWith("round:")) signatures.delete(null);
    const [key] = signatures;
    if (!key || signatures.size !== 1 || sources.some(s => !s.reported_at)) continue;
    const dates = sources.map(s => s.reported_at!.getTime());
    const candidate = { id, sources, start: Math.min(...dates), end: Math.max(...dates) };
    const bucket = bySignature.get(key);
    if (bucket) bucket.push(candidate);
    else bySignature.set(key, [candidate]);
  }

  function merge(cluster: SourceGroup<T>[], end: number) {
    if (cluster.length < 2 || end - cluster[0]!.start > fortnight) return;
    const reviewed = cluster.filter(g => g.id.startsWith("round:"));
    const sources = cluster.flatMap(g => g.sources);
    // Separate entries in one roundup or two distinct reviewed identities veto an inferred merge.
    if (reviewed.length > 1 || new Set(sources.map(s => s.article_id)).size !== sources.length) return;
    for (const { id } of cluster) result.delete(id);
    result.set(reviewed[0]?.id ?? cluster[0]!.id, sources);
  }
  for (const bucket of bySignature.values()) {
    if (bucket.length < 2) continue;
    bucket.sort((a,b) => a.start - b.start || a.id.localeCompare(b.id));
    let cluster: SourceGroup<T>[] = [];
    let end = -Infinity;
    for (const group of bucket) {
      if (cluster.length && group.start - end > fortnight) {
        merge(cluster, end);
        cluster = [];
      }
      cluster.push(group);
      end = Math.max(end, group.end);
    }
    merge(cluster, end);
  }
  return result;
}
