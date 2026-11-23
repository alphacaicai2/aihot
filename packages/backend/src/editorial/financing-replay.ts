import type { FinancingClaim } from "@aihot/contracts/financing";
import { financingSections } from "./financing-digests.ts";
import { sql } from "../db.ts";
import { FinancingBatchAnswer, financingBatchEntry, type FinancingMaterial } from "./financing-extraction.ts";

const key = (c: FinancingClaim) => JSON.stringify([c.company,c.kind,c.round,c.amountText,c.recordType]);

/** Revalidate explicitly listed, finished structured financing digests from their original completed receipt.
 * No provider or scheduler is involved. Keep accepted field values and skip edited/reconciled reports. */
export async function replayFinancingDigests(ids: number[], apply = false) {
  if (!ids.length || ids.length > 150 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error("expected 1–150 positive analysis IDs");
  return sql.begin(apply ? "read write" : "read only", async tx => {
    const rows = await tx<{id:number; material:FinancingMaterial; receipt_id:number; content:string; prior:FinancingClaim[]}[]>`
      SELECT an.id,b.material->0 AS material,rc.id AS receipt_id,rc.response->'choices'->0->'message'->>'content' AS content,
        coalesce(an.output->'financingClaims','[]'::jsonb) AS prior
      FROM analyses an JOIN publications p ON p.analysis_id=an.id AND p.article_id=an.article_id
      JOIN financing_extraction_batches b ON b.id=(an.output->>'financingBatch')::bigint
      JOIN receipts rc ON rc.subject='financing-batch:'||b.id AND rc.id::text=an.output#>>'{financingReview,receiptId}'
      WHERE an.id IN ${tx(ids)} AND p.eligible AND p.visibility='public' AND b.finished_at IS NOT NULL
        AND jsonb_array_length(b.material)=1 AND b.material->0->>'id'=an.id::text
        AND an.output#>>'{financingReview,version}'='financing-digest-v1'
        AND rc.request->>'promptVersion'='financing-digest-v1' AND rc.purpose='financing_extract' AND rc.status='completed'
        AND rc.response->'choices'->0->>'finish_reason'='stop'
        AND NOT EXISTS (SELECT 1 FROM financing_claim_reviews f WHERE f.article_id=an.article_id)
        AND NOT EXISTS (SELECT 1 FROM financing_round_sources f WHERE f.article_id=an.article_id)
      ORDER BY an.id ${apply ? tx`FOR UPDATE OF an` : tx``}`;
    const improved = [];
    for (const row of rows) {
      const {digestEntries, text} = row.material;
      if (!row.content || (!digestEntries?.some(e => e.stage) && !financingSections(text,digestEntries).length)) continue;
      let parsed;
      try { parsed = FinancingBatchAnswer.parse(JSON.parse(row.content)); } catch { continue; }
      const entries = parsed.results.filter(r => r.id === row.id);
      if (entries.length !== 1) continue;
      const result = financingBatchEntry(row.material,entries[0]!.claims);
      const claims = result.claims;
      if (!claims || !("coverage" in result.review) || !result.review.coverage?.verified) continue;
      // If a previously accepted identity or investor cannot be independently verified by
      // the new pass, retain the complete prior review. Never overwrite a human decision.
      if (!row.prior.every(old => claims.some(c => key(c) === key(old) && old.investors.every(i => c.investors.includes(i))))) continue;
      const existing = new Map(row.prior.map(c => [key(c),c]));
      let addedInvestors = 0;
      const kept = claims.map(c => {
        const old = existing.get(key(c));
        if (!old) return c;
        addedInvestors += c.investors.filter(i => !old.investors.includes(i)).length;
        return { ...old, investors:c.investors };
      });
      if (kept.length <= row.prior.length && !addedInvestors) continue;
      const coverage = result.review.coverage;
      const patch = { financing:kept.length===1 ? kept[0] : null, financingClaims:kept,
        financingReview:{ ...result.review, version:"financing-digest-v1", receiptId:row.receipt_id } };
      if (apply) {
        const changed = await tx`UPDATE analyses an SET output=output || ${tx.json(patch as never)} WHERE id=${row.id}
          AND NOT EXISTS (SELECT 1 FROM financing_claim_reviews f WHERE f.article_id=an.article_id)
          AND NOT EXISTS (SELECT 1 FROM financing_round_sources f WHERE f.article_id=an.article_id) RETURNING id`;
        if (!changed.length) continue;
      }
      improved.push({id:row.id,receiptId:row.receipt_id,claims:kept.length,expected:coverage.expected,verified:coverage.verified});
    }
    return improved;
  });
}
