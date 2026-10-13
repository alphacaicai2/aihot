import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { modelsOverview } from "@aihot/backend/admin/models";

after(closeDb);
const usage = { prompt_tokens: 1000000, prompt_cache_hit_tokens: 500000, completion_tokens: 1000000 };
const estimate = async (u: unknown, at: string) => {
  const [r] = await sql`SELECT estimate_deepseek_v41_flash_cny(${sql.json(u as never)}, ${at}::timestamptz) AS amount`;
  return r!.amount;
};

test("official estimates apply cache rates, peak boundaries, weekends and Chinese holidays", async () => {
  for (const [at, price] of [
    ["2026-10-09T00:59:59Z", 4.51], ["2026-10-09T01:00:00Z", 9.02],
    ["2026-10-09T03:59:59Z", 9.02], ["2026-10-09T04:00:00Z", 4.51],
    ["2026-10-09T06:00:00Z", 9.02], ["2026-10-09T10:00:00Z", 4.51],
    ["2026-10-10T02:00:00Z", 4.51], ["2026-10-07T02:00:00Z", 4.51],
    ["2026-09-25T02:00:00Z", 4.51],
  ] as const) assert.equal(await estimate(usage, at), price, at);
  assert.equal(await estimate({ prompt_tokens: 1000000, completion_tokens: 1000000 }, "2026-10-09T02:00:00Z"), 10);
  assert.equal(await estimate({ prompt_tokens: 1000000, prompt_tokens_details: { cached_tokens: 1000000 }, completion_tokens: 0 }, "2026-10-09T02:00:00Z"), 0.04);
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
  assert.equal(row.estimate!.amount, 13.53);
  assert.equal(row.estimate!.currency, "CNY");
  assert.match(row.estimate!.note, /官方估算/);
  const [stored] = await sql`SELECT cost, cost_basis FROM receipts WHERE id = ${r!.id}`;
  assert.equal(stored!.cost, null);
  assert.equal(stored!.cost_basis, null);
});


test("official totals separate channels, include all purposes, and expose missing usage within Beijing calendar days", async () => {
  const bjDay = Math.floor((Date.now() + 8 * 3600_000) / 86400_000) * 86400_000 - 8 * 3600_000;
  const beforeToday = await modelsOverview(7, "today");
  const beforeYesterday = await modelsOverview(7, "yesterday");
  const version = tag();
  for (const [service, started, u, origin] of [
    ["deepseek", bjDay - 1, usage, "live"],
    ["deepseek", bjDay, usage, "live"],
    ["deepseek", bjDay, null, "live"],
    ["llm", bjDay, usage, "live"],
    ["deepseek", bjDay, usage, "replay"],
    ["deepseek", bjDay - 86400_001, usage, "live"],
  ] as const) {
    const [r] = await sql`INSERT INTO receipts (logical_key, service, model, purpose, status, request, origin)
      VALUES (${tag()}, ${service}, 'deepseek-flash', 'cost.unlisted.test', 'received', ${sql.json({promptVersion: version})}, ${origin}) RETURNING id`;
    await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, model, status, usage, started_at, origin)
      VALUES (${r!.id}, 1, ${service}, 'deepseek-flash', 'received', ${u ? sql.json(u) : null}, ${new Date(started)}, ${origin})`;
  }
  const today = await modelsOverview(7, "today");
  const yesterday = await modelsOverview(7, "yesterday");
  assert.equal(today.since.getTime(), bjDay);
  assert.equal(yesterday.since.getTime(), bjDay - 86400_000);
  assert.equal(yesterday.until.getTime(), bjDay);
  assert.equal(today.deepseek.calls - beforeToday.deepseek.calls, 2);
  assert.equal(today.deepseek.estimatedCalls - beforeToday.deepseek.estimatedCalls, 1);
  assert.ok(Math.abs(today.deepseek.amount! - (beforeToday.deepseek.amount ?? 0) - 4.51) < 1e-10);
  assert.equal(today.deepseek.tokensIn - beforeToday.deepseek.tokensIn, 1000000);
  assert.equal(today.deepseek.tokensOut - beforeToday.deepseek.tokensOut, 1000000);
  assert.equal(yesterday.deepseek.calls - beforeYesterday.deepseek.calls, 1);
  assert.equal(yesterday.deepseek.currency, "CNY");
});

test("migration preserves the USD function for older API versions and publishes the CNY tariff", async () => {
  const [r] = await sql`SELECT estimate_deepseek_v41_flash(${sql.json(usage)}, '2026-10-09T02:00:00Z') AS amount`;
  assert.equal(r!.amount, 1.353);
  const [p] = await sql`SELECT currency, input_per_mtok, cached_per_mtok, output_per_mtok FROM service_prices WHERE service='deepseek' AND model='deepseek-flash'`;
  assert.deepEqual([p!.currency, p!.input_per_mtok, p!.cached_per_mtok, p!.output_per_mtok], ["CNY", 2, 0.04, 8]);
});

test("cost totals keep currencies separate, include billed retries and zero charges, and expose unpriced calls", async () => {
  const before = (await modelsOverview(1, "today")).costs;
  const version = tag();
  const bjDay = Math.floor((Date.now() + 8 * 3600_000) / 86400_000) * 86400_000 - 8 * 3600_000;
  for (const [service, model, currency, cost, u, attempts] of [
    ["llm", "qwen/qwen3.7-flash", "USD", 0.1, null, 2],
    ["llm", "qwen/qwen3.7-flash", "USD", 0, null, 1],
    ["llm", "qwen/qwen3.7-flash", "USD", null, null, 1],
    ["llm", "qwen/qwen3.7-flash", "CNY", 0.5, null, 1],
    ["deepseek", "deepseek-flash", null, null, usage, 1],
    ["llm", "deepseek-v4.1-flash", null, null, usage, 1],
  ] as const) {
    const [r] = await sql`INSERT INTO receipts (logical_key, service, model, purpose, status, request)
      VALUES (${tag()}, ${service}, ${model}, 'cost.total.test', 'received', ${sql.json({promptVersion: version})}) RETURNING id`;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, model, status, usage, cost, cost_basis, currency, started_at)
        VALUES (${r!.id}, ${attempt}, ${service}, ${model}, 'received', ${u ? sql.json(u) : null}, ${cost === null ? null : cost * attempt}, ${cost === null ? null : "actual"}, ${currency}, ${new Date(bjDay)})`;
    }
  }
  const costs = (await modelsOverview(1, "today")).costs;
  for (const [currency, actual, estimated] of [["USD", 0.3, 0], ["CNY", 0.5, 4.51]] as const) {
    const old = before.currencies.find((c) => c.currency === currency);
    const current = costs.currencies.find((c) => c.currency === currency)!;
    assert.ok(Math.abs(current.actual - (old?.actual ?? 0) - actual) < 1e-10);
    assert.ok(Math.abs(current.estimated - (old?.estimated ?? 0) - estimated) < 1e-10);
    assert.ok(Math.abs(current.amount - current.actual - current.estimated) < 1e-10);
  }
  assert.equal(costs.unpricedCalls - before.unpricedCalls, 2);
});
