// Match the original report's card or section structure. A publication category, a date
// in the title, or two mentions of "financing" alone do not establish a digest of deals.
export const digestTitlePattern = '日报|早报|晨报|晚报|早知道|每日(?:融资|投融资|创投)|(?:funding|financing|venture) daily|daily (?:funding|financing|venture)';
export const cardPattern = '(?:🇨🇳\\s*国内|🌍\\s*海外)([^📍📅]{1,180})📍\\s*([^📍📅]{1,24}?)\\s*📅';
export const dealHeadline = '[^【】；;]{1,65}?(?:完成|获得|获|筹集|募集)[^【】；;]{0,45}?(?:融资|募资|投资)';
export const sectionPattern = '【(' + dealHeadline + '[^【】]{0,65})】';

export type DigestEntry = { heading: string; stage?: string; amount?: string };
const compact = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
const printedAmount = /((?:超|约|近|数|逾)?(?:[\d.,]+|数|[零一二两三四五六七八九十百千]+)?\s*(?:[千百十]?万|[千百十]?亿)\s*(?:美元|人民币|欧元|韩元|港元|英镑|元))(?:\s*[（(][^（）()]*[）)])?\s*$/u;

export function digestEntries(title: string, excerpt: string | null, body: string | null): DigestEntry[] {
  // A feed can repeat the full article in the excerpt. Count a source layout only once.
  const layouts: DigestEntry[][] = [];
  for (const text of [excerpt, body]) {
    if (!text) continue;
    const cards = Array.from(text.matchAll(new RegExp(cardPattern, "gu")), match => ({
      // The flat feed joins the preceding investor list to the next company. The printed
      // recipient always ends immediately before the region marker; keep that exact context.
      heading: text.slice(Math.max(0, match.index - 100), match.index).trim(),
      stage: match[2]!.trim(), amount: printedAmount.exec(match[1]!)?.[1],
    }));
    if (cards.length >= 2) layouts.push(cards);
    const headlines = new Set(Array.from(text.matchAll(new RegExp(sectionPattern, "gu")), m => m[1]!));
    if (headlines.size >= 2) layouts.push([...headlines].map(heading => ({ heading })));
  }
  if (layouts.length) return layouts.sort((a, b) => b.length - a.length)[0]!;
  const headlines = title.split(/[；;]/).map(s => s.split(/[|｜丨]/)[0]!.trim()).filter(s => new RegExp(dealHeadline, "u").test(s));
  const unique = [...new Set(headlines)];
  return unique.length >= 2 ? unique.map(heading => ({ heading })) : [];
}

const stageName = (s: string) => compact(s).replace(/[-‐‑–—]/g, "").replace(/轮融资$/, "轮");
const amountValue = (s: string) => compact(s).split(/[（(]/)[0]!.replace(/(?:人民币|美元|欧元|韩元|港元|英镑|元)$/, "");
const denomination = (s: string) => /人民币|美元|欧元|韩元|港元|英镑/.exec(s)?.[0];

export function digestCoverage(entries: DigestEntry[], claims: {company: string; round: string | null; amountText: string | null}[]) {
  const used = new Set<number>();
  const missing = entries.filter(entry => {
    const heading = compact(entry.heading);
    const index = claims.findIndex((claim, i) => {
      if (used.has(i) || !claim.company) return false;
      const name = compact(claim.company);
      if (!entry.stage) return heading.includes(name);
      const words = entry.heading.split(/\s+/u);
      if (!words.some((_, i) => compact(words.slice(i).join("")) === name)) return false;
      if (!claim.round || stageName(claim.round) !== stageName(entry.stage)) return false;
      if (!entry.amount) return true;
      if (!claim.amountText || amountValue(claim.amountText) !== amountValue(entry.amount)) return false;
      const sourceCurrency = denomination(entry.amount);
      const reportedCurrency = denomination(claim.amountText);
      return !sourceCurrency || !reportedCurrency || sourceCurrency === reportedCurrency;
    });
    if (index < 0) return true;
    used.add(index);
    return false;
  });
  return { expected: entries.length, verified: used.size, missing };
}
