// The open-source default: one OpenAI-compatible model (LLM_BASE_URL, LLM_API_KEY, LLM_MODEL) runs every
// step of the analysis, with no per-step configuration.
import { stub, tag, Reply } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle, loadAnalyzeInput, runAnalysis } from "@aihot/backend/editorial/analyze";
import { ProviderRejectedError } from "@aihot/backend/providers/receipts";
import { stopBoss } from "@aihot/backend/jobs/queue";

// Nothing chosen per step: every capability falls back to the `default` model.
for (const name of Object.keys(process.env)) if (/_MODEL$/.test(name) && name !== "LLM_MODEL" && name !== "EMBEDDING_MODEL") delete process.env[name];

const T = tag();
const SOURCE = `test-default-model-${T}`;
const seen: Array<{ model: string; system: string; reasoning?: unknown; response_format?: unknown }> = [];
let failSecondScore = false;
let scores = 0;
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { model: string; messages: Array<{ role: string; content: unknown }>; reasoning?: unknown; response_format?: unknown };
  const system = body.messages[0]!.role === "system" ? String(body.messages[0]!.content) : "";
  const user = String(body.messages.at(-1)!.content);
  seen.push({ model: body.model, system, reasoning: body.reasoning, response_format: body.response_format });
  if (failSecondScore && system.includes("事件注意力评分器") && ++scores === 2) return new Reply(503, { error: "temporary outage" });
  const content =
    system.includes("宽召回") ? { label: "PASS", reason: "测试" }
    : system.includes("事件注意力评分器") ? { attentionScore: 80 }
    : system.includes("内容理解编辑") ? { itemType: "product_launch", authorRole: "principal", tags: ["产品更新"], editorialJudgment: "理由", titleZh: "一个模型的标题", summaryZh: "一个模型写的摘要。第二句。" }
    : system.includes("资料结构化助手") ? { category: "ai-products", tags: ["产品更新"], subjects: [], fact: null }
    : user.includes("title_zh") ? "title_zh: 标题\nsummary_zh: 摘要。"
    : null;
  if (content === null) throw new Error("unexpected request");
  return { id: `stub-${seen.length}`, choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
});
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "test-key", LLM_MODEL: "one-model", MODEL_CALLS_ENABLED: "true" });

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Test default model', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("one model runs the prefilter, both scores, the writing and the structure", async () => {
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/${T}`, title: `A product launch ${T}`, bodyText: `A company launched a product with pricing and availability. ${T} `.repeat(6),
    bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  } as never);
  const res = await analyzeArticle(articleId);
  assert.equal(res!.output!.selected, true);
  assert.equal(res!.output!.titleZh, "一个模型的标题");
  assert.equal(seen.length, 5, "prefilter, two scores, understand, structure");
  assert.ok(seen.every((r) => r.model === "one-model"), "every request names the configured model");
  const services = await sql<{ service: string }[]>`SELECT DISTINCT service FROM receipts WHERE subject LIKE ${`article:${articleId}%`}`;
  assert.deepEqual(services.map((s) => s.service), ["llm"]);
});

test("OpenRouter can run only the prefilter while the other steps keep the default model and budget", async () => {
  const start = seen.length;
  Object.assign(process.env, {
    PREFILTER_MODEL: "openrouter-qwen3.7-flash", OPENROUTER_BASE_URL: `${provider.url}/v1`, OPENROUTER_API_KEY: "test-openrouter-key",
  });
  try {
    const { articleId } = await upsertMaterial({
      sourceId: SOURCE, url: `https://example.com/${T}/openrouter`, title: `Another product launch ${T}`,
      bodyText: `A company launched another AI product with pricing and availability. ${T} `.repeat(6),
      bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
    } as never);
    const res = await analyzeArticle(articleId);
    assert.equal(res!.output!.selected, true);
    const calls = seen.slice(start);
    assert.equal(calls.length, 5);
    const prefilter = calls.filter((r) => r.system.includes("宽召回"));
    assert.equal(prefilter.length, 1);
    assert.equal(prefilter[0]!.model, "qwen/qwen3.7-flash");
    assert.deepEqual(prefilter[0]!.reasoning, { enabled: false });
    assert.deepEqual(prefilter[0]!.response_format, { type: "json_object" });
    assert.ok(calls.filter((r) => !r.system.includes("宽召回")).every((r) => r.model === "one-model"));
    const receipts = await sql<{ service: string; model: string }[]>`SELECT service, model FROM receipts WHERE subject LIKE ${`article:${articleId}%`}`;
    assert.ok(receipts.every((r) => r.service === "llm"));
    assert.equal(receipts.filter((r) => r.model === "qwen/qwen3.7-flash").length, 1);
  } finally {
    delete process.env.PREFILTER_MODEL;
    delete process.env.OPENROUTER_BASE_URL;
    delete process.env.OPENROUTER_API_KEY;
  }
});

test("only the failed score uses fallback; complete steps are reused and benchmarks keep their chosen model", async () => {
  const official = await stub(() => ({ choices: [{ message: { content: '{"attentionScore":82}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  Object.assign(process.env, { LLM_FALLBACK_MODEL: 'deepseek-flash', DEEPSEEK_BASE_URL: official.url, DEEPSEEK_API_KEY: 'test-key' });
  const create = async (suffix: string) => (await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/${T}/${suffix}`, title: `AI product ${suffix} ${T}`,
    bodyText: `A company launched an AI product with pricing. ${suffix} ${T} `.repeat(8), bodyStatus: 'ok', via: 'fetch', publishedAt: new Date(),
  } as never)).articleId;
  try {
    failSecondScore = true;
    scores = 0;
    const start = seen.length;
    const id = await create('fallback');
    const first = await analyzeArticle(id);
    assert.equal(first!.output!.score, 81);
    assert.equal(first!.output!.scoreModel, 'default+deepseek-flash');
    assert.equal(first!.output!.selected, true);
    assert.equal(seen.length - start, 5);
    assert.equal(official.hits(), 1);
    const recovered = await analyzeArticle(id);
    assert.equal(recovered!.reused, true);
    assert.equal(seen.length - start, 5, 'prefilter, the first score, structure and writing are all reused');
    assert.equal(official.hits(), 1, 'the failed score reuses its fallback receipt');
    scores = 0;
    const benchmark = await loadAnalyzeInput(await create('benchmark'));
    await assert.rejects(runAnalysis(benchmark!, { stages: 'selection' }), ProviderRejectedError);
    assert.equal(official.hits(), 1, 'SelectBench must not substitute another model');
  } finally {
    failSecondScore = false;
    for (const name of ['LLM_FALLBACK_MODEL', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_API_KEY']) delete process.env[name];
    await official.close();
  }
});
