import { stub, tag, Reply } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle, loadAnalyzeInput, runAnalysis } from "@aihot/backend/editorial/analyze";
import { modelFor, modelSources } from "@aihot/backend/editorial/models";
import { modelsOverview, switchModel } from "@aihot/backend/admin/models";
import { ProviderRejectedError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const SOURCE = `test-dual-score-${T}`;
const requests: Array<{ model: string; messages: unknown; max_tokens: number; reasoning?: unknown }> = [];
let qwenFails = false;
const response = (data: unknown) => ({ choices: [{ message: { content: JSON.stringify(data) } }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 } });
const otherStep = (system: string) => system.includes("宽召回") ? { label: "PASS", reason: "测试" }
  : system.includes("资料结构化助手") ? { category: "ai-products", tags: ["产品更新"], subjects: [], fact: null }
  : { itemType: "product_launch", authorRole: "principal", tags: ["产品更新"], editorialJudgment: "理由", titleZh: "模型发布", summaryZh: "模型发布了。给出了价格。" };
const official = await stub((_hit, req) => {
  const body = JSON.parse(req.body);
  if (!body.messages[0].content.includes("事件注意力评分器")) return response(otherStep(body.messages[0].content));
  requests.push(body);
  return response({ attentionScore: 58 });
});
const openrouter = await stub((_hit, req) => {
  requests.push(JSON.parse(req.body));
  return qwenFails ? new Reply(503, { error: "test outage" }) : response({ attentionScore: 62 });
});
const writer = await stub((_hit, req) => {
  const system = JSON.parse(req.body).messages[0].content as string;
  return response(system.includes("事件注意力评分器") ? { attentionScore: 80 } : otherStep(system));
});
Object.assign(process.env, {
  LLM_BASE_URL: writer.url, LLM_API_KEY: "test-key", LLM_MODEL: "one-model",
  PREFILTER_MODEL: "default", UNDERSTAND_MODEL: "default", STRUCTURE_MODEL: "default",
  SCORE_MODEL: "deepseek-flash", SCORE_SECOND_MODEL: "openrouter-qwen3.7-flash",
  DEEPSEEK_BASE_URL: official.url, DEEPSEEK_API_KEY: "test-key",
  OPENROUTER_BASE_URL: openrouter.url, OPENROUTER_API_KEY: "test-key",
  LLM_FALLBACK_MODEL: "deepseek-flash", LLM_PRIMARY_MODE: "probe",
});

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Dual score', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  await sql`DELETE FROM settings WHERE key IN ('models.score', 'models.scoreSecond')`;
  await Promise.all([official.close(), openrouter.close(), writer.close()]);
  await stopBoss();
  await closeDb();
});
const article = async (suffix: string) => (await upsertMaterial({
  sourceId: SOURCE, url: `https://example.com/${T}/${suffix}`, title: `AI model launch ${T} ${suffix}`,
  bodyText: `A company released an AI model with pricing and availability. ${T} ${suffix} `.repeat(6),
  bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
} as never)).articleId;

test("the second score inherits the first unless its environment or audited admin choice overrides it", async () => {
  delete process.env.SCORE_SECOND_MODEL;
  assert.equal(await modelFor("scoreSecond"), "deepseek-flash");
  assert.equal((await modelSources()).scoreSecond!.source, "inherited");
  process.env.SCORE_SECOND_MODEL = "invalid-model";
  assert.equal(await modelFor("scoreSecond"), "deepseek-flash");
  process.env.SCORE_SECOND_MODEL = "openrouter-qwen3.7-flash";
  await switchModel("scoreSecond", "default", "test independent second slot", "test");
  assert.equal(await modelFor("scoreSecond"), "default");
  assert.equal(await modelFor("score"), "deepseek-flash");
  await switchModel("scoreSecond", null, "test restore environment", "test");
  assert.equal(await modelFor("scoreSecond"), "openrouter-qwen3.7-flash");
});

