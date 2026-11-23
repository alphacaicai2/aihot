import { tag, stub } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { digestCoverage, digestEntries } from "@aihot/backend/editorial/financing-digests";
import { financingBatchEntry } from "@aihot/backend/editorial/financing-extraction";
import { replayFinancingDigests } from "@aihot/backend/editorial/financing-replay";
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
  const joint = jointFinancingFixture();
  let jointId = 0;
  const provider = await stub((_hit, request) => {
    const user = (JSON.parse(request.body) as {messages: Array<{role: string; content: string}>}).messages.find(m => m.role === "user")!;
    const [item] = JSON.parse(user.content) as Array<{id: number; historicalDigest?: boolean}>;
    return { choices: [{ message: { content: JSON.stringify({ results: [{ id: item!.id, claims: item!.id === jointId ? joint.proposed : item!.historicalDigest ? claims.slice(0,1) : claims }] }) } }] };
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
    const normalized = financingBatchEntry({id:fix,text:original,format:"rounds",digestEntries:sections},claims).claims!;
    async function finishedReceipt(id:number,status:string,prior=normalized.slice(0,0),section?:{text:string; claims:unknown[]}) {
      const reply = claims.map((c,i)=>({...c,passage:undefined,evidence:deals[i]!.line.split("11-20 ")[1]}));
      const material = [{id,format:"rounds",digestEntries:section ? digestEntries(title,section.text,null) : sections,text:section?.text ?? original}];
      const [b] = await sql`INSERT INTO financing_extraction_batches(material,finished_at) VALUES (${sql.json(material)},now()) RETURNING id`;
      const [r] = await sql`INSERT INTO receipts(logical_key,purpose,subject,service,status,request,response)
        VALUES (${tag()},'financing_extract',${"financing-batch:"+b!.id},'llm',${status},'{"promptVersion":"financing-digest-v1"}',
        ${sql.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({results:[{id,claims:section?.claims ?? reply}]})}}]})}) RETURNING id`;
      const out = {financingBatch:b!.id,financingClaims:prior,financingReview:{reason:"incomplete_roundup",version:"financing-digest-v1",receiptId:r!.id}};
      await sql`UPDATE analyses SET output=${sql.json(out as never)} WHERE id=${id}`;
    }
    const repair = await article(original,"financing");
    const manual = await article(original,"financing");
    const unknown = await article(original,"financing");
    await finishedReceipt(repair,"completed",[{...normalized[0]!,evidence:"已有已核原文"}]);
    await finishedReceipt(manual,"completed");
    await finishedReceipt(unknown,"unknown");
    await sql`INSERT INTO financing_round_sources(article_id,company,evidence,round_id)
      SELECT article_id,'手工公司','手工证据',gen_random_uuid() FROM analyses WHERE id=${manual}`;
    const ids=[repair,manual,unknown];
    const preview=await replayFinancingDigests(ids);
    assert.deepEqual(preview.map(r=>[r.id,r.verified]),[[repair,2]]);
    assert.equal((await review(repair)).financingClaims.length,1);
    assert.deepEqual(await replayFinancingDigests(ids,true),preview);
    assert.deepEqual(await replayFinancingDigests(ids,true),[]);
    assert.equal((await review(repair)).financingClaims[0].evidence,"已有已核原文");
    for (const id of [manual,unknown]) assert.equal((await review(id)).financingClaims.length,0);
    const first = "甲科技完成 A 轮融资。";
    const second = "乙科技完成 B 轮融资。";
    const headingBody = "【甲科技完成A轮融资】" + first + "公司主营芯片。本轮由甲基金领投。【乙科技完成B轮融资】" + second;
    const proposals = [
      {company:"甲科技",evidence:first,round:"A 轮",kind:"company_round",investors:[{name:"甲基金",quote:"本轮由甲基金领投"}]},
      {company:"乙科技",evidence:second,round:"B 轮",kind:"company_round",investors:[]},
    ];
    const untouched = financingBatchEntry({id:1,text:headingBody,format:"rounds"},proposals).claims!;
    const sectionId = await article(headingBody,"financing");
    const manualSection = await article(headingBody,"financing");
    for (const id of [sectionId,manualSection]) await finishedReceipt(id,"completed",untouched,{text:headingBody,claims:proposals});
    await sql`INSERT INTO financing_claim_reviews(article_id,company,evidence,part,original_claim,claim,round_id)
      SELECT article_id,'甲科技',${first},1,'{}','{}',gen_random_uuid() FROM analyses WHERE id=${manualSection}`;
    const headings = await replayFinancingDigests([sectionId,manualSection]);
    assert.deepEqual(headings.map(r=>r.id),[sectionId]);
    assert.deepEqual(await replayFinancingDigests([sectionId,manualSection],true),headings);
    assert.deepEqual((await review(sectionId)).financingClaims[0].investors,["甲基金"]);
    assert.deepEqual((await review(manualSection)).financingClaims[0].investors,[]);
    assert.deepEqual(await replayFinancingDigests([sectionId,manualSection],true),[]);
    assert.equal(provider.hits(), 3);
    jointId = await article(joint.material.text,"industry");
    assert.equal(await runFinancingBatch(),"completed");
    const scheduled = (await review(jointId)).financingClaims;
    assert.deepEqual(scheduled.map((c:{investors:string[]})=>c.investors),[["阿里"],[]]);
    const jointReplay = await article(joint.material.text,"industry");
    await finishedReceipt(jointReplay,"completed",[],{text:joint.material.text,claims:joint.proposed});
    const result = await replayFinancingDigests([jointReplay],true);
    assert.deepEqual(result.map(r=>r.id),[jointReplay]);
    assert.deepEqual((await review(jointReplay)).financingClaims,scheduled);
    assert.deepEqual(await replayFinancingDigests([jointReplay],true),[]);
    assert.equal(provider.hits(),4);
  } finally {
    await provider.close();
    await sql`DELETE FROM articles WHERE source_id=${sourceId}`;
    await sql`DELETE FROM sources WHERE id=${sourceId}`;
  }
});

