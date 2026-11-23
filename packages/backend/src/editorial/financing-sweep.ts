import { config } from "../config.ts";
import { sql, type Db, type Tx } from "../db.ts";
import { cardPattern, dealHeadline, digestEntries, digestTitlePattern, sectionPattern } from "./financing-digests.ts";
import { chatJson } from "../providers/llm.ts";
import { BudgetExceededError, completeReceipt } from "../providers/receipts.ts";
import { modelFor } from "./models.ts";
import { FinancingBatchAnswer, financingBatchProtocol, financingText, financingBatchEntry, type FinancingMaterial } from "./financing-extraction.ts";

const batchSize = 5;

// The source revision and its original headings are authoritative for an old analysis.
const unreviewedFields = sql`coalesce(an.output->'financing','null'::jsonb)='null'::jsonb
  AND coalesce(an.output->'financingClaims','[]'::jsonb)='[]'::jsonb
  AND NOT EXISTS (SELECT 1 FROM financing_claim_reviews fc WHERE fc.article_id=an.article_id)
  AND NOT EXISTS (SELECT 1 FROM financing_round_sources fr WHERE fr.article_id=an.article_id)`;

interface PendingArticle {
  id: number;
  title: string;
  excerpt: string | null;
  body: string | null;
  daily: boolean;
  roundup: boolean;
  previous: number | null;
  figures: Array<{text: string}> | null;
}

export async function pendingFinancing(db: Db, dailyStartId: number, approvedIds?: number[]) {
  const titles = sql`concat_ws(' ',p.title,p.original_title,src.title)`;
  const weekly = sql`${titles} ~* '(投融资|融资|创投|投资|风投|募资).{0,5}(周报|周刊|周览|周记|周汇总)|(每周|一周|本周).{0,6}(投融资汇总|融资盘点|融资汇总|融资速递)|(funding|venture|financing).{0,15}(weekly|week in review|roundup)|(weekly|week in).{0,15}(funding|venture|financing)'`;
  const daily = sql`CASE WHEN (an.id>${dailyStartId} OR an.output#>>'{financingReview,reason}'='no_single_transaction')
    AND ${titles} ~* ${digestTitlePattern} THEN
    EXISTS (SELECT 1 FROM unnest(ARRAY[src.excerpt,src.body]) t
      WHERE regexp_count(t,${cardPattern}) >= 2 OR (SELECT count(DISTINCT match[1])>=2 FROM regexp_matches(t,${sectionPattern},'g') match))
    OR (SELECT count(DISTINCT part)>=2 FROM regexp_split_to_table(src.title,'[；;]') part WHERE part ~ ${dealHeadline})
    ELSE false END`;
  // Reopen only an empty v1 decision backed by the finished receipt, never a pending/unknown
  // payment. The new batch has a different question and uses the ordinary receipt and budget path.
  const safeLegacyDigest = sql`an.output#>>'{financingReview,version}'='financing-investors-v1'
    AND an.output#>>'{financingReview,reason}'='no_single_transaction' AND ${unreviewedFields}
    AND EXISTS (SELECT 1 FROM receipts rc WHERE rc.subject='financing-batch:'||(an.output->>'financingBatch')
      AND rc.id::text=an.output#>>'{financingReview,receiptId}' AND rc.purpose='financing_extract' AND rc.status='completed')`;
  return db<PendingArticle[]>`
    WITH candidates AS MATERIALIZED (
      SELECT p.article_id,p.analysis_id,p.category,p.title,p.original_title
      FROM publications p WHERE p.eligible AND p.visibility='public'
        ${approvedIds ? sql`AND p.analysis_id IN ${sql(approvedIds)}` : sql``}
        AND (p.category='financing' OR concat_ws(' ',p.title,p.original_title) ~* '周|week|roundup'
          OR (p.analysis_id>${dailyStartId} AND concat_ws(' ',p.title,p.original_title) ~* ${digestTitlePattern}))
    )
    SELECT an.id, src.title, src.excerpt, src.body, ${daily} AS daily,
      (${weekly} OR ${titles} ~* '周报|月报|投融资汇总|融资盘点|roundup|weekly|[；;]') AS roundup,
      (an.output->>'financingBatch')::bigint AS previous, an.output->'financingSourceFigures' AS figures
    FROM candidates p JOIN analyses an ON an.id=p.analysis_id AND an.article_id=p.article_id JOIN articles a ON a.id=p.article_id
    LEFT JOIN article_revisions r ON r.article_id=a.id AND r.revision=an.input_revision
    CROSS JOIN LATERAL (SELECT CASE WHEN a.revision=an.input_revision THEN a.title ELSE coalesce(r.title,p.original_title,'') END AS title,
      CASE WHEN a.revision=an.input_revision THEN a.excerpt END AS excerpt,
      CASE WHEN a.revision=an.input_revision THEN concat_ws(E'\\n',a.x_post->>'text',a.x_article->>'text',a.body_text) ELSE r.body_text END AS body) src
    WHERE ${approvedIds ? sql`NOT (coalesce(an.output,'{}'::jsonb) ? 'financingBatch') AND ${unreviewedFields}
      AND NOT EXISTS (SELECT 1 FROM financing_extraction_batches b WHERE b.finished_at IS NULL
        AND b.material @> jsonb_build_array(jsonb_build_object('id',an.id))) AND` : sql``} (
      (NOT (coalesce(an.output,'{}'::jsonb) ? 'financingBatch') AND (p.category='financing' OR ${weekly} OR ${daily}))
      OR (EXISTS (SELECT 1 FROM financing_extraction_batches old WHERE old.id=(an.output->>'financingBatch')::bigint AND old.finished_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM receipts rc WHERE rc.subject='financing-batch:'||(an.output->>'financingBatch')
          AND rc.purpose='financing_extract' AND rc.status IN ('pending','unknown'))
        AND ((coalesce(an.output#>>'{financingReview,version}','') NOT IN ('financing-transactions-v2','financing-transactions-v3','financing-digest-v1')
             AND ${weekly} AND ${unreviewedFields}) OR (${safeLegacyDigest} AND ${daily}))))
    ORDER BY an.id DESC LIMIT 150`;
}

