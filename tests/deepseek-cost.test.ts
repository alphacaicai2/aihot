import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { modelsOverview } from "@aihot/backend/admin/models";

after(closeDb);
const usage = { prompt_tokens: 1000000, prompt_cache_hit_tokens: 500000, completion_tokens: 1000000 };
const estimate = async (u: unknown, at: string) => {
  const [r] = await sql`SELECT estimate_deepseek_v41_flash(${sql.json(u as never)}, ${at}::timestamptz) AS amount`;
  return r!.amount;
};

test("official estimates apply cache rates, peak boundaries, weekends and Chinese holidays", async () => {
  for (const [at, price] of [
    ["2026-10-09T00:59:59Z", 0.6765], ["2026-10-09T01:00:00Z", 1.353],
    ["2026-10-09T03:59:59Z", 1.353], ["2026-10-09T04:00:00Z", 0.6765],
    ["2026-10-09T06:00:00Z", 1.353], ["2026-10-09T10:00:00Z", 0.6765],
    ["2026-10-10T02:00:00Z", 0.6765], ["2026-10-07T02:00:00Z", 0.6765],
    ["2026-09-25T02:00:00Z", 0.6765],
  ] as const) assert.equal(await estimate(usage, at), price, at);
  assert.equal(await estimate({ prompt_tokens: 1000000, completion_tokens: 1000000 }, "2026-10-09T02:00:00Z"), 1.5);
  assert.equal(await estimate({ prompt_tokens: 1000000, prompt_tokens_details: { cached_tokens: 1000000 }, completion_tokens: 0 }, "2026-10-09T02:00:00Z"), 0.006);
  assert.equal(await estimate({ prompt_tokens: 0, completion_tokens: 0 }, "2026-10-09T02:00:00Z"), 0);
  assert.equal(await estimate({}, "2026-10-09T02:00:00Z"), null);
  assert.equal(await estimate({ prompt_tokens: "invalid", completion_tokens: 100 }, "2026-10-09T02:00:00Z"), null);
});

test("model overview sums every attempt at its request-time tariff without creating actual bills", async () => {
  const version = tag();
  const [r] = await sql`INSERT INTO receipts (logical_key, service, model, purpose, status, request, usage, attempts)
    VALUES (${tag()}, 'llm', 'deepseek-v4.1-flash', 'score_article', 'received', ${sql.json({promptVersion: version})}, ${sql.json(usage)}, 2) RETURNING id`;
  for (const [attempt, started] of [[1, "2026-10-09T02:00:00Z"], [2, "2026-10-10T02:00:00Z"]] as const) {
    await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, model, status, usage, started_at)
      VALUES (${r!.id}, ${attempt}, 'llm', 'deepseek-v4.1-flash', 'received', ${sql.json(usage)}, ${started}::timestamptz)`;
  }
  // Keep the fixed tariff fixtures in view when this test runs after the original 30-day window.
  const days = Math.max(30, Math.ceil((Date.now() - Date.parse("2026-10-09T02:00:00Z")) / 86400_000) + 1);
  const row = (await modelsOverview(days)).capabilities.find(c => c.key === "score")!.usage.find(u => u.promptVersion === version)!;
  assert.equal(row.actualCost, null);
  assert.equal(row.estimate!.amount, 2.0295);
  assert.equal(row.estimate!.currency, "USD");
  assert.match(row.estimate!.note, /官方估算/);
  const [stored] = await sql`SELECT cost, cost_basis FROM receipts WHERE id = ${r!.id}`;
  assert.equal(stored!.cost, null);
  assert.equal(stored!.cost_basis, null);
});