test("a receipt may cite the body of a printed financing card; terms and investors stay within the named card", () => {
  const a = deals[0]!.line + " 投资方：甲基金；财务顾问甲顾问";
  const b = deals[1]!.line + " 投资方：乙基金";
  const text = a + " " + b;
  const material = { id: 3, format:"rounds" as const, text, digestEntries:digestEntries(title,text,null) };
  const proposed = [
    {...claims[0], evidence:"本轮B轮融资数亿人民币。", passage:undefined, investors:[
      {name:"甲基金",quote:"投资方：甲基金；财务顾问甲顾问"}, {name:"甲顾问",quote:"投资方：甲基金；财务顾问甲顾问"},
      {name:"乙基金",quote:"投资方：乙基金"}, {name:"博纳半导体",quote:"甲顾问 博纳半导体"},
    ]},
    {...claims[1], evidence:"本轮B轮融资1亿人民币。", passage:undefined,investors:[{name:"乙基金",quote:"投资方：乙基金"}]},
  ];
  const good = financingBatchEntry(material,proposed);
  assert.deepEqual(good.claims?.map(c=>[c.company,c.round,c.amountText,c.investors]),[
    ["原子矩阵","B轮","数亿人民币",["甲基金"]],["博纳半导体","B轮","1亿人民币",["乙基金"]],
  ]);
  assert.ok(good.claims?.every(c=>text.includes(c.evidence) && c.evidence.startsWith(c.company)));
  for(const wrong of [
    {...proposed[1], evidence:proposed[0]!.evidence}, {...proposed[1], amountText:"数亿人民币"},
    {...proposed[1], round:"A轮"}, {...proposed[1], company:"半导体"},
  ]){
    const partial=financingBatchEntry(material,[proposed[0],wrong]);
    assert.equal(partial.review.reason,"incomplete_roundup"); assert.equal(partial.claims?.length,1);
  }
  assert.equal(financingBatchEntry({...material,digestEntries:undefined},proposed).claims?.length,0);
});

