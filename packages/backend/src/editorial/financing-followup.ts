// One supplemental request per newly processed digest. Its result IDs identify original
// sections, so the answer to one section can never validate against a different section.
import type { FinancingClaim } from "@aihot/contracts/financing";
import { sql, type Db, type Tx } from "../db.ts";
import { cardPattern, digestCoverage, type DigestEntry } from "./financing-digests.ts";
import { additionalDigestEntries } from "./financing-supplemental-sections.ts";
import { financingBatchEntry, type FinancingMaterial } from "./financing-extraction.ts";

type Repair = { analysisId: number; parentBatch: number };
export type BatchMaterial = FinancingMaterial & { repair?: Repair; missingRounds?: string[] };
type Coverage = ReturnType<typeof digestCoverage>;
type Original = { title: string; excerpt: string | null; body: string | null };
const compact = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
const maxSections = 24;
const maxInput = 24000;

// A source can repeat its excerpt in its full body. For an identical heading use the
// longest rendering, and bound the passage at the next heading of *any* kind.
function passages(original: Original, entries: DigestEntry[]) {
  const found = new Map<DigestEntry, string>();
  const keep = (entry: DigestEntry, value: string) => {
    if (value.length > (found.get(entry)?.length ?? 0)) found.set(entry, value);
  };
  for (const field of [original.body, original.excerpt]) {
    if (!field) continue;
    const markers = [...field.matchAll(/【([^【】]+)】/gu)];
    for (const [i, match] of markers.entries()) {
      const entry = entries.find(e => !e.stage && compact(e.heading) === compact(match[1]!));
      if (entry) keep(entry, field.slice(match.index, markers[i+1]?.index).trim());
    }
    const cards = [...field.matchAll(new RegExp(cardPattern,"gu"))];
    for (const [i, mark] of cards.entries()) {
      const prefix = field.slice(Math.max(0,mark.index - 100),mark.index);
      const entry = entries.find(e => e.stage && compact(e.heading) === compact(prefix) && compact(e.stage) === compact(mark[2]!));
      if (!entry) continue;
      // Keep the next card's marker as a boundary: the flattened investor list can
      // end immediately before its recipient, which must not become an investor.
      const next = cards[i+1];
      keep(entry, prefix + field.slice(mark.index,next ? next.index + next[0].length : undefined));
    }
  }
  for (const entry of entries) {
    if (!found.has(entry) && !entry.stage && original.title.includes(entry.heading)) found.set(entry,entry.heading);
  }
  return found;
}

function belongs(entry: DigestEntry, text: string, claim: FinancingClaim) {
  const headlineMatches = digestCoverage([entry],[claim]).verified > 0;
  if (entry.stage || !text.startsWith("【")) return headlineMatches;
  if (!compact(text).includes(compact(claim.evidence))) return false;
  const name = compact(claim.company);
  const heading = compact(entry.heading);
  const afterName = heading.slice(heading.indexOf(name) + name.length);
  if (headlineMatches && !/^(?:独家|共同|联合)?(?:领投|跟投|参投|对外投资)/u.test(afterName)) return true;
  // Some headlines use an alias/description, while the opening financing sentence
  // identifies the legal recipient. A name buried in later background is insufficient.
  const body = text.slice(text.indexOf("】")+1).trim();
  const first = body.split(/[。！？；;\n]/u).find(s=>s.trim()) ?? "";
  const intro = compact(first);
  const at = intro.indexOf(name);
  const after = intro.slice(at + name.length);
  return at >= 0 && /^(?:[(（][^()（）]{1,80}[)）])?(?:近日|近期|日前|已|宣布|成功|最近|已于近日|新近)*(?:完成(?!对)|达成|获得|取得|筹集|募集|获投|已融资|hasraised|secured)/iu.test(after) &&
    compact(claim.evidence).includes(name);
}

const stageStem = "(?:pre[-‐‑–— ]?)?[A-H]\\d*[+＋]*|(?:天使|种子)[+＋]*";
const joinedRounds = new RegExp(`((?:${stageStem})\\s*(?:轮)?(?:\\s*(?:及|和|与|、|以及|及其)\\s*(?:${stageStem})\\s*(?:轮)?)+)\\s*(?:股权)?融资`,"iu");
const stageKey = (value: string) => compact(value).replace(/[-‐‑–—]/gu,"").replace(/轮(?:融资)?$/u,"");

