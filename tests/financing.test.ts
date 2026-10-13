// Exercise the new category through analysis, publication, real HTTP routes and daily composition.
// The provider is a loopback stub: these checks validate the pipeline, not a live model's accuracy.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle } from "@aihot/backend/editorial/analyze";
import { publishArticle } from "@aihot/backend/publication/publish";
import { composeDaily } from "@aihot/backend/reports/compose";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const SOURCE = `test-financing-${T}`;
const cases = [
  { marker: "ROUND", title: "某AI公司完成一亿美元B轮融资", category: "financing", type: "industry_event", tag: "投融资", score: 80 },
  { marker: "INVESTMENT", title: "某基金领投一家AI机器人公司", category: "financing", type: "industry_event", tag: "投融资", score: 80 },
  { marker: "FUND", title: "某AI基金完成募资，终关规模五亿美元", category: "financing", type: "industry_event", tag: "投融资", score: 80 },
  { marker: "SMALL", title: "某AI公司获得小额种子轮融资", category: "financing", type: "industry_event", tag: "投融资", score: 40 },
  { marker: "BACKGROUND", title: "曾获融资的AI公司发布新产品", category: "ai-products", type: "product_launch", tag: "产品更新", score: 80 },
  { marker: "VIEWPOINT", title: "投资人讨论AI投资趋势", category: "opinion", type: "opinion_analysis", tag: "大佬观点", score: 80 },
];
const ids = new Map<string, string>();
const provider = await stub((_hit, req) => {
  const { messages } = JSON.parse(req.body);
  const system = String(messages[0].content);
  const user = JSON.stringify(messages.at(-1).content);
  const c = cases.find((c) => new RegExp(`\\b${c.marker}\\b`).test(user));
  let content: unknown;
  if (system.includes("日报主编")) content = { title: "投融资日报", leadParagraph: "公司融资与基金募资。", highlights: [1] };
  else {
    assert.ok(c, "known fixture reaches the provider");
    if (system.includes("宽召回的AI相关性预筛")) content = { label: "PASS", reason: "AI经营活动" };
    else if (system.includes("事件注意力评分器")) content = { attentionScore: c.score };
    else if (system.includes("资料结构化助手")) {
      assert.ok(system.includes("financing（融资）") && system.includes("基金募资"));
      content = { category: c.category, tags: [c.tag], subjects: [], fact: null };
    } else if (system.includes("内容理解编辑")) {
      assert.ok(system.includes("“投融资”"));
      content = { itemType: c.type, authorRole: "principal", tags: [c.tag], editorialJudgment: "原文披露了事件的具体进展。", titleZh: c.title, summaryZh: c.title };
    } else content = `title_zh: ${c.title}\nsummary_zh: ${c.title}`;
  }
  return { model: "stub", choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
});
for (const name of ["DASHSCOPE_BASE_URL", "ZHIPU_BASE_URL", "DEEPSEEK_BASE_URL"]) process.env[name] = `${provider.url}/v1`;
for (const name of ["DASHSCOPE_API_KEY", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY"]) process.env[name] = "test-key";
const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, first_party, next_fetch_at)
            VALUES (${SOURCE}, 'Test financing', 'rss', 'T1', 'editorial', true, '2100-01-01')`;
});
after(async () => {
  await sql`DELETE FROM reports WHERE kind = 'daily' AND key = '2031-02-03'`;
  await app.close();
  await provider.close();
  await stopBoss();
  await sql`DELETE FROM articles WHERE source_id = ${SOURCE}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await closeDb();
});

test("financing survives analysis and publication without automatically selecting every financing item", async () => {
  for (const c of cases) {
    const { articleId } = await upsertMaterial({
      sourceId: SOURCE, url: `https://example.com/${T}/${c.marker}`, title: `${c.title} ${c.marker} ${T}`,
      bodyText: `${c.title}。${c.marker} ${T} ${"这篇新闻介绍AI业务的最新进展。".repeat(35)}`,
      bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
    });
    ids.set(c.marker, articleId);
    await analyzeArticle(articleId);
    await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
    const [p] = await sql<{ category: string; tags: string[]; selected: boolean }[]>`
      SELECT category, tags, selected FROM publications WHERE article_id = ${articleId}`;
    assert.equal(p!.category, c.category, c.marker);
    assert.ok(p!.tags.includes(c.tag), c.marker);
    assert.equal(p!.selected, c.score >= 60, c.marker);
  }
});

test("site, public API and RSS filter financing while excluding product background and opinions", async () => {
  for (const url of ["/api/site/pool?category=financing", "/api/v1/items?mode=all&category=financing", "/feed/category/financing.xml"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 200, url);
    for (const c of cases) {
      const expected = c.category === "financing" && (c.score >= 60 || !url.startsWith("/feed/"));
      assert.equal(res.body.includes(ids.get(c.marker)!), expected, `${url}: ${c.marker}`);
    }
  }
  const industry = await app.inject({ method: "GET", url: "/api/site/pool?category=industry" });
  assert.equal(industry.body.includes(ids.get("ROUND")!), false);
});

test("daily reports put financing in its own section", async () => {
  const selected = cases.filter((c) => c.category === "financing" && c.score >= 60).map((c) => ids.get(c.marker)!);
  await sql`UPDATE publications SET timeline_at = '2031-02-02T02:00:00Z', visible_after = '2031-02-02T02:00:00Z' WHERE article_id IN ${sql(selected)}`;
  await composeDaily("2031-02-03");
  const [report] = await sql<{ content: { sections: Array<{ label: string; items: Array<{ itemId: string }> }> } }[]>`
    SELECT content FROM reports WHERE kind = 'daily' AND key = '2031-02-03'`;
  const section = report!.content.sections.find((s) => s.label === "投融资动态");
  assert.ok(section);
  assert.deepEqual(new Set(section.items.filter((i) => selected.includes(i.itemId)).map((i) => i.itemId)), new Set(selected));
  assert.equal(report!.content.sections.some((s) => s.label !== "投融资动态" && s.items.some((i) => selected.includes(i.itemId))), false);
});
