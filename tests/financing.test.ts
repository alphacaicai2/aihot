// Exercise the new category through analysis, publication, real HTTP routes and daily composition.
// The provider is a loopback stub: these checks validate the pipeline, not a live model's accuracy.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle } from "@aihot/backend/editorial/analyze";
import { runFinancingBatch } from "@aihot/backend/editorial/financing-sweep";
import { publishArticle } from "@aihot/backend/publication/publish";
import { composeDaily } from "@aihot/backend/reports/compose";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const SOURCE = `test-financing-${T}`;
const weeklyTitle = "“阿尔法狗”之父的AI制药公司获50亿美元投资，刷新全球AI制药单笔融资纪录；镁伽科技完成近2亿美元E轮融资丨全球投融资周报";
const drugDeal = "Isomorphic Labs获50亿美元投资。";
const robotDeal = "镁伽科技完成近2亿美元E轮融资。";
const cases = [
  { marker: "WEEKLY", title: weeklyTitle, category: "financing", type: "industry_event", tag: "投融资", score: 40 },
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
  else if (system.includes("Extract each distinct current financing transaction")) {
    const material: Array<{ id: number; text: string }> = JSON.parse(messages.at(-1).content);
    content = { results: material.map(m => ({ id: m.id, claims: m.text.includes("WEEKLY") ? [
      { company: "Isomorphic Labs", amountText: "50亿美元", status: "announced", currency: "USD", kind: "company_round",
        amountBasis: "round", evidence: drugDeal, passage: drugDeal },
      { company: "镁伽科技", amountText: "近2亿美元", round: "E轮", status: "closed", currency: "USD", kind: "company_round",
        amountBasis: "round", evidence: robotDeal, passage: robotDeal + "本轮由甲基金领投。", investors: [{name:"甲基金",quote:"本轮由甲基金领投。"}] }
    ] : m.text.includes("Andreessen Horowitz 领投本轮") ? [{
      company: "某AI公司", kind: "company_round", status: "announced", amountBasis: "round",
      passage: "某AI公司完成一亿美元B轮融资。Andreessen Horowitz 领投本轮。",
      evidence: "某AI公司完成一亿美元B轮融资", investors: [{name:"Andreessen Horowitz",quote:"Andreessen Horowitz 领投本轮"}],
    }] : [] })) };
  } else {
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
      bodyText: `${c.title}。${c.marker === "ROUND" ? "Andreessen Horowitz 领投本轮。" : c.marker === "WEEKLY" ? robotDeal + "本轮由甲基金领投。" : ""}${c.marker} ${T} ${"这篇新闻介绍AI业务的最新进展。".repeat(35)}`,
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

test("a newly published financing report becomes searchable after the worker tick and stays idempotent", async () => {
  const [old] = await sql`INSERT INTO financing_extraction_batches (material,finished_at) VALUES ('[]',now()) RETURNING id`;
  await sql`UPDATE analyses SET output=output || jsonb_build_object('financingBatch',${old!.id}::bigint,
    'financingReview','{"reason":"no_single_transaction"}'::jsonb)
    WHERE id=(SELECT analysis_id FROM publications WHERE article_id=${ids.get("WEEKLY")!})`;
  // A weekly report can live in the industry feed and identify a recipient only in a source figure.
  await sql`UPDATE publications SET category='industry' WHERE article_id=${ids.get("WEEKLY")!}`;
  await sql`UPDATE analyses SET output=output || jsonb_build_object('financingSourceFigures',${sql.json([{text:drugDeal}])}::jsonb)
    WHERE id=(SELECT analysis_id FROM publications WHERE article_id=${ids.get("WEEKLY")!})`;
  const unprocessed = await app.inject({ method:"GET", url:"/api/v1/financing" });
  assert.deepEqual(unprocessed.json().events, []);
  assert.equal(await runFinancingBatch(), "completed");
  assert.equal(await runFinancingBatch(), "completed");
  const result = await app.inject({method: "GET", url: "/api/v1/financing?investor=" + encodeURIComponent("Andreessen")});
  assert.equal(result.statusCode, 200);
  const reports = result.json().events.flatMap((e: { reports: Array<{id:string}> }) => e.reports);
  assert.ok(reports.some((r: {id:string}) => r.id === ids.get("ROUND")));
  const options = await app.inject({method:"GET", url:"/api/site/financing/investors"});
  assert.equal(options.statusCode, 200);
  assert.ok(options.json().some((o: {name:string; aliases:string[]}) => o.name === "a16z" && o.aliases.includes("Andreessen Horowitz")));
  for (const investor of ["a16z", "安德里森·霍洛维茨"]) {
    const exact = await app.inject({method:"GET", url:"/api/v1/financing?investorMode=exact&investor="+encodeURIComponent(investor)});
    assert.equal(exact.statusCode,200);
    assert.ok(exact.body.includes(ids.get("ROUND")!));
  }
  const incomplete = await app.inject({method:"GET", url:"/api/v1/financing?investor=Andreessen&investorMode=exact"});
  assert.deepEqual(incomplete.json().events, []);
  const before = provider.hits();
  assert.equal(await runFinancingBatch(), "idle");
  const fromFigure = await app.inject({method:"GET",url:"/api/v1/financing?company=Isomorphic"});
  assert.equal(fromFigure.json().events[0].reports[0].claim.amountText, "50亿美元");
  await sql`UPDATE publications SET category='financing' WHERE article_id=${ids.get("WEEKLY")!}`;
  assert.equal(provider.hits(), before);
});

test("roundup deals paginate independently and company, investor and CSV filters stay on the transaction", async () => {
  const financing = async (query: string) => {
    const result = await app.inject({method:"GET", url:"/api/v1/financing?" + query});
    assert.equal(result.statusCode, 200);
    return result;
  };
  const events = (await financing("")).json().events;
  const roundup = events.filter((e: { reports: Array<{id:string}> }) => e.reports[0].id === ids.get("WEEKLY"));
  assert.equal(roundup.length, 2);
  assert.equal(new Set(roundup.map((e: {id:string}) => e.id)).size, 2);
  const pageIds: string[] = [];
  let cursor = "";
  do {
    const page = (await financing("limit=1" + (cursor ? "&cursor=" + cursor : ""))).json();
    pageIds.push(page.events[0].id);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(pageIds.length, 3);
  assert.equal(new Set(pageIds).size, 3);
  const company = new URLSearchParams({company:"镁伽"}).toString();
  const [event] = (await financing(company)).json().events;
  assert.equal(event.reports[0].claim.amountText,"近2亿美元");
  assert.equal(event.reports[0].claim.round,"E轮");
  assert.equal(event.reports[0].title,weeklyTitle);
  const csv = (await financing(company + "&format=csv")).body;
  assert.equal(csv.split("\r\n").length, 2);
  assert.match(csv,/镁伽科技/);
  assert.doesNotMatch(csv,/50亿美元/);
  assert.deepEqual((await financing(new URLSearchParams({company:"Isomorphic",investor:"甲基金"}).toString())).json().events, []);
  assert.equal((await financing(new URLSearchParams({investor:"甲基金",investorMode:"exact"}).toString())).json().events.length, 1);
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