async function enqueueFinancing() {
  return sql.begin(async tx => {
    const [lock] = await tx`SELECT pg_try_advisory_xact_lock(hashtext('financing.enqueue')) AS acquired`;
    if (!lock?.acquired) return;
    // Apply the new cross-category digest rule to newly analyzed reports. Older ordinary
    // daily editions that never had a financing review are outside the v1 repair.
    const key = "financing.daily-start-analysis";
    await tx`INSERT INTO settings (key,value)
      SELECT ${key},to_jsonb(coalesce((SELECT max(id) FROM analyses),0))
      WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key=${key}) ON CONFLICT DO NOTHING`;
    const [start] = await tx`SELECT value FROM settings WHERE key=${key}`;
    const rows = await pendingFinancing(tx, Number(start!.value));
    await enqueueRows(tx, rows, false);
  });
}

async function enqueueRows(tx: Tx, rows: PendingArticle[], approvedHistory: boolean) {
  const batches: FinancingMaterial[][] = [];
  let regular: FinancingMaterial[] = [];
  for (const row of rows) {
    const sections = row.daily ? digestEntries(row.title, row.excerpt, row.body) : [];
    if (approvedHistory && !sections.length) continue;
    const entry: FinancingMaterial = { id: row.id, format: "rounds",
      ...(approvedHistory && { historicalDigest: true }),
      ...(sections.length ? { digestEntries: sections, ...(row.previous && { replacesEmptyBatch: row.previous }) } : {}),
      text: [financingText(row.title, row.excerpt, row.body, row.roundup || row.daily),
        ...(row.figures ?? []).map(figure => figure.text)].filter(Boolean).join("\n") };
    // Give long roundups their own input and answer budget.
    if (row.roundup || row.daily) {
      batches.push([entry]);
    } else {
      if (!regular.length || regular.length === batchSize) { regular = []; batches.push(regular); }
      regular.push(entry);
    }
  }
  const queued: number[] = [];
  for (const material of batches) {
    const [batch] = await tx`INSERT INTO financing_extraction_batches(material) VALUES (${tx.json(material)}) RETURNING id`;
    const protectedDigest = material.length === 1 && (material[0]!.replacesEmptyBatch || material[0]!.historicalDigest);
    const updated = await tx`UPDATE analyses an SET output=coalesce(output,'{}'::jsonb) || jsonb_build_object('financingBatch',${batch!.id}::bigint)
      WHERE id IN ${tx(material.map(m => m.id))}
        ${protectedDigest ? sql`AND ${unreviewedFields} AND output->>'financingBatch' IS NOT DISTINCT FROM
          ${material[0]!.replacesEmptyBatch ? String(material[0]!.replacesEmptyBatch) : null}::text` : sql``} RETURNING id`;
    if (!updated.length) await tx`DELETE FROM financing_extraction_batches WHERE id=${batch!.id}`;
    else queued.push(...updated.map(row => Number(row.id)));
  }
  return queued;
}

/** Explicit, idempotent opt-in for identified historical reports. Regular ticks never
 * discover this list. A dry run uses the same source and previous-review checks. */
