import { tag, stub } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { runFinancingBatch } from "@aihot/backend/editorial/financing-sweep";
import { BudgetExceededError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";

after(closeDb);
const first = "甲科技完成A轮融资。";
const next = "乙科技完成B轮融资。";
const other = "甲科技曾经完成天使轮融资。";
const source = "【甲科技完成A轮融资】"+first+"【其他新闻】"+other+"【乙科技完成B轮融资】"+next;
const candidate = (company:string,round:string,evidence:string) => ({company,round,evidence,kind:"company_round",status:"closed",investors:[]});
const a = candidate("甲科技","A轮",first), b = candidate("乙科技","B轮",next);

test("fresh digests backfill only uncovered source sections using the same budget and receipt guards",async()=>{
  let repeatKnownRound = false;
  const provider = await stub((_n,req)=>{
    const user = JSON.parse(req.body).messages.find((m:{role:string})=>m.role==="user").content;
    const inputs = JSON.parse(user) as Array<{id:number; text:string; missingRounds?:string[]}>;
    const proposals = inputs.map(m=>{
      if(m.text.includes("【甲科技完成A轮融资】")) return {id:m.id,claims:[a]};
      if(m.text.includes("【星辰完成A轮及A+轮融资】")) {
        const c = m.missingRounds && !repeatKnownRound ? candidate("星辰","A+轮","星辰完成A+轮融资") : candidate("星辰","A轮","星辰完成A轮融资");
        return {id:m.id,claims:[c]};
      }
      if(m.text.includes("【乙科技完成B轮融资】")) {
        assert.ok(!m.text.includes("甲科技")&&!m.text.includes("其他新闻"));
        return {id:m.id,claims:[b,a]};
      }
      if(m.text.includes("【星岛跻身独角兽】")){
        return {id:m.id,claims:[candidate("星岛","A轮","星岛宣布完成A轮融资")]};
      }
      throw Error("unexpected test input");
    });
    return {choices:[{message:{content:JSON.stringify({results:proposals})}}]};
  });
  Object.assign(process.env,{MODEL_CALLS_ENABLED:"true",STRUCTURE_MODEL:"deepseek-flash",DEEPSEEK_BASE_URL:provider.url,DEEPSEEK_API_KEY:"test-key"});
  const src=tag();
  await sql`INSERT INTO sources(id,name,kind) VALUES (${src},'followup test','rss')`;
  const [originalBudget]=await sql`SELECT per_minute FROM budgets WHERE service='deepseek'`;
  const [previousStart]=await sql`SELECT value FROM settings WHERE key='financing.daily-start-analysis'`;
  const [start]=await sql`SELECT coalesce(max(id),0) AS value FROM analyses`;
  await sql`INSERT INTO settings(key,value) VALUES ('financing.daily-start-analysis',to_jsonb(${Number(start!.value)}::bigint))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
  async function article(body=source,title="科技早报",revision=false) {
    const id=tag(),url="https://example.invalid/"+id;
    await sql`INSERT INTO articles(id,identity_key,source_id,title,url,body_text,revision,discovered_at,timeline_at)
      VALUES (${id},${id},${src},${title},${url},${revision?"【乙科技完成B轮融资】错误新版正文":body},${revision?2:1},now(),now())`;
    if(revision) await sql`INSERT INTO article_revisions(article_id,revision,title,body_text) VALUES(${id},1,${title},${body})`;
    const [analysis]=await sql`INSERT INTO analyses(article_id,input_revision,origin,output) VALUES (${id},1,'rule','{}') RETURNING id`;
    await sql`INSERT INTO publications(article_id,analysis_id,title,source_id,channel,url,eligible,category,discovered_at,timeline_at,sort_at)
      VALUES (${id},${analysis!.id},${title},${src},'news',${url},true,'industry',now(),now(),now())`;
    return {analysis:Number(analysis!.id),article:id};
  }
  async function output(id:number) {return (await sql`SELECT output FROM analyses WHERE id=${id}`)[0]!.output;}
  async function due(id:number) {await sql`UPDATE financing_extraction_batches SET next_run='1900-01-01' WHERE id=${id}`;}
  try {
    // The original, untruncated fixed revision is still available after the public article changes.
    const post=await article(source.replace("【乙科技完成B轮融资】","【长篇新闻】"+"长".repeat(26000)+"【乙科技完成B轮融资】"),"科技早报",true);
    assert.equal(await runFinancingBatch(),"completed");
    const initial=await output(post.analysis), child=initial.financingReview.followup.batchId;
    assert.deepEqual(initial.financingClaims.map((c:typeof a)=>c.company),["甲科技"]);
    assert.deepEqual(initial.financingReview.coverage.missing.map((e:{heading:string})=>e.heading),["乙科技完成B轮融资"]);
    // Budget denied before the provider receives a request; restoring the cap reuses the same child.
    await sql`UPDATE budgets SET per_minute=0 WHERE service='deepseek'`;
    await assert.rejects(runFinancingBatch(),BudgetExceededError);
    assert.equal(provider.hits(),1);
    await sql`UPDATE budgets SET per_minute=${originalBudget!.per_minute} WHERE service='deepseek'`;
    await due(child);
    assert.equal(await runFinancingBatch(),"completed");
    const completed=await output(post.analysis);
    assert.deepEqual(completed.financingClaims.map((c:typeof a)=>c.company),["甲科技","乙科技"]);
    assert.deepEqual(completed.financingClaims[0],initial.financingClaims[0]);
    assert.equal(completed.financingReview.coverage.verified,2);
    assert.equal(completed.financingReview.followup.added,1);
    assert.equal(await runFinancingBatch(),"idle");
    assert.equal(provider.hits(),2);

    // A joint announcement with just one headline still enters the ordinary news-category sweep.
    const round=await article("【星辰完成A轮及A+轮融资】星辰完成A轮融资。星辰完成A+轮融资。此前完成天使轮融资。");
    await runFinancingBatch();
    const short=await output(round.analysis);
    assert.deepEqual(short.financingReview.coverage.missing.map((x:{rounds:string[]})=>x.rounds),[["a+"]]);
    await runFinancingBatch();
    assert.deepEqual((await output(round.analysis)).financingClaims.map((c:typeof a)=>c.round),["A轮","A+轮"]);

    // A retry that repeats A cannot satisfy A+. Missing source evidence stays
    // visible and the next sweep does not schedule a third model request.
    const repeated=await article("【星辰完成A轮及A+轮融资】星辰完成A轮融资。星辰完成A+轮融资。");
    repeatKnownRound=true;
    await runFinancingBatch();
    await runFinancingBatch();
    const partial=await output(repeated.analysis);
    assert.deepEqual(partial.financingClaims.map((c:typeof a)=>c.round),["A轮"]);
    assert.deepEqual(partial.financingReview.coverage.missing[0].rounds,["a+"]);
    assert.equal(await runFinancingBatch(),"idle");
    repeatKnownRound=false;

    // The parent can report complete coverage for its recognized headings while
    // omitting another financing whose recipient/terms are only named in the body.
    const mixed=await article("【甲科技完成A轮融资】"+first+"【星岛跻身独角兽】星岛宣布完成A轮融资，由甲基金领投。","创投日报");
    await runFinancingBatch();
    const mixedParent=await output(mixed.analysis);
    assert.deepEqual(mixedParent.financingReview.coverage.missing,[{heading:"星岛跻身独角兽"}]);
    await runFinancingBatch();
    assert.deepEqual((await output(mixed.analysis)).financingClaims.map((c:typeof a)=>c.company),["甲科技","星岛"]);
    const only=await article("【星岛跻身独角兽】星岛宣布完成A轮融资，由甲基金领投。","创投日报");
    await runFinancingBatch();
    assert.equal((await output(only.analysis)).financingReview.coverage.verified,1);
    assert.equal(await runFinancingBatch(),"idle");

    const blocked=await article();
    await runFinancingBatch();
    const blockedParent=await output(blocked.analysis);
    const subject="financing-batch:"+blockedParent.financingReview.followup.batchId;
    const [receipt]=await sql`INSERT INTO receipts(logical_key,purpose,subject,service,status,request)
      VALUES (${tag()},'financing_extract',${subject},'llm','unknown','{"promptVersion":"financing-digest-missing-v1"}') RETURNING id`;
    const hits=provider.hits();
    await assert.rejects(runFinancingBatch(),ReceiptUnknownError);
    assert.equal(provider.hits(),hits);
    const response={choices:[{message:{content:JSON.stringify({results:[{id:-2,claims:[b]}]})}}]};
    await sql`UPDATE receipts SET status='received',response=${sql.json(response)} WHERE id=${receipt!.id}`;
    await due(blockedParent.financingReview.followup.batchId);
    await runFinancingBatch();
    assert.equal((await output(blocked.analysis)).financingReview.followup.receiptId,receipt!.id);
    assert.equal(provider.hits(),hits);

    const manual=await article();
    await runFinancingBatch();
    const old=await output(manual.analysis),before=provider.hits();
    await sql`INSERT INTO financing_round_sources(article_id,company,evidence,round_id)
      VALUES (${manual.article},'甲科技',${first},gen_random_uuid())`;
    assert.equal(await runFinancingBatch(),"completed");
    assert.deepEqual((await output(manual.analysis)).financingClaims,old.financingClaims);
    assert.equal(provider.hits(),before);
    assert.equal(await runFinancingBatch(),"idle");
  } finally {
    if(originalBudget) await sql`UPDATE budgets SET per_minute=${originalBudget.per_minute} WHERE service='deepseek'`;
    if(previousStart) await sql`UPDATE settings SET value=${sql.json(previousStart.value)} WHERE key='financing.daily-start-analysis'`;
    else await sql`DELETE FROM settings WHERE key='financing.daily-start-analysis'`;
    const owned = await sql`SELECT id FROM financing_extraction_batches b WHERE EXISTS (
      SELECT 1 FROM jsonb_array_elements(b.material) m JOIN analyses an
      ON an.id=coalesce((m#>>'{repair,analysisId}')::bigint,(m->>'id')::bigint)
      JOIN articles a ON a.id=an.article_id WHERE a.source_id=${src})`;
    if(owned.length){
      const ids=owned.map(b=>Number(b.id));
      await sql`DELETE FROM receipts WHERE purpose='financing_extract' AND subject IN ${sql(ids.map(id=>"financing-batch:"+id))}`;
      await sql`DELETE FROM financing_extraction_batches WHERE id IN ${sql(ids)}`;
    }
    await sql`DELETE FROM articles WHERE source_id=${src}`;
    await sql`DELETE FROM sources WHERE id=${src}`;
    await provider.close();
  }
});