test("DeepSeek and OpenRouter judge the identical input independently, preserve the threshold and reuse both receipts", async () => {
  const id = await article("mixed");
  const start = requests.length;
  const result = await analyzeArticle(id);
  assert.deepEqual(result!.output!.scores, [58, 62]);
  assert.equal(result!.output!.score, 60);
  assert.equal(result!.output!.threshold, 60);
  assert.equal(result!.output!.selected, true);
  const calls = requests.slice(start);
  assert.deepEqual(calls.map(r => r.model), ["deepseek-flash", "qwen/qwen3.7-flash"]);
  assert.deepEqual(calls[0]!.messages, calls[1]!.messages, "the second judge cannot see the first score");
  assert.deepEqual(calls[1]!.reasoning, { enabled: false });
  assert.deepEqual(calls.map(r => r.max_tokens), [1024, 1024]);
  const [stored] = await sql`SELECT output FROM analyses WHERE id = ${result!.analysisId!}`;
  assert.deepEqual(stored!.output.scoreModels, ["deepseek-flash", "openrouter-qwen3.7-flash"]);
  const overview = await modelsOverview(1);
  const receipts = await sql`SELECT id, model, logical_key, request FROM receipts WHERE subject = ${`article:${id}@1`} AND purpose = 'score_article'`;
  assert.equal(receipts.length, 2);
  for (const [key, model] of [["score", "deepseek-flash"], ["scoreSecond", "qwen/qwen3.7-flash"]] as const) {
    const version = receipts.find(r => r.model === model)!.request.promptVersion;
    assert.ok(overview.capabilities.find(c => c.key === key)!.usage.some(u => u.model === model && u.promptVersion === version));
  }
  const reused = await analyzeArticle(id);
  assert.equal(reused!.reused, true);
  assert.equal(requests.length - start, 2);
});

test("a failed Qwen score is never replaced by DeepSeek under global probe/fallback mode; retry reuses the first score", async () => {
  const id = await article("failure");
  const input = (await loadAnalyzeInput(id))!;
  const deepseekScores = () => requests.filter(r => r.model === "deepseek-flash").length;
  const deepseekBefore = deepseekScores();
  qwenFails = true;
  try {
    await assert.rejects(runAnalysis(input), ProviderRejectedError);
    assert.equal(deepseekScores() - deepseekBefore, 1);
    const [r] = await sql`SELECT id FROM receipts WHERE subject = ${`article:${id}@1`} AND model = 'qwen/qwen3.7-flash'`;
    const routes = await sql`SELECT 1 FROM model_fallback_routes WHERE primary_receipt_id = ${r!.id}`;
    assert.equal(routes.length, 0);
    // An uncertain paid attempt must block a resend, even when the other judge has succeeded.
    await sql`UPDATE receipts SET status = 'unknown' WHERE id = ${r!.id}`;
    const qwenBefore = openrouter.hits();
    await assert.rejects(runAnalysis(input), ReceiptUnknownError);
    assert.equal(openrouter.hits(), qwenBefore);
    await sql`UPDATE receipts SET status = 'failed' WHERE id = ${r!.id}`;
    qwenFails = false;
    const recovered = await runAnalysis(input);
    assert.deepEqual(recovered.scores!.values, [58, 62]);
    assert.equal(deepseekScores() - deepseekBefore, 1);
  } finally { qwenFails = false; }
});

test("an explicit SelectBench model still judges twice without using the production second slot", async () => {
  const input = (await loadAnalyzeInput(await article("benchmark")))!;
  const qwenBefore = openrouter.hits();
  const run = await runAnalysis(input, { stages: "selection", scoreModel: "deepseek-flash" });
  assert.deepEqual(run.scores!.values, [58, 58]);
  assert.deepEqual(run.scores!.models, ["deepseek-flash", "deepseek-flash"]);
  assert.equal(openrouter.hits(), qwenBefore);
});