function requiredRounds(entry: DigestEntry, text: string) {
  if (entry.stage) return [];
  // Require one current announcement of joined, named stages, never two loose
  // matches from a comparison with last year's round or a different company.
  const intro = text.replace(/^【[^【】]+】/u,"").trim().split(/[。；;！？\n]/u)[0] ?? "";
  for (const sentence of [entry.heading,intro]) {
    if (!/完成|获得|宣布|获投/u.test(sentence) || /此前|早前|去年|上一轮|曾|计划|拟|洽谈/u.test(sentence)) continue;
    const match = joinedRounds.exec(sentence);
    if (match) return [...new Set(Array.from(match[1]!.matchAll(new RegExp(`(?:${stageStem})\\s*(?:轮)?`,"giu")), m=>stageKey(m[0])))];
  }
  return [];
}

export function missingDigestSections(original: Original, entries: DigestEntry[], claims: FinancingClaim[]) {
  const slices = passages(original,entries);
  const sections = [...entries];
  for (const {sourceText,...entry} of additionalDigestEntries(original,entries)) {
    sections.push(entry);
    slices.set(entry,sourceText);
  }
  const material: BatchMaterial[] = [];
  const missing: Array<DigestEntry & {rounds?: string[]}> = [];
  const used = new Set<number>();
  for (const [i,entry] of sections.entries()) {
    const text = slices.get(entry) ?? "";
    const matches = claims.map((claim,index)=>({claim,index})).filter(({claim,index})=>!used.has(index) && belongs(entry,text,claim));
    const stages = requiredRounds(entry,text);
    const missingRounds = stages.filter(stage=>!matches.some(({claim})=>!claim.recordType && stageKey(claim.round ?? "")===stage));
    for (const m of matches) used.add(m.index);
    if (matches.length && !missingRounds.length) continue;
    missing.push(missingRounds.length ? {...entry,rounds:missingRounds} : entry);
    if (!text || material.length >= maxSections) continue;
    // Negative section IDs cannot collide with real analysis IDs in the queue.
    material.push({id:-(i+1),format:"rounds",digestEntries:[entry],...(missingRounds.length && {missingRounds}),text});
  }
  // Give every selected section room even when earlier passages in the full body
  // are very long. Short entries release their unused space to the next ones.
  let remaining = maxInput;
  for (const [i,m] of material.entries()) {
    m.text = m.text.slice(0,Math.min(3500,Math.floor(remaining/(material.length-i))));
    remaining -= m.text.length;
  }
  return { coverage:{expected:sections.length,verified:sections.length-missing.length,missing}, material };
}

export const noManualFinancingReview = sql`NOT (an.output ? 'financingSourceAdditions')
  AND NOT EXISTS (SELECT 1 FROM financing_claim_reviews f WHERE f.article_id=an.article_id)
  AND NOT EXISTS (SELECT 1 FROM financing_round_sources f WHERE f.article_id=an.article_id)`;

// Run only while saving a successful first pass. Existing finished or explicitly
// historical extractions do not start new paid work on upgrade.
export async function queueMissingSections(tx: Tx, m: FinancingMaterial, parentBatch: number, claims: FinancingClaim[]) {
  if (!m.digestEntries?.length || m.historicalDigest || m.previousBatch || m.replacesEmptyBatch) return;
  const [original] = await tx<Original[]>`SELECT
    CASE WHEN an.input_revision=a.revision THEN a.title ELSE rev.title END AS title,
    CASE WHEN an.input_revision=a.revision THEN a.excerpt END AS excerpt,
    CASE WHEN an.input_revision=a.revision THEN concat_ws(E'\n',a.x_post->>'text',a.x_article->>'text',a.body_text) ELSE rev.body_text END AS body
    FROM analyses an JOIN articles a ON a.id=an.article_id
    JOIN publications p ON p.article_id=a.id AND p.analysis_id=an.id AND p.eligible AND p.visibility='public'
    LEFT JOIN article_revisions rev ON rev.article_id=a.id AND rev.revision=an.input_revision
    WHERE an.id=${m.id} AND an.output->>'financingBatch'=${String(parentBatch)} AND ${noManualFinancingReview}
      AND (an.input_revision=a.revision OR rev.article_id IS NOT NULL) FOR UPDATE OF an`;
  if (!original) return;
  const {coverage,material} = missingDigestSections(original,m.digestEntries,claims);
  if (!material.length) return {coverage};
  material[0]!.repair = {analysisId:m.id,parentBatch};
  const [child] = await tx`INSERT INTO financing_extraction_batches(material) VALUES (${tx.json(material)}) RETURNING id`;
  return {coverage,followup:{batchId:Number(child!.id),state:"queued"}};
}