export async function historicalFinancingDigests(ids: number[], apply = false) {
  if (!ids.length || ids.length > 150 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error("expected 1–150 positive analysis IDs");
  return sql.begin(apply ? "read write" : "read only", async tx => {
    if (apply) await tx`SELECT pg_advisory_xact_lock(hashtext('financing.enqueue'))`;
    const rows = (await pendingFinancing(tx, 0, ids)).filter(row => row.daily && !row.previous && digestEntries(row.title, row.excerpt, row.body).length >= 2);
    return apply ? await enqueueRows(tx, rows, true) : rows.map(row => row.id);
  });
}

export async function runFinancingBatch() {
  if (!config.modelCallsEnabled) return "disabled";
  await enqueueFinancing();
  const [batch] = await sql<{id:number; material:FinancingMaterial[]; attempts:number}[]>`
    UPDATE financing_extraction_batches SET next_run=now()+interval '6 minutes',attempts=attempts+1
    WHERE id=(SELECT id FROM financing_extraction_batches WHERE finished_at IS NULL AND next_run <= now()
      ORDER BY (material->0 ? 'historicalDigest'),next_run,id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id,material,attempts`;
  if (!batch) return "idle";
  try {
    // The batch's input is immutable. Re-parse an already received answer after a
    // validation upgrade instead of paying to produce the same text again.
    const subject = "financing-batch:" + batch.id;
    // Existing in-flight batches must keep their original prompt and receipt identity.
    const { multi, version, system } = financingBatchProtocol(batch.material[0]);
    const [stored] = await sql<{id:number; content:string}[]>`
      SELECT id, response->'choices'->0->'message'->>'content' AS content FROM receipts
      WHERE purpose='financing_extract' AND subject=${subject} AND request->>'promptVersion'=${version}
        AND status='failed' AND error LIKE 'unusable output:%'
        AND response->'choices'->0->>'finish_reason'='stop'
      ORDER BY id DESC LIMIT 1`;
    let recovered: typeof FinancingBatchAnswer._output | undefined;
    if (stored?.content) {
      try { recovered = FinancingBatchAnswer.parse(JSON.parse(stored.content)); } catch { /* provider parser can retry malformed JSON */ }
    }
    const res = recovered && stored ? {data:recovered, receiptId:stored.id} : await chatJson({
      model: await modelFor("financing"), fallback: false, purpose:"financing_extract", subject,
      promptVersion: version, system, user: JSON.stringify(batch.material),
      schema: FinancingBatchAnswer, reuseAcrossModels: true, maxTokens: multi ? 12000 : 5000, temperature: 0, timeoutMs: 120000,
    });
    const byId = new Map<number, unknown>();
    for (const row of res.data.results) {
      byId.set(row.id, byId.has(row.id) ? undefined : (multi ? row.claims : row.claim));
    }
    await sql.begin(async tx => {
      const [owner] = await tx`SELECT id FROM financing_extraction_batches WHERE id=${batch.id} AND attempts=${batch.attempts} AND finished_at IS NULL FOR UPDATE`;
      if (!owner) return;
      for (const m of batch.material) {
        const { claim, claims, review } = financingBatchEntry(m, byId.get(m.id));
        // A second pass with more source material may enrich a claim. Preserve the original
        // review when it finds no investor or switches to another company in the same report.
        if (m.previousBatch) {
          const kept = await tx`UPDATE analyses SET output=output || jsonb_build_object('financingBatch',${m.previousBatch}::bigint)
            WHERE id=${m.id} AND output->>'financingBatch'=${String(batch.id)}
              AND (${!claim?.investors.length} OR (output->'financing'->>'company' IS NOT NULL
                AND lower(output->'financing'->>'company') <> lower(${claim?.company ?? ""}))) RETURNING id`;
          if (kept.length) continue;
        }
        // An omitted or malformed result must not discard valid siblings or be mistaken for no deal.
        if (review.reason === "invalid_result" && batch.material.length > 1) {
          const [retry] = await tx`INSERT INTO financing_extraction_batches(material) VALUES (${tx.json([m])}) RETURNING id`;
          await tx`UPDATE analyses SET output=output || jsonb_build_object('financingBatch',${retry!.id}::bigint)
            WHERE id=${m.id} AND output->>'financingBatch'=${String(batch.id)}`;
          continue;
        }
        // A confirmed but unusable individual answer remains distinguishable from a source
        // with no transaction. Replaying the same receipt would never repair its contents.
        const fields = review.reason === "invalid_result" ? {} : { financing: claim, ...(claims && { financingClaims: claims }) };
        const patch = { ...fields, financingReview: { ...review, version, receiptId: res.receiptId } };
        await tx`UPDATE analyses an SET output=output || ${tx.json(patch as never)}::jsonb
          WHERE id=${m.id} AND output->>'financingBatch'=${String(batch.id)}
          ${(m.replacesEmptyBatch || m.historicalDigest) ? sql`AND ${unreviewedFields}` : sql``}`;
      }
      await completeReceipt(tx, res.receiptId);
      await tx`UPDATE financing_extraction_batches SET finished_at=now(),last_error=NULL WHERE id=${batch.id}`;
    });
    return "completed";
  } catch (error) {
    const budget = error instanceof BudgetExceededError;
    const delay = budget ? error.retryAfterSeconds : Math.min(86400, 60 * 2 ** Math.min(batch.attempts,11));
    await sql`UPDATE financing_extraction_batches SET next_run=now()+make_interval(secs=>${delay}),last_error=${error instanceof Error ? error.constructor.name : "Error"}
      WHERE id=${batch.id} AND finished_at IS NULL AND attempts=${batch.attempts}`;
    throw error;
  }
}