test("section receipts bind current investors to their company, financing and closing", () => {
  const first = "甲科技完成 A+ 轮融资，累计超过 1 亿美元。";
  const second = "乙科技完成 B 轮融资首笔交割。";
  const text = "【甲科技完成A+轮融资】" + first +
    "新一轮由甲基金、乙基金联合投资。上一轮由旧基金领投。公司正洽谈由未来基金本轮跟投。" +
    "本轮由顾问基金担任财务顾问。本轮由实投基金领投，商业伙伴亦出席。" +
    "戊科技本轮由错企基金领投。本轮由大海基金领投。本轮由母公司旗下两只基金参与增资。本轮由福基金及其旗下基金主要领投。" +
    "B轮由他轮基金领投。【新产品发布】产品发布会上，本轮由别处基金领投。" +
    "【乙科技完成B轮融资】" + second + "本轮其他投资者包括整轮基金。首笔由首笔基金跟投。" +
    "【其他企业完成C轮融资】本轮由邻企基金领投。";
  const material={id:41,text,format:"rounds" as const,digestEntries:digestEntries("科技早报",text,null)};
  const i=(name:string,quote:string)=>({name,quote});
  const firstInvestors=[
    i("甲基金","甲基金、乙基金联合投资"),i("乙基金","甲基金、乙基金联合投资"),
    i("旧基金","旧基金领投"),i("未来基金","未来基金本轮跟投"),i("顾问基金","顾问基金担任财务顾问"),
    i("实投基金","本轮由实投基金领投，商业伙伴亦出席"),i("商业伙伴","本轮由实投基金领投，商业伙伴亦出席"),
    i("母公司","母公司旗下两只基金参与增资"),i("母公司旗下两只基金","母公司旗下两只基金参与增资"),
    i("海基金","海基金领投"),i("错企基金","错企基金领投"),i("福基金","福基金及其旗下基金主要领投"),i("他轮基金","他轮基金领投"),i("别处基金","别处基金领投"),
    i("首笔基金","首笔基金跟投"),i("邻企基金","邻企基金领投"),
  ];
  const value=[{company:"甲科技",round:"A+ 轮",kind:"company_round",amountText:"累计超过 1 亿美元",
    amountBasis:"cumulative",evidence:first,investors:firstInvestors},
    {company:"乙科技",round:"B 轮",kind:"company_round",evidence:second,investors:[
      i("整轮基金","本轮其他投资者包括整轮基金"),i("首笔基金","首笔基金跟投"),i("邻企基金","邻企基金领投")]}];
  const result=financingBatchEntry(material,value);
  assert.deepEqual(result.claims?.map(c=>c.investors),[["甲基金","乙基金","实投基金","福基金"],["首笔基金"]]);
  assert.equal(result.claims?.[0]?.amountBasis,"cumulative");
  const noHeadings={...material,text:text.replace(/【[^】]*】/g,""),digestEntries:[{heading:"甲科技完成融资"},{heading:"乙科技获得融资"}]};
  assert.deepEqual(financingBatchEntry(noHeadings,value).claims?.map(c=>c.investors),[[],[]]);
});

function jointFinancingFixture() {
  const sentence="本轮B轮融资由红杉、腾讯、阿里联合参与。";
  const historic="此前本轮B轮融资由旧方、错方联合参与。";
  const stage="本轮A轮融资由先方、他方联合参与。";
  const sibling="本轮B轮融资由邻方、串方联合参与。";
  const body=deals[0]!.line+" "+sentence+" "+historic+" "+stage+" "+deals[1]!.line+" "+sibling;
  const material={id:5,text:body,format:"rounds" as const,digestEntries:digestEntries(title,body,null)};
  const proposed=[{...claims[0],evidence:"本轮B轮融资数亿人民币。",investors:[
    {name:"阿里",quote:sentence},{name:"里",quote:sentence},{name:"错方",quote:historic.slice(2)},
    {name:"他方",quote:stage},{name:"邻方",quote:sibling},
  ]}, {...claims[1],evidence:"本轮B轮融资1亿人民币。",investors:[{name:"阿里",quote:sentence}]}];
  return {material,proposed};
}

test("ordinary financing extraction verifies joint participation only in the same printed card", () => {
  const {material,proposed}=jointFinancingFixture();
  assert.deepEqual(financingBatchEntry(material,proposed).claims?.map(c=>c.investors),[["阿里"],[]]);
  assert.deepEqual(financingBatchEntry({...material,digestEntries:undefined},proposed).claims?.map(c=>c.investors),[]);
});
