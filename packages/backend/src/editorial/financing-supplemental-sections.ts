// A mixed news digest can announce a financing in the opening of a section headed
// by something else (e.g. becoming a unicorn). This finds passages for the worker
// to verify. A matching phrase alone never creates a financing record.
import type { DigestEntry } from "./financing-digests.ts";

const key = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
const currencyAmount = /(?:\d[\d.,]*|数|[一两三四五六七八九十]+)(?:千|万|亿|百万|千万|十亿|百亿|万亿)+/u;
const currentDeal = /(?:已达成|宣布完成|完成了?|新近获得|成功获得|筹集了?|募集了?|刚刚获得)[^。！？；;]{0,65}(?:轮(?:次)?(?:的)?融资|(?:轮|轮次)(?:股权)?投资|融资|贷款|股权增资)|(?:首轮|新一轮|本轮|[a-f]\d*\+?轮)融资[^。！？；;]{0,35}(?:领投|参投|交割|交割完成)|(?:增资款|融资款)[^。！？；;]{0,16}(?:到账|交割)|(?:股权发行|增资扩股)中(?:认购|投资)|(?:正在|正就|计划|拟)[^。！？；;]{0,60}(?:首轮融资|新一轮融资|轮次的融资)/iu;
const comparison = /(?:曾于|曾在|此前|去年|早在|彼时|回顾|上一轮)/u;
const enDeal = /\b(?:has (?:just )?(?:raised|secured)|announced (?:a |the closing of )|closed (?:a |its ))[^.!?;\n]{0,85}(?:\b(?:funding|financing|series [a-z]\b|seed round)\b|\$\s*\d)/iu;

function opensWithFinancing(body: string) {
  // Only the introductory sentences describe the section subject reliably. A
  // background paragraph elsewhere in the item cannot trigger a second request.
  const opening = body.trim().slice(0, 500).split(/(?<=[。！？；;])|\n+/u).filter(s=>s.trim()).slice(0, 2);
  return opening.some(sentence => {
    const text = key(sentence);
    return !comparison.test(text) && (enDeal.test(sentence) ||
      currentDeal.test(text) && (currencyAmount.test(text) || /领投|跟投|参投|股权发行|首轮融资|[a-f]\d*\+?轮/u.test(text)));
  });
}

export function additionalDigestEntries(original: {title: string; excerpt: string | null; body: string | null},
  existing: DigestEntry[]): Array<DigestEntry & {sourceText: string}> {
  if (existing.some(e => e.stage)) return [];
  const known = new Set(existing.map(e => key(e.heading)));
  const added = new Map<string, {heading: string; sourceText: string}>();
  for (const field of [original.body, original.excerpt]) {
    if (!field) continue;
    const headings = [...field.matchAll(/【([^【】]+)】/gu)];
    for (const [index, match] of headings.entries()) {
      const heading = match[1]!.trim();
      const normalized = key(heading);
      if (!normalized || known.has(normalized)) continue;
      const end = headings[index + 1]?.index;
      const body = field.slice(match.index + match[0].length, end);
      if (!opensWithFinancing(body)) continue;
      const sourceText = field.slice(match.index, end).trim();
      if (sourceText.length > (added.get(normalized)?.sourceText.length ?? 0)) {
        added.set(normalized, {heading, sourceText});
      }
    }
  }
  return [...added.values()];
}
