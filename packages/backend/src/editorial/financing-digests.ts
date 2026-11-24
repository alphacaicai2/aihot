// Match the original report's card or section structure. A publication category, a date
// in the title, or two mentions of "financing" alone do not establish a digest of deals.
export const digestTitlePattern = '日报|早报|晨报|晚报|早知道|每日(?:融资|投融资|创投)|(?:funding|financing|venture) daily|daily (?:funding|financing|venture)';
export const cardPattern = '(?:🇨🇳\\s*国内|🌍\\s*海外)([^📍📅]{1,180})📍\\s*([^📍📅]{1,24}?)\\s*📅';
export const dealHeadline = '[^【】；;]{1,65}?(?:完成|获得|获|筹集|募集)[^【】；;]{0,45}?(?:融资|募资|投资)';
export const sectionPattern = '【(' + dealHeadline + '[^【】]{0,65})】';

export type DigestEntry = { heading: string; stage?: string; amount?: string };
const compact = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
const printedAmount = /((?:超|约|近|数|逾)?(?:[\d.,]+|数|[零一二两三四五六七八九十百千]+)?\s*(?:[千百十]?万|[千百十]?亿)\s*(?:美元|人民币|欧元|韩元|港元|英镑|元))(?:\s*[（(][^（）()]*[）)])?\s*$/u;

export function printedCard(heading: string, marker: RegExpExecArray): DigestEntry {
  return { heading, stage: marker[2]!.trim(), amount: printedAmount.exec(marker[1]!)?.[1] };
}

export function digestEntries(title: string, excerpt: string | null, body: string | null, allowSingle = false): DigestEntry[] {
  const required = allowSingle ? 1 : 2;
  // A feed can repeat the full article in the excerpt. Count a source layout only once.
  const layouts: DigestEntry[][] = [];
  for (const text of [excerpt, body]) {
    if (!text) continue;
    const cards = Array.from(text.matchAll(new RegExp(cardPattern, "gu")), match =>
      // The flat feed joins the preceding investor list to the next company. The printed
      // recipient always ends immediately before the region marker; keep that exact context.
      printedCard(text.slice(Math.max(0, match.index - 100), match.index).trim(), match));
    if (cards.length >= required) layouts.push(cards);
    const headlines = new Set(Array.from(text.matchAll(new RegExp(sectionPattern, "gu")), m => m[1]!));
    if (headlines.size >= required) layouts.push([...headlines].map(heading => ({ heading })));
  }
  if (layouts.length) return layouts.sort((a, b) => b.length - a.length)[0]!;
  const headlines = title.split(/[；;]/).map(s => s.split(/[|｜丨]/)[0]!.trim()).filter(s => new RegExp(dealHeadline, "u").test(s));
  const unique = [...new Set(headlines)];
  return unique.length >= 2 ? unique.map(heading => ({ heading })) : [];
}

// Bound a named financing section at the next heading of any kind, including unrelated news.
export function financingSections(text: string, entries?: DigestEntry[]) {
  if (!entries?.length || entries.some(e => e.stage)) return [];
  const headings = new Set(entries.map(e => compact(e.heading)));
  const seen = new Set<string>();
  const sections: Array<{company:string; heading:string; text:string}> = [];
  for (const line of text.split("\n")) {
    const markers = [...line.matchAll(/【([^【】]+)】/gu)];
    for (const [i,m] of markers.entries()) {
      const title = m[1]!;
      if (!headings.has(compact(title))) continue;
      const company = title.split(/完成|获得|获|筹集|募集/u)[0]?.trim().replace(/(?:近日|宣布|连续|接连|已)+$/u, "").trim();
      if (!company) continue;
      const body = line.slice(m.index + m[0].length,markers[i + 1]?.index).trim();
      const key = title + "\n" + body;
      if (!body || seen.has(key)) continue;
      seen.add(key);
      sections.push({company:compact(company),heading:title,text:body});
    }
  }
  return sections;
}

const stageName = (s: string) => compact(s).replace(/[-‐‑–—]/g, "").replace(/轮融资$/, "轮");
const amountValue = (s: string) => compact(s).split(/[（(]/)[0]!.replace(/(?:人民币|美元|欧元|韩元|港元|英镑|元)$/, "");
const denomination = (s: string) => /人民币|美元|欧元|韩元|港元|英镑/.exec(s)?.[0];

// Recover the exact printed company span, retaining spaces inside Latin company names.
export function printedRecipient(heading: string, company: string) {
  const name = compact(company);
  for (const word of heading.matchAll(/(?:^|\s)(\S)/gu)) {
    const suffix = heading.slice(word.index + word[0].length - word[1]!.length).trimEnd();
    if (compact(suffix) === name) return suffix;
  }
  return null;
}

export function digestCoverage(entries: DigestEntry[], claims: {company: string; round: string | null; amountText: string | null}[]) {
  const used = new Set<number>();
  const missing = entries.filter(entry => {
    const heading = compact(entry.heading);
    const index = claims.findIndex((claim, i) => {
      if (used.has(i) || !claim.company) return false;
      const name = compact(claim.company);
      if (!entry.stage) return heading.includes(name);
      if (!printedRecipient(entry.heading, claim.company)) return false;
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
