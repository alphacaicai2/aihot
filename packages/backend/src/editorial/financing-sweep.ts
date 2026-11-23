import { config } from "../config.ts";
import { sql } from "../db.ts";
import { chatJson } from "../providers/llm.ts";
import { BudgetExceededError, completeReceipt } from "../providers/receipts.ts";
import { modelFor } from "./models.ts";
import { FinancingBatchAnswer, financingInstructions, financingText, transactionInstructions, financingBatchEntry, type FinancingMaterial } from "./financing-extraction.ts";

const batchSize = 5;
const transactionVersion = "financing-transactions-v2";

async function enqueueFinancing() {
  return sql.begin(async tx => {
    const [lock] = await tx`SELECT pg_try_advisory_xact_lock(hashtext('financing.enqueue')) AS acquired`;
    if (!lock?.acquired) return;
    const roundup = sql`(coalesce(an.output->'financingReview'->>'reason', '')='no_single_transaction'
      OR concat_ws(' ',p.title,p.original_title) ~* '周报|月报|投融资汇总|融资盘点|roundup|weekly|[；;]')`;
    const rows = await tx<{id: number; title: string; excerpt: string | null; body: string | null; roundup: boolean}[]>`
      SELECT an.id, ${roundup} AS roundup, CASE WHEN a.revision=an.input_revision THEN a.title ELSE coalesce(r.title,p.original_title,'') END AS title,
        CASE WHEN a.revision=an.input_revision THEN a.excerpt END AS excerpt,
        CASE WHEN a.revision=an.input_revision THEN concat_ws(E'\n',a.x_post->>'text',a.x_article->>'text',a.body_text) ELSE r.body_text END AS body
      FROM publications p JOIN analyses an ON an.id=p.analysis_id AND an.article_id=p.article_id JOIN articles a ON a.id=p.article_id
      LEFT JOIN article_revisions r ON r.article_id=a.id AND r.revision=an.input_revision
      WHERE p.category='financing' AND p.eligible AND p.visibility='public'
        AND (NOT (coalesce(an.output,'{}'::jsonb) ? 'financingBatch') OR (
          (an.output->'financingReview'->>'version') IS DISTINCT FROM ${transactionVersion} AND EXISTS (
            SELECT 1 FROM financing_extraction_batches old
            WHERE old.id=(an.output->>'financingBatch')::bigint AND old.finished_at IS NOT NULL)
          AND ${roundup}))
      ORDER BY an.id DESC LIMIT 150`;
    const batches: FinancingMaterial[][] = [];
    let regular: FinancingMaterial[] = [];
    for (const row of rows) {
      const entry: FinancingMaterial = { id: row.id, format: "transactions",
        text: financingText(row.title, row.excerpt, row.body, row.roundup) };
      // Give long roundups their own input and answer budget.
      if (row.roundup) {
        batches.push([entry]);
      } else {
        if (!regular.length || regular.length === batchSize) { regular = []; batches.push(regular); }
        regular.push(entry);
      }
    }
    for (const material of batches) {
      const [batch] = await tx`INSERT INTO financing_extraction_batches(material) VALUES (${tx.json(material)}) RETURNING id`;
      await tx`UPDATE analyses SET output=coalesce(output,'{}'::jsonb) || jsonb_build_object('financingBatch',${batch!.id}::bigint)
        WHERE id IN ${tx(material.map(m => m.id))}`;
    }
  });
}

export async function runFinancingBatch() {
  if (!config.modelCallsEnabled) return "disabled";
  await enqueueFinancing();
  const [batch] = await sql<{id:number; material:FinancingMaterial[]; attempts:number}[]>`
    UPDATE financing_extraction_batches SET next_run=now()+interval '6 minutes',attempts=attempts+1
    WHERE id=(SELECT id FROM financing_extraction_batches WHERE finished_at IS NULL AND next_run <= now()
      ORDER BY next_run,id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id,material,attempts`;
  if (!batch) return "idle";
  try {
    // The batch's input is immutable. Re-parse an already received answer after a
    // validation upgrade instead of paying to produce the same text again.
    const subject = "financing-batch:" + batch.id;
    // Existing in-flight batches must keep their original prompt and receipt identity.
    const multi = batch.material[0]?.format === "transactions";
    const version = multi ? transactionVersion : "financing-investors-v1";
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
      model: await modelFor("structure"), fallback: false, purpose:"financing_extract", subject,
      promptVersion: version, system: multi ? transactionInstructions : financingInstructions, user: JSON.stringify(batch.material),
      schema: FinancingBatchAnswer, maxTokens: multi ? 12000 : 5000, temperature: 0, timeoutMs: 120000,
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
        await tx`UPDATE analyses SET output=output || ${tx.json(patch as never)}::jsonb
          WHERE id=${m.id} AND output->>'financingBatch'=${String(batch.id)}`;
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
