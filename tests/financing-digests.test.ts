import { tag, stub } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { digestCoverage, digestEntries } from "@aihot/backend/editorial/financing-digests";
import { financingBatchEntry } from "@aihot/backend/editorial/financing-extraction";
import { historicalFinancingDigests, runFinancingBatch } from "@aihot/backend/editorial/financing-sweep";

after(closeDb);
const title = "量子企业和晶圆设备厂商获融资｜创投日报";
const deals = [
  { company: "原子矩阵", amountText: "数亿人民币", line: "原子矩阵 🇨🇳 国内 量子计算 数亿人民币 📍 B轮 📅 11-20 本轮B轮融资数亿人民币。" },
  { company: "博纳半导体", amountText: "1亿人民币", line: "博纳半导体 🇨🇳 国内 晶圆设备 1亿人民币 📍 B轮 📅 11-20 本轮B轮融资1亿人民币。" },
];
const original = deals.map(d => d.line).join(" ");
const sections = digestEntries(title, original, original);
const claims = deals.map(d => ({ ...d, evidence: d.line, passage: d.line, round: "B轮", kind: "company_round", amountBasis: "round", status: "closed", investors: [] }));

test("two deals from the original body retain their own amounts and rounds; absent or mismatched rows stay flagged", () => {
  assert.equal(sections.length, 2);
  const m = { id: 1, text: title + "\n" + original, format: "rounds" as const, digestEntries: sections };
  const result = financingBatchEntry(m, claims);
  assert.deepEqual(result.claims?.map(c => [c.company,c.round,c.amountText]), [["原子矩阵","B轮","数亿人民币"],["博纳半导体","B轮","1亿人民币"]]);
  assert.equal(result.review.reason, "verified_transactions");
  for (const value of [[], [claims[0]]]) assert.equal(financingBatchEntry(m, value).review.reason, "incomplete_roundup");
  assert.equal(digestCoverage(sections, [claims[0]!, { ...claims[1]!, amountText: "11亿人民币" }]).verified, 1);
  assert.equal(digestCoverage(sections, [claims[0]!, { ...claims[1]!, round: "Pre-B轮" }]).verified, 1);
  assert.deepEqual(digestEntries("邦早报", deals[0]!.line, deals[0]!.line), []);
  assert.deepEqual(digestEntries("投资观点｜早报", "【企业融资为何遇冷】【谁在讨论早期投资】", null), []);
  assert.equal(digestEntries("科技早报", null, "【甲科技完成A轮融资】进展【乙科技获得B轮融资】").length, 2);
});

test("the worker repairs confirmed v1 omissions only and serves new digests before explicitly approved historical reports", async () => {
  const sourceId = tag();
  await sql`INSERT INTO sources(id,name,kind) VALUES (${sourceId},'daily test','rss')`;
  const provider = await stub((_hit, request) => {
    const user = (JSON.parse(request.body) as {messages: Array<{role: string; content: string}>}).messages.find(m => m.role === "user")!;
    const [item] = JSON.parse(user.content) as Array<{id: number; historicalDigest?: boolean}>;
    return { choices: [{ message: { content: JSON.stringify({ results: [{ id: item!.id, claims: item!.historicalDigest ? claims.slice(0,1) : claims }] }) } }] };
  });
  Object.assign(process.env, { MODEL_CALLS_ENABLED: "true", STRUCTURE_MODEL: "deepseek-flash", DEEPSEEK_BASE_URL: provider.url, DEEPSEEK_API_KEY: "test-key" });
  async function article(body: string, category: string, legacy?: "completed" | "unknown" | "valid") {
    const aid = tag(), url = "https://example.invalid/" + aid;
    await sql`INSERT INTO articles(id,identity_key,source_id,title,url,excerpt,discovered_at,timeline_at)
      VALUES (${aid},${aid},${sourceId},${title},${url},${body},now(),now())`;
    const [analysis] = await sql`INSERT INTO analyses(article_id,input_revision,origin,output) VALUES (${aid},1,'rule','{}') RETURNING id`;
    if (legacy) {
      const [b] = await sql`INSERT INTO financing_extraction_batches(material,finished_at) VALUES ('[]',now()) RETURNING id`;
      const [receipt] = await sql`INSERT INTO receipts(logical_key,purpose,subject,service,status) VALUES
        (${tag()},'financing_extract',${'financing-batch:'+b!.id},'llm',${legacy === 'unknown' ? 'unknown' : 'completed'}) RETURNING id`;
      const data = { financingReview: {version:"financing-investors-v1",reason:"no_single_transaction",receiptId:receipt!.id},
        financingBatch:b!.id, financing:legacy === "valid" ? claims[0] : null };
      await sql`UPDATE analyses SET output=${sql.json(data as never)} WHERE id=${analysis!.id}`;
    }
    await sql`INSERT INTO publications(article_id,analysis_id,title,source_id,channel,url,eligible,category,discovered_at,timeline_at,sort_at)
      VALUES (${aid},${analysis!.id},${title},${sourceId},'news',${url},true,${category},now(),now(),now())`;
    return Number(analysis!.id);
  }
  const review = async (id: number) => (await sql`SELECT output FROM analyses WHERE id=${id}`)[0]!.output;
  try {
    await sql`DELETE FROM settings WHERE key='financing.daily-start-analysis'`;
    const fix = await article(original, "financing", "completed");
    const unresolved = await article(original, "financing", "unknown");
    const valid = await article(original, "financing", "valid");
    const one = await article(deals[0]!.line, "financing", "completed");
    const historical = await article(original, "industry");
    assert.equal(await runFinancingBatch(), "completed");
    assert.equal((await review(fix)).financingClaims.length, 2);
    for (const id of [unresolved, valid, one]) assert.equal((await review(id)).financingReview.version, "financing-investors-v1");
    assert.equal(await runFinancingBatch(), "idle");
    assert.deepEqual(await historicalFinancingDigests([historical, fix, valid, unresolved]), [historical]);
    assert.deepEqual(await historicalFinancingDigests([historical], true), [historical]);
    assert.deepEqual(await historicalFinancingDigests([historical], true), []);
    const fresh = await article(original, "industry");
    assert.equal(await runFinancingBatch(), "completed");
    assert.equal((await review(fresh)).financingClaims.length, 2);
    assert.equal((await review(historical)).financingReview, undefined);
    assert.equal(await runFinancingBatch(), "completed");
    const partial = await review(historical);
    assert.equal(partial.financingClaims.length, 1);
    assert.equal(partial.financingReview.reason, "incomplete_roundup");
    assert.equal(partial.financingReview.coverage.expected, 2);
    assert.equal(partial.financingReview.coverage.missing.length, 1);
    assert.equal(await runFinancingBatch(), "idle");
    assert.equal(provider.hits(), 3);
  } finally {
    await provider.close();
    await sql`DELETE FROM articles WHERE source_id=${sourceId}`;
    await sql`DELETE FROM sources WHERE id=${sourceId}`;
  }
});