function owner(repair: Repair, childId: number) {
  return sql`an.id=${repair.analysisId} AND an.output->>'financingBatch'=${String(repair.parentBatch)}
    AND an.output#>>'{financingReview,followup,batchId}'=${String(childId)}
    AND an.output#>>'{financingReview,followup,state}'='queued' AND ${noManualFinancingReview}
    AND EXISTS (SELECT 1 FROM publications p WHERE p.analysis_id=an.id AND p.article_id=an.article_id
      AND p.eligible AND p.visibility='public')`;
}

export async function stillNeedsFollowup(db: Db, repair: Repair, childId: number) {
  return (await db`SELECT 1 FROM analyses an WHERE ${owner(repair,childId)}`).length > 0;
}

export async function finishFollowup(tx: Tx, materials: BatchMaterial[], childId: number,
  receiptId: number, answers: Map<number,unknown>, state: "completed" | "unusable") {
  const repair = materials[0]!.repair!;
  const [parent] = await tx`SELECT an.output FROM analyses an WHERE ${owner(repair,childId)} FOR UPDATE OF an`;
  if (!parent) return;
  const review = parent.output.financingReview;
  const before: Coverage = review.coverage;
  const claims: FinancingClaim[] = [...(parent.output.financingClaims ?? [])];
  const added: FinancingClaim[] = [];
  const transactions = [...(review.transactions ?? [])];
  const resolved = new Map<string,Set<string>>();
  const key = (entry: DigestEntry) => JSON.stringify([entry.heading,entry.stage,entry.amount]);
  for (const m of materials) {
    const entry = m.digestEntries![0]!;
    const result = financingBatchEntry(m,answers.get(m.id));
    for (const [i,claim] of (result.claims ?? []).entries()) {
      const stage = stageKey(claim.round ?? "");
      if (!belongs(entry,m.text,claim) || (m.missingRounds && (claim.recordType || !m.missingRounds.includes(stage)))) continue;
      // Only add transactions from a missing section. Never replace first-pass
      // amounts or investors, even if a different wording was returned on retry.
      const duplicate = [...claims,...added].some(c => compact(c.company)===compact(claim.company) &&
        c.kind===claim.kind && compact(c.round ?? "")===compact(claim.round ?? ""));
      if (!duplicate) {
        added.push(claim);
        if ("transactions" in result.review) transactions.push(result.review.transactions![i]);
      }
      if (!duplicate || [...claims,...added].some(c=>belongs(entry,m.text,c) && stageKey(c.round ?? "")===stage)) {
        const found = resolved.get(key(entry)) ?? new Set<string>();
        found.add(stage);
        resolved.set(key(entry),found);
      }
    }
  }
  claims.push(...added);
  const missing = (before.missing as Array<DigestEntry & {rounds?:string[]}>).flatMap(entry=>{
    const found = resolved.get(key(entry));
    if (!found) return [entry];
    const left = entry.rounds?.filter(r=>!found.has(r));
    return left?.length ? [{...entry,rounds:left}] : [];
  });
  const coverage = {expected:before.expected,verified:before.expected-missing.length,missing};
  const patch = {financing:claims.length===1 ? claims[0] : null,financingClaims:claims,
    financingReview:{...review,coverage,transactions,reason:missing.length ? "incomplete_roundup" : "verified_transactions",
      followup:{batchId:childId,state,receiptId,added:added.length}}};
  await tx`UPDATE analyses an SET output=output || ${tx.json(patch as never)}::jsonb WHERE ${owner(repair,childId)}`;
}
