import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { closeDb, sql } from "@aihot/backend/db";
import { chatJson, ModelOutputError } from "@aihot/backend/providers/llm";
import { modelsOverview } from "@aihot/backend/admin/models";

let amount: unknown = 0.0000247255;
let content = '{"label":"PASS","reason":"测试"}';
const provider = await stub(() => ({
  id: `stub-${tag()}`, choices: [{ message: { content } }],
  usage: { prompt_tokens: 100, completion_tokens: 10, cost: amount },
}));
Object.assign(process.env, { MODEL_CALLS_ENABLED: "true", OPENROUTER_BASE_URL: `${provider.url}/v1`, OPENROUTER_API_KEY: "test-key" });
const subject = `openrouter-cost-${tag()}`;
const ask = (name: string) => chatJson({
  model: "openrouter-qwen3.7-flash", purpose: "prefilter_article", subject: name, promptVersion: "test",
  system: "Return JSON", user: name, schema: z.object({ label: z.enum(["PASS", "BLOCK", "UNKNOWN"]), reason: z.string() }),
});
after(async () => { await provider.close(); await closeDb(); });

test("OpenRouter account charges retain precision and are summed per attempt, including billed retries", async () => {
  const before = (await modelsOverview(1)).capabilities.find((c) => c.key === "prefilter")!.usage
    .find((u) => u.model === "qwen/qwen3.7-flash" && u.promptVersion === "test")?.actualCost ?? 0;
  content = "unusable answer";
  await assert.rejects(ask(subject), ModelOutputError);
  content = '{"label":"PASS","reason":"测试"}';
  amount = 0.0000301234;
  const result = await ask(subject);
  const reused = await ask(subject);
  assert.equal(reused.reused, true);
  assert.equal(provider.hits(), 2, "reusing a receipt must not create another charge");
  const [receipt] = await sql`SELECT cost, currency, cost_basis FROM receipts WHERE id = ${result.receiptId}`;
  assert.equal(receipt!.cost, 0.0000301234);
  assert.equal(receipt!.currency, "USD");
  assert.equal(receipt!.cost_basis, "actual");
  const attempts = await sql`SELECT cost, currency, cost_basis FROM receipt_attempts WHERE receipt_id = ${result.receiptId} ORDER BY attempt`;
  assert.deepEqual(attempts.map((a) => a.cost), [0.0000247255, 0.0000301234]);
  assert.ok(attempts.every((a) => a.currency === "USD" && a.cost_basis === "actual"));
  const usage = (await modelsOverview(1)).capabilities.find((c) => c.key === "prefilter")!.usage
    .find((u) => u.model === "qwen/qwen3.7-flash" && u.promptVersion === "test")!;
  assert.ok(Math.abs(usage.actualCost! - before - 0.0000548489) < 1e-12);
  assert.equal(usage.currency, "USD");
});

test("zero is an actual charge; missing or invalid cost remains unknown", async () => {
  for (const value of [0, null, undefined, "0.1", -1]) {
    amount = value;
    const result = await ask(`${subject}-${String(value)}`);
    const [receipt] = await sql`SELECT cost, cost_basis FROM receipts WHERE id = ${result.receiptId}`;
    assert.equal(receipt!.cost, value === 0 ? 0 : null);
    assert.equal(receipt!.cost_basis, value === 0 ? "actual" : null);
  }
});

test("historical backfill uses saved OpenRouter charges once and preserves other billing data", async () => {
  const cases = [
    { model: "qwen/qwen3.7-flash", usage: { cost: 0.0000257715 }, cost: null, expected: 0.0000257715 },
    { model: "qwen/qwen3.7-flash", usage: { cost: 0 }, cost: null, expected: 0 },
    { model: "qwen/qwen3.7-flash", usage: { cost: "invalid" }, cost: null, expected: null },
    { model: "qwen/qwen3.7-flash", usage: { cost: 0.1 }, cost: 0.2, expected: 0.2 },
    { model: "another-provider", usage: { cost: 0.1 }, cost: null, expected: null },
  ];
  const ids: number[] = [];
  for (const c of cases) {
    const [r] = await sql<{ id: number }[]>`
      INSERT INTO receipts (logical_key, service, model, purpose, status, request, usage, cost, currency, cost_basis, attempts)
      VALUES (${tag()}, 'llm', ${c.model}, 'cost.backfill.test', 'received', '{}', ${sql.json(c.usage)}, ${c.cost},
              ${c.cost === null ? null : "CNY"}, ${c.cost === null ? null : "actual"}, 1) RETURNING id`;
    ids.push(r!.id);
    await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, model, status, usage, cost, currency, cost_basis)
              VALUES (${r!.id}, 1, 'llm', ${c.model}, 'received', ${sql.json(c.usage)}, ${c.cost},
                      ${c.cost === null ? null : "CNY"}, ${c.cost === null ? null : "actual"})`;
  }
  const migration = readFileSync(new URL("../database/migrations/0039_openrouter_actual_cost.sql", import.meta.url), "utf8");
  for (let run = 0; run < 2; run++) {
    await sql.begin((tx) => tx.unsafe(migration));
    for (let i = 0; i < cases.length; i++) {
      const [r] = await sql`SELECT cost, currency FROM receipts WHERE id = ${ids[i]!}`;
      const [a] = await sql`SELECT cost, currency FROM receipt_attempts WHERE receipt_id = ${ids[i]!}`;
      assert.equal(r!.cost, cases[i]!.expected);
      assert.equal(a!.cost, cases[i]!.expected);
      assert.equal(r!.currency, i === 3 ? "CNY" : cases[i]!.expected === null ? null : "USD");
      assert.equal(a!.currency, r!.currency);
    }
  }
});
