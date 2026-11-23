import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { modelsOverview, switchModel } from "@aihot/backend/admin/models";
import { modelFor, modelSources } from "@aihot/backend/editorial/models";

after(closeDb);

test("融资模型默认跟随结构抽取，可以独立选择并恢复沿用", async () => {
  const reason = "融资路由回归测试";
  const actor = "test";
  try {
    await switchModel("structure", "deepseek-flash", reason, actor);
    assert.deepEqual((await modelSources()).financing, { model: "deepseek-flash", source: "inherited" });
    assert.equal(await modelFor("financing"), "deepseek-flash");

    await switchModel("financing", "openrouter-qwen3.7-flash", reason, actor);
    assert.equal(await modelFor("structure"), "deepseek-flash");
    await switchModel("structure", "glm-5.3-flash", reason, actor);
    assert.deepEqual((await modelSources()).financing, { model: "openrouter-qwen3.7-flash", source: "admin" });
    assert.equal(await modelFor("financing"), "openrouter-qwen3.7-flash");

    await switchModel("financing", null, reason, actor);
    assert.deepEqual((await modelSources()).financing, { model: "glm-5.3-flash", source: "inherited" });
    assert.equal(await modelFor("financing"), await modelFor("structure"));
  } finally {
    await switchModel("financing", null, reason, actor);
    await switchModel("structure", null, reason, actor);
  }
});

test("历史融资调用按实际通道单列，结构抽取不会重复计数", async () => {
  const version = tag();
  const [receipt] = await sql`INSERT INTO receipts(logical_key, service, model, purpose, status, request)
    VALUES (${tag()}, 'deepseek', 'deepseek-flash', 'financing_extract', 'completed', ${sql.json({ promptVersion: version })})
    RETURNING id`;
  await sql`INSERT INTO receipt_attempts(receipt_id, attempt, service, model, status, started_at)
    VALUES (${receipt.id}, 1, 'deepseek', 'deepseek-flash', 'received', now() - interval '1 hour')`;
  const { capabilities } = await modelsOverview(7);
  const owners = capabilities.filter(c => c.usage.some(u => u.promptVersion === version));
  assert.deepEqual(owners.map(c => c.key), ["financing"]);
  const row = owners[0].usage.find(u => u.promptVersion === version)!;
  assert.deepEqual([row.service, row.model, row.calls], ["deepseek", "deepseek-flash", 1]);
});
