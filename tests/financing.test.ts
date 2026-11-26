// Exercise the new category through analysis, publication, real HTTP routes and daily composition.
// The provider is a loopback stub: these checks validate the pipeline, not a live model's accuracy.
import { memberClient, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle } from "@aihot/backend/editorial/analyze";
import { runFinancingBatch } from "@aihot/backend/editorial/financing-sweep";
import { refreshFinancingIndex, financingIndexReady } from "@aihot/backend/publication/financing-index";
import { text as streamText } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { exportFinancingCsv, loadFinancing } from "@aihot/backend/publication/financing";
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
let member: Awaited<ReturnType<typeof memberClient>>;
const authedGet = (url: string) => app.inject({ method: "GET", url, headers: member.headers });

before(async () => {
  member = await memberClient();
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, first_party, next_fetch_at)
            VALUES (${SOURCE}, 'Test financing', 'rss', 'T1', 'editorial', true, '2100-01-01')`;
});
after(async () => {
  await member?.close();
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
  const unprocessed = await authedGet("/api/v1/financing");
  assert.deepEqual(unprocessed.json().events, []);
  assert.equal(await runFinancingBatch(), "completed");
  assert.equal(await runFinancingBatch(), "completed");
  const result = await authedGet("/api/v1/financing?investor=" + encodeURIComponent("Andreessen"));
  assert.equal(result.statusCode, 200);
  const reports = result.json().events.flatMap((e: { reports: Array<{id:string}> }) => e.reports);
  assert.ok(reports.some((r: {id:string}) => r.id === ids.get("ROUND")));
  const options = await authedGet("/api/site/financing/investors");
  assert.equal(options.statusCode, 200);
  assert.ok(options.json().some((o: {name:string; aliases:string[]}) => o.name === "a16z" && o.aliases.includes("Andreessen Horowitz")));
  for (const investor of ["a16z", "安德里森·霍洛维茨"]) {
    const exact = await authedGet("/api/v1/financing?investorMode=exact&investor=" + encodeURIComponent(investor));
    assert.equal(exact.statusCode,200);
    assert.ok(exact.body.includes(ids.get("ROUND")!));
  }
  const incomplete = await authedGet("/api/v1/financing?investor=Andreessen&investorMode=exact");
  assert.deepEqual(incomplete.json().events, []);
  const before = provider.hits();
  assert.equal(await runFinancingBatch(), "idle");
  const fromFigure = await authedGet("/api/v1/financing?company=Isomorphic");
  assert.equal(fromFigure.json().events[0].reports[0].claim.amountText, "50亿美元");
  await sql`UPDATE publications SET category='financing' WHERE article_id=${ids.get("WEEKLY")!}`;
  assert.equal(provider.hits(), before);
});

test("roundup deals paginate independently and company, investor and CSV filters stay on the transaction", async () => {
  const financing = async (query: string) => {
    const result = await authedGet("/api/v1/financing?" + query);
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

test("shared financing links isolate a single digest transaction and institution histories use exact identities", async () => {
  const investorPath = "/api/site/financing/investor?" + new URLSearchParams({ name:"a16z" });
  const deals = (await authedGet("/api/v1/financing?company=" + encodeURIComponent("镁伽"))).json().events;
  const ref = deals[0].shareId;
  const eventPath = "/api/site/financing/event?" + new URLSearchParams({ id:ref });
  for (const path of [eventPath, investorPath]) assert.equal((await app.inject({method:"GET",url:path})).statusCode,401);
  for (const indexed of [false,true]) {
    if (indexed) await refreshFinancingIndex();
    const detail = await authedGet(eventPath);
    assert.equal(detail.statusCode,200);
    assert.equal(detail.json().reports[0].claim.company,"镁伽科技");
    assert.equal(detail.json().shareId,ref);
    assert.doesNotMatch(detail.body,/"company":"Isomorphic Labs"/);
    const history = await authedGet(investorPath);
    assert.equal(history.json().historySummary.records,1);
    assert.equal(history.json().historySummary.companies,1);
    assert.equal(history.json().events[0].reports[0].id,ids.get("ROUND"));
    const partial = await authedGet("/api/site/financing/investor?name=Andreessen");
    assert.equal(partial.json().events.length,0);
  }
  // Reordering the two claims must keep a previously shared link on its original transaction.
  const article = ids.get("WEEKLY")!;
  const [analysis] = await sql`SELECT a.id, a.output->'financingClaims' AS claims FROM publications p
    JOIN analyses a ON a.id=p.analysis_id WHERE p.article_id=${article}`;
  try {
    await sql`UPDATE analyses SET output=jsonb_set(output,'{financingClaims}',${sql.json([...analysis!.claims].reverse())})
      WHERE id=${analysis!.id}`;
    assert.equal((await authedGet(eventPath)).json().reports[0].claim.company,"镁伽科技");
  } finally {
    await sql`UPDATE analyses SET output=jsonb_set(output,'{financingClaims}',${sql.json(analysis!.claims)}) WHERE id=${analysis!.id}`;
  }
});

test("company history includes reviewed names, but excludes partial names and unrelated roundup deals", async () => {
  const profile = (name: string) => authedGet("/api/site/financing/company?" + new URLSearchParams({ name }));
  assert.equal((await profile("Isomorphic")).statusCode, 404);
  assert.equal((await profile("isomorphic labs")).json().historySummary.records, 1);
  await sql`INSERT INTO research_entities(name, aliases, reviewed_by) VALUES ('镁伽科技', ARRAY['测试别名'], 'test')`;
  try {
    const result = await profile("测试别名");
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().historySummary.records, 1);
    assert.equal(result.json().events[0].reports[0].claim.company, "镁伽科技");
    assert.equal(result.json().events.length, 1);
  } finally { await sql`DELETE FROM research_entities WHERE name='镁伽科技'`; }
});

test("one reviewed round shows every source when an investor matches only one report in a roundup", async () => {
  const rid = "1e181a1e-a31f-49fd-8224-15c0f91e4d23";
  const id = ids.get("ROUND")!;
  const weekly = ids.get("WEEKLY")!;
  try {
    await sql`INSERT INTO financing_round_sources(article_id,company,evidence,round_id)
      SELECT p.article_id,c->>'company',c->>'evidence',${rid}
      FROM publications p JOIN analyses a ON a.id=p.analysis_id, jsonb_array_elements(a.output->'financingClaims') c
      WHERE p.article_id=${id} OR (p.article_id=${weekly} AND c->>'company'='镁伽科技')`;
    const url = "/api/v1/financing?limit=1&investor=" + encodeURIComponent("甲基金");
    const {events,hasMore} = (await authedGet(url)).json();
    assert.equal(hasMore,false);
    assert.equal(events.length,1);
    assert.equal(events[0].id,"round:" + rid);
    assert.equal(events[0].reportCount,2);
    assert.deepEqual(new Set(events[0].reports.map((r: {id:string}) => r.id)),new Set([id,weekly]));
    const live = await authedGet(url + "&format=csv");
    await refreshFinancingIndex();
    assert.ok(await financingIndexReady(sql,new Date()));
    assert.deepEqual((await authedGet(url)).json().events, events);
    const csv = (await authedGet(url + "&format=csv")).body;
    assert.equal(csv, live.body);
    assert.equal(csv.split("\r\n").length,3);
    assert.doesNotMatch(csv,/Isomorphic/);
  } finally { await sql`DELETE FROM financing_round_sources WHERE round_id=${rid}`; }
});

test("indexed financing pages retain live filter, cursor, and timed visibility semantics", async () => {
  const article = ids.get("ROUND")!;
  const base = new Date();
  const release = new Date(+base + 86_400_000);
  const urls = ["/api/v1/financing?limit=1", "/api/v1/financing?company=镁伽",
    "/api/v1/financing?investor=a16z&investorMode=exact", "/api/site/financing/company?name=镁伽科技",
    "/api/site/financing/investors"].map(encodeURI);
  const first = await authedGet(urls[0]);
  urls.push(urls[0] + "&cursor=" + first.json().nextCursor);
  const second = (await authedGet(urls.at(-1)!)).json();
  const previousUrl = urls[0] + "&cursor=" + second.previousCursor;
  assert.deepEqual((await authedGet(previousUrl)).json(), first.json());
  urls.push(previousUrl);
  const live = await Promise.all(urls.map(async url => (await authedGet(url)).json()));
  await refreshFinancingIndex();
  assert.deepEqual(await Promise.all(urls.map(async url => (await authedGet(url)).json())), live);
  await sql`DELETE FROM settings WHERE key='financing.index-rules'`;
  assert.equal(await financingIndexReady(sql,new Date()),false);
  assert.deepEqual(await Promise.all(urls.map(async url => (await authedGet(url)).json())), live);
  await refreshFinancingIndex();
  assert.equal(await financingIndexReady(sql,new Date()),true);
  const [previous] = await sql`SELECT selected, visible_after FROM publications WHERE article_id=${article}`;
  try {
    await sql`UPDATE publications SET selected=true,visible_after=${release} WHERE article_id=${article}`;
    assert.equal(await financingIndexReady(sql,new Date()),false);
    await refreshFinancingIndex();
    const hidden = await loadFinancing({ companyHistory:"某AI公司" });
    assert.ok(hidden.events.every(e => e.reports.every(r => r.id !== article)));
    assert.equal(await financingIndexReady(sql,release),false);
    const visible = await loadFinancing({ companyHistory:"某AI公司" }, release);
    assert.ok(visible.events.some(e => e.reports.some(r => r.id === article)));
  } finally {
    await sql`UPDATE publications SET selected=${previous.selected},visible_after=${previous.visible_after} WHERE article_id=${article}`;
  }
});

test("site, public API and RSS filter financing while excluding product background and opinions", async () => {
  for (const url of ["/api/site/pool?category=financing", "/api/v1/items?mode=all&category=financing", "/feed/category/financing.xml"]) {
    const res = url.startsWith("/api/site/") ? await app.inject({ method: "GET", url }) : await authedGet(url);
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

test("two reviewed rounds in one passage preserve the source and independent search fields", async () => {
  const article = ids.get("WEEKLY")!;
  const [raw] = await sql`SELECT c FROM publications p JOIN analyses a ON a.id=p.analysis_id,
    jsonb_array_elements(a.output->'financingClaims') c WHERE p.article_id=${article} AND c->>'company'='镁伽科技'`;
  assert.ok(raw?.c);
  try {
    for (const [i, stage] of ["种子轮","A轮"].entries()) {
      const claim = { ...raw.c, round:stage, amountText:null, currency:null, amountBasis:"unknown", investors:[stage + "基金"] };
      await sql`INSERT INTO financing_claim_reviews(article_id,company,evidence,part,original_claim,claim,round_id)
        VALUES (${article},${raw.c.company},${raw.c.evidence},${i+1},${sql.json(raw.c)},${sql.json(claim)},gen_random_uuid())`;
    }
    const [url, company] = ["/api/v1/financing?", "镁伽"];
    const result = (await authedGet(url + new URLSearchParams({ company }))).json();
    assert.deepEqual(new Set(result.events.map((e: {reports:{claim:{round:string}}[]}) => e.reports[0]!.claim.round)),new Set(["种子轮","A轮"]));
    const history = (await authedGet("/api/site/financing/company?" + new URLSearchParams({ name: raw.c.company }))).json();
    assert.equal(history.historySummary.records, 2);
    assert.deepEqual(history.events.map((e: {id:string}) => e.id), result.events.map((e: {id:string}) => e.id));
    const only = (await authedGet(url + new URLSearchParams({ company, investor: "A轮基金" }))).json();
    assert.equal(only.events.length,1);
    assert.equal(only.events[0].reports[0].id,article);
    assert.equal(only.events[0].reports[0].claim.round,"A轮");
    assert.equal(only.events[0].reports[0].claim.amountText,null);
  } finally { await sql`DELETE FROM financing_claim_reviews WHERE article_id=${article}`; }
});

test("two reviewed mentions in one article keep both quotes and count as one report", async () => {
  const article = ids.get("WEEKLY")!;
  const [raw] = await sql`SELECT c FROM publications p JOIN analyses a ON a.id=p.analysis_id,
    jsonb_array_elements(a.output->'financingClaims') c WHERE p.article_id=${article} AND c->>'company'='镁伽科技'`;
  assert.ok(raw?.c);
  const id = "39867ca1-ad76-45b2-b136-e24b18e62209";
  try {
    for (const [i, quote] of [robotDeal,"本轮由甲基金领投。"].entries()) {
      const claim = {...raw.c,evidence:quote};
      await sql`INSERT INTO financing_claim_reviews(article_id,company,evidence,part,original_claim,claim,round_id)
        VALUES (${article},${raw.c.company},${raw.c.evidence},${i+1},${sql.json(raw.c)},${sql.json(claim)},${id})`;
    }
    const url = "/api/v1/financing?company=" + encodeURIComponent("镁伽");
    const {events} = (await authedGet(url)).json();
    assert.equal(events.length,1);
    assert.equal(events[0].reportCount,1);
    const [r] = events[0].reports;
    assert.deepEqual(new Set([r.claim.evidence,r.additionalClaims[0].evidence]),new Set([robotDeal,"本轮由甲基金领投。"]));
    const csv = (await authedGet(url + "&format=csv")).body;
    assert.equal(csv.split("\r\n").length,3);
    assert.ok(csv.includes("记录类型"));
  } finally { await sql`DELETE FROM financing_claim_reviews WHERE article_id=${article}`; }
});


test("all-results CSV follows the entire filtered snapshot and retains each source claim once", async () => {
  const article = ids.get("WEEKLY")!;
  const [original] = await sql`SELECT a.id, a.output->'financingClaims' AS claims FROM publications p
    JOIN analyses a ON a.id=p.analysis_id WHERE p.article_id=${article}`;
  const claims = Array.from({length:103}, (_, i) => ({...original!.claims[0], company:"跨页导出测试" + i, evidence:"原文证据 " + i}));
  try {
    await sql`UPDATE analyses SET output=jsonb_set(output,'{financingClaims}',${sql.json(claims)}) WHERE id=${original!.id}`;
    const base = "/api/v1/financing?" + new URLSearchParams({company:"跨页导出测试",limit:"40"});
    const exportAll = base + "&format=csv&scope=all";
    const live = await authedGet(exportAll);
    await refreshFinancingIndex();
    const result = await authedGet(exportAll);
    assert.equal(live.body, result.body);
    assert.equal(result.statusCode,200);
    assert.equal(result.headers["cache-control"],"private, no-store");
    assert.match(decodeURIComponent(String(result.headers["content-disposition"])), /跨页导出测试-全部结果/);
    const lines = result.body.split("\r\n");
    assert.equal(lines.length,104);
    const byPage: string[] = [];
    let cursor: string | null = null;
    do {
      const path: string = base + (cursor ? "&cursor=" + cursor : "");
      const page = await authedGet(path + "&format=csv");
      byPage.push(...page.body.split("\r\n").slice(1));
      cursor = (await authedGet(path)).json().nextCursor;
    } while (cursor);
    assert.deepEqual(lines.slice(1),byPage);
    assert.equal(new Set(byPage).size,103);
    const dateExport = await authedGet(exportAll + "&from=2026-11-20&to=2026-11-26");
    assert.equal(dateExport.statusCode,200);
    assert.match(decodeURIComponent(String(dateExport.headers["content-disposition"])), /2026-11-20_2026-11-26-全部结果/);
    assert.equal((await authedGet(exportAll + "&cursor=bad")).statusCode,400);
    for (const scope of ["page","all"]) assert.equal((await authedGet(base + "&format=csv&scope=" + scope + "&cursor=")).statusCode,400);
    assert.equal((await app.inject(exportAll)).statusCode,401);
  } finally {
    await sql`UPDATE analyses SET output=jsonb_set(output,'{financingClaims}',${sql.json(original!.claims)}) WHERE id=${original!.id}`;
  }
});


test("investor company counts cover older pages, normalize company names, and respect reviewed aliases", async () => {
  const [analysis] = await sql`SELECT a.id, a.output->'financingClaims' AS claims FROM publications p
    JOIN analyses a ON p.analysis_id=a.id WHERE p.article_id=${ids.get("WEEKLY")!}`;
  const names = ["融资计数甲", "Count  Labs", "ＣＯＵＮＴ LABS", "融资计数甲别名", "融资计数乙"];
  const claims = names.map((company,i) => ({...analysis!.claims[0],company,round:"第" + i + "轮",investors:["计数机构"],evidence:company + "融资" + i}));
  try {
    await sql`INSERT INTO research_entities(name,aliases,reviewed_by) VALUES ('融资计数甲',ARRAY['融资计数甲别名'],'test')`;
    await sql`UPDATE analyses SET output=jsonb_set(output,'{financingClaims}',${sql.json(claims)}) WHERE id=${analysis!.id}`;
    for (const indexed of [false,true]) {
      if (indexed) await refreshFinancingIndex();
      const first = await loadFinancing({investor:"计数机构", investorExact:true, companiesOnly:true, limit:2});
      const second = await loadFinancing({investor:"计数机构", investorExact:true, companiesOnly:true, limit:2,cursor:first.nextCursor});
      assert.equal(first.events.length,2);
      assert.equal(first.historySummary?.records,5);
      assert.equal(first.historySummary?.companies,3);
      assert.deepEqual(second.historySummary,first.historySummary);
    }
  } finally {
    await sql`UPDATE analyses SET output=jsonb_set(output,'{financingClaims}',${sql.json(analysis!.claims)}) WHERE id=${analysis!.id}`;
    await sql`DELETE FROM research_entities WHERE name='融资计数甲'`;
  }
});

test("slow full exports preserve snapshots, enforce a separate limit, and release capacity on cancellation", async () => {
  const [analysis] = await sql`SELECT a.id, a.output->'financingClaims' AS claims FROM publications p
    JOIN analyses a ON p.analysis_id=a.id WHERE p.article_id=${ids.get("WEEKLY")!}`;
  const claims = Array.from({length:103}, (_, i) => ({ ...analysis!.claims[0], company:"慢速导出" + i, evidence:"原文".repeat(450) + i }));
  const first = new AbortController(), second = new AbortController();
  const query = {company:"慢速导出"};
  try {
    await sql`UPDATE analyses SET output=jsonb_set(output,'{financingClaims}',${sql.json(claims)}) WHERE id=${analysis!.id}`;
    await refreshFinancingIndex();
    const [a,b] = await Promise.all([exportFinancingCsv(query, true, first.signal), exportFinancingCsv(query, true, second.signal)]);
    assert.ok(typeof a !== "string" && typeof b !== "string");
    assert.ok(a.writableNeedDrain && b.writableNeedDrain, "both consumers are paused on the first batch");
    const saturated = await authedGet("/api/v1/financing?format=csv&scope=all");
    assert.equal((await authedGet("/api/v1/financing?format=csv&scope=page&limit=2")).statusCode, 200);
    assert.equal(saturated.statusCode,503);
    assert.ok(saturated.headers["retry-after"]);
    assert.equal((await loadFinancing({...query,limit:1})).events.length,1);
    await sql`UPDATE analyses SET output=jsonb_set(output,'{financingClaims}',${sql.json(analysis!.claims)}) WHERE id=${analysis!.id}`;
    second.abort();
    const csv = await streamText(a);
    assert.equal(csv.split("\r\n").length,104);
    assert.equal((await loadFinancing(query)).events.length,0);
    await assert.doesNotReject(async () => {
      for (let attempt = 0; ; attempt++) {
        const result = await authedGet("/api/v1/financing?format=csv&scope=all");
        if (result.statusCode === 200) return;
        assert.ok(attempt < 50);
        await delay(10);
      }
    });
  } finally {
    first.abort();
    second.abort();
    await sql`UPDATE analyses SET output=jsonb_set(output,'{financingClaims}',${sql.json(analysis!.claims)}) WHERE id=${analysis!.id}`;
  }
});

test("disconnect interrupts the active PostgreSQL export query before it can acquire a blocked lock", async () => {
  const controller = new AbortController();
  await sql.begin(async tx => {
    await tx`LOCK financing_index_state IN ACCESS EXCLUSIVE MODE`;
    const rejected = Promise.all([false,true].map(all => assert.rejects(exportFinancingCsv({}, all, controller.signal),
      (error: {code?: string}) => error.code === "57014")));
    try {
      for (let attempt = 0; ; attempt++) {
        const [found] = await sql`SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
          AND query LIKE '%FROM financing_index_state%'`;
        if (found!.waiting === 2) break;
        assert.ok(attempt < 100, "export query is waiting for the deliberate lock");
        await delay(10);
      }
    } finally { controller.abort(); }
    await rejected;
  });
});

test("withdrawal from the last cursor page preserves real profile totals and the first-page recovery", async () => {
  const [analysis] = await sql`SELECT a.id, a.output->'financingClaims' AS claims FROM publications p
    JOIN analyses a ON p.analysis_id=a.id WHERE p.article_id=${ids.get("WEEKLY")!}`;
  const name = "撤下分页测试", investor = "撤下分页机构";
  const claims = Array.from({length:41}, (_, i) => ({...analysis!.claims[0], company:name, round:"测试轮次" + i, investors:[investor], evidence:"撤下分页证据 " + i}));
  const paths = ["/api/site/financing/company?" + new URLSearchParams({name}),
    "/api/site/financing/investor?" + new URLSearchParams({name:investor}), "/api/v1/financing?" + new URLSearchParams({company:name})];
  try {
    await sql`UPDATE analyses SET output=jsonb_set(output,'{financingClaims}',${sql.json(claims)}) WHERE id=${analysis!.id}`;
    await refreshFinancingIndex();
    const cursors = await Promise.all(paths.map(async path => (await authedGet(path)).json().nextCursor));
    assert.ok(cursors.every(Boolean));
    const last = (await authedGet(paths[0] + "&cursor=" + cursors[0])).json().events[0].reports[0].claim.evidence;
    await sql`UPDATE analyses SET output=jsonb_set(output,'{financingClaims}',${sql.json(claims.map(c => c.evidence === last ? {...c,company:"重新归属的公司",investors:[]} : c))}) WHERE id=${analysis!.id}`;
    for (const indexed of [false,true]) {
      if (indexed) await refreshFinancingIndex();
      for (const [i,path] of paths.entries()) {
        const response = await authedGet(path + "&cursor=" + cursors[i]);
        assert.equal(response.statusCode,200);
        const page = response.json();
        assert.deepEqual(page.events,[]);
        assert.equal(page.pageReset,true);
        if (i < 2) assert.equal(page.historySummary.records,40);
        if (i === 1) assert.equal(page.historySummary.companies,1);
      }
    }
  } finally { await sql`UPDATE analyses SET output=jsonb_set(output,'{financingClaims}',${sql.json(analysis!.claims)}) WHERE id=${analysis!.id}`; }
});

test("oversize live exports offer an explicit retry and preserve the browser's filters until the index is ready", async () => {
  const [analysis] = await sql`SELECT a.id, a.output->'financingClaims' AS claims FROM publications p
    JOIN analyses a ON p.analysis_id=a.id WHERE p.article_id=${ids.get("WEEKLY")!}`;
  const claims = Array.from({length:2001}, (_, i) => ({...analysis!.claims[0],company:"有界导出" + i,evidence:"原文证据 " + i}));
  const base = "/api/v1/financing?company=" + encodeURIComponent("有界导出");
  try {
    await sql`UPDATE analyses SET output=jsonb_set(output,'{financingClaims}',${sql.json(claims)}) WHERE id=${analysis!.id}`;
    const url = base + "&scope=all&format=csv";
    const early = await authedGet(url);
    assert.equal(early.statusCode,503);
    assert.equal(early.json().code,"financing_index_refreshing");
    assert.equal(early.headers["retry-after"],"60");
    const browser = await app.inject({url, headers:{ ...member.headers, accept:"text/html", "sec-fetch-mode":"navigate" }});
    assert.equal(browser.statusCode,503);
    assert.match(String(browser.headers["content-type"]),/text\/html/);
    assert.match(browser.body,/返回筛选结果/);
    assert.match(browser.body,/重新导出/);
    assert.ok(browser.body.includes("/financing?company=" + encodeURIComponent("有界导出")));
    const page = await authedGet(base + "&limit=1&format=csv");
    assert.equal(page.statusCode,503);
    assert.equal(page.json().code,"financing_index_refreshing");
    assert.equal(page.headers["retry-after"],"60");
    assert.equal((await authedGet(base + "&limit=1")).statusCode,200);
    await refreshFinancingIndex();
    assert.equal((await authedGet(base + "&limit=1&format=csv")).statusCode,200);
    const indexed = await authedGet(url);
    assert.equal(indexed.statusCode,200);
    assert.equal(indexed.body.split("\r\n").length,2002);
  } finally { await sql`UPDATE analyses SET output=jsonb_set(output,'{financingClaims}',${sql.json(analysis!.claims)}) WHERE id=${analysis!.id}`; }
});
