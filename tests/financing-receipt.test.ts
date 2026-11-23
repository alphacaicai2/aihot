import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { runFinancingBatch } from "@aihot/backend/editorial/financing-sweep";
import { ReceiptBusyError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";

after(closeDb);

test("switching financing channels preserves unresolved and received batch receipts", async () => {
  const answer = { choices: [{ message: { content: '```json\n{"results":[{"id":-1,"claims":[]}]}\n```' } }] };
  const provider = await stub(() => answer);
  Object.assign(process.env, { STRUCTURE_MODEL: "deepseek-flash", DEEPSEEK_BASE_URL: provider.url, DEEPSEEK_API_KEY: "test-key" });
  const addBatch = async () => {
    const [batch] = await sql`INSERT INTO financing_extraction_batches(material,next_run)
      VALUES (${sql.json([{ id: -1, text: tag(), format: "rounds" }])}, '1900-01-01') RETURNING id`;
    return batch!.id;
  };
  const addReceipt = async (batch: number, status: string) => {
    const [receipt] = await sql`INSERT INTO receipts(logical_key,service,model,purpose,subject,status,request)
      VALUES (${tag()},'llm','retired-model','financing_extract',${"financing-batch:" + batch},${status},
              '{"promptVersion":"financing-transactions-v3"}') RETURNING id`;
    return receipt!.id;
  };
  const batch = await addBatch();
  try {
    const old = await addReceipt(batch, "pending");
    await assert.rejects(runFinancingBatch(), ReceiptBusyError);
    await sql`UPDATE receipts SET status='unknown' WHERE id=${old}`;
    await sql`UPDATE financing_extraction_batches SET next_run='1900-01-01' WHERE id=${batch}`;
    await assert.rejects(runFinancingBatch(), ReceiptUnknownError);
    await sql`UPDATE receipts SET status='received', response=${sql.json(answer)} WHERE id=${old}`;
    await sql`UPDATE financing_extraction_batches SET next_run='1900-01-01' WHERE id=${batch}`;
    assert.equal(await runFinancingBatch(), "completed");
    assert.equal(provider.hits(), 0);
    assert.deepEqual((await sql`SELECT status FROM receipts WHERE subject=${"financing-batch:" + batch}`).map(r => r.status), ["completed"]);

    const retry = await addBatch();
    await addReceipt(retry, "failed");
    assert.equal(await runFinancingBatch(), "completed");
    assert.equal(provider.hits(), 1);
    const [fresh] = await sql`SELECT service, model FROM receipts WHERE subject=${"financing-batch:" + retry} AND status='completed'`;
    assert.equal(fresh?.service, "deepseek");
    assert.equal(fresh?.model, "deepseek-flash");
  } finally {
    await provider.close();
  }
});
