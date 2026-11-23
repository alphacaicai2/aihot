import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { backfillModelUsageBatch, modelUsage } from "@aihot/backend/admin/model-usage";

after(closeDb);

test("the usage projection matches live receipts before backfill and after late corrections and retries", async () => {
  const old = new Date("2025-03-01T02:00:00Z");
  const today = new Date("2025-06-01T16:00:00Z"); // Beijing midnight
  const tomorrow = new Date(+today + 86400000);
  const yesterday = new Date(+today - 86400000);
  const prompt = tag();
  const key = tag() + ":score-2";
  const [receipt] = await sql`INSERT INTO receipts (logical_key,service,model,purpose,status,created_at,request)
    VALUES (${key},'first-channel','original','score_article','received',${old},${sql.json({ promptVersion: prompt })}) RETURNING id`;
  const id = receipt!.id;
  try {
    const [attempt] = await sql`INSERT INTO receipt_attempts (receipt_id,attempt,service,model,status,started_at,latency_ms)
      VALUES (${id},1,'deepseek','deepseek-flash','unknown',${new Date(+today - 1)},40) RETURNING id`;
    // An old receipt is retried on another actual channel at exactly Beijing midnight.
    await sql`INSERT INTO receipt_attempts (receipt_id,attempt,service,model,status,started_at,latency_ms,cost,cost_basis,currency)
      VALUES (${id},2,'retry-channel','retry-model','received',${today},52,0.50,'actual','USD')`;
    await sql`UPDATE model_usage_backfill SET complete=false,last_id=NULL`;
    // Represent historical records that predate the migration.
    await sql`DELETE FROM model_usage_receipts WHERE id=${id}`;
    await sql`DELETE FROM model_usage_attempts WHERE receipt_id=${id}`;
    const rows = async (from: Date, until: Date, split = true) =>
      (await modelUsage(sql, from, until, split)).filter(row => row.prompt_version === prompt);
    const liveYesterday = await rows(yesterday, today);
    const liveToday = await rows(today, tomorrow);
    assert.equal(liveYesterday[0]?.unknown, 1);
    assert.equal(liveToday[0]?.service, "retry-channel");
    assert.equal(liveToday[0]?.actual_cost, 0.5);
    assert.equal(liveToday[0]?.score_slot, 2);
    while (await backfillModelUsageBatch()) { /* complete both sources */ }
    assert.deepEqual(await rows(yesterday, today), liveYesterday);
    assert.deepEqual(await rows(today, tomorrow), liveToday);
    assert.equal((await rows(today, tomorrow, false))[0]?.score_slot, null);
    await sql`UPDATE receipt_attempts SET status='received',latency_ms=75,
      usage=${sql.json({ prompt_tokens: 300, completion_tokens: 40, prompt_cache_hit_tokens: 100 })} WHERE id=${attempt!.id}`;
    const [corrected] = await rows(yesterday, today);
    assert.equal(corrected?.ok, 1);
    assert.equal(corrected?.unknown, 0);
    assert.equal(corrected?.p95, 75);
    assert.equal(corrected?.tokens_in, 300);
    assert.equal(corrected?.estimated_calls, 1);
    assert.ok(Number(corrected?.official_estimate) > 0);
    await sql`UPDATE receipts SET logical_key=${tag()} WHERE id=${id}`;
    assert.equal((await rows(yesterday, tomorrow))[0]?.score_slot, 1);
    await sql`UPDATE receipt_attempts SET origin='replay' WHERE id=${attempt!.id}`;
    assert.deepEqual(await rows(yesterday, today), []);
    await sql`UPDATE receipts SET request='{}' WHERE id=${id}`;
    assert.deepEqual(await rows(yesterday, tomorrow), []);
  } finally {
    await sql`DELETE FROM receipts WHERE id=${id}`;
    assert.equal((await sql`SELECT 1 FROM model_usage_attempts WHERE receipt_id=${id}`).length, 0);
    assert.equal((await sql`SELECT 1 FROM model_usage_receipts WHERE id=${id}`).length, 0);
  }
});

test("an attempt removed while its initial batch is running cannot reappear in usage", async () => {
  const [r] = await sql`INSERT INTO receipts (logical_key,purpose,service,status) VALUES (${tag()} ,'usage-race','ci','received') RETURNING id`;
  let removal: Promise<unknown> | undefined;
  try {
    const [a] = await sql`INSERT INTO receipt_attempts (receipt_id,attempt,service,model,status)
      VALUES (${r!.id},1,'ci','model','received') RETURNING id`;
    await sql`UPDATE model_usage_backfill SET complete=false WHERE source='attempts'`;
    await sql`DELETE FROM model_usage_attempts WHERE id=${a!.id}`;
    await sql.begin(async copying => {
      await copying`SELECT 1 FROM model_usage_backfill WHERE source='attempts' FOR UPDATE`;
      let reportPid!: (pid: number) => void;
      const started = new Promise<number>(resolve => { reportPid = resolve; });
      removal = sql.begin(async writer => {
        const [conn] = await writer`SELECT pg_backend_pid() AS pid`;
        reportPid(conn!.pid);
        await writer`UPDATE receipt_attempts SET origin='replay' WHERE id=${a!.id}`;
      });
      const writerPid = await started;
      // Confirm the writer has reached the progress lock before copying its previous snapshot.
      const stop = Date.now() + 3000;
      for (;;) {
        const [wait] = await copying`SELECT cardinality(pg_blocking_pids(${writerPid})) AS blockers`;
        if (wait!.blockers) break;
        assert.ok(Date.now() < stop, "live removal did not wait for the overlapping batch");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await copying`INSERT INTO model_usage_attempts SELECT * FROM model_usage_attempt_source()
        WHERE id=${a!.id} ON CONFLICT DO NOTHING`;
    });
    await removal;
    assert.equal((await sql`SELECT 1 FROM model_usage_attempts WHERE id=${a!.id}`).length, 0);
  } finally {
    await removal;
    await sql`DELETE FROM receipts WHERE id=${r!.id}`;
    while (await backfillModelUsageBatch()) { /* finish the interrupted batch */ }
  }
});
