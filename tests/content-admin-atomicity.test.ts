import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { setVisibility, overrideFields, setSeoIndexed, rerun } from "@aihot/backend/admin/content";
import { Conflict } from "@aihot/backend/admin/sources";
import { ensureQueue, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { config } from "@aihot/backend/config";
import { buildApp } from "../apps/api/src/app.ts";

const source = `content-atomic-${tag()}`, ids: string[] = [];
before(async () => {
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at) VALUES(${source},${source},'rss','T1','editorial','2100-01-01')`;
  for (const queue of [QUEUES.analyze, QUEUES.extractBody, QUEUES.group, "cron.hot.rank"]) await ensureQueue(queue);
});
after(async () => {
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=ANY(${ids}::text[]) OR singleton_key=ANY(${ids.map(id=>`publication:${id}`)}::text[])`;
  await sql`DELETE FROM audit_log WHERE subject=ANY(${ids.map(id=>`content:${id}`)}::text[])`;
  await sql`DELETE FROM articles WHERE id=ANY(${ids}::text[])`;
  await sql`DELETE FROM sources WHERE id=${source}`;
  await stopBoss(); await closeDb();
});
async function article() {
  const { articleId: id } = await upsertMaterial({sourceId:source,url:`https://example.org/atomic/${tag()}`,title:"原文标题",bodyText:"当前正文",bodyStatus:"ok",via:"fetch",publishedAt:new Date()});
  ids.push(id);
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected) VALUES(${id},1,'rule','pass','原始标题','原始摘要',90,true)`;
  await publishArticle(id,{releasedAt:new Date(Date.now()-60000)});
  return id;
}
async function state(id: string) {
  return {
    article:(await sql`SELECT * FROM articles WHERE id=${id}`)[0],
    override:await sql`SELECT * FROM editorial_overrides WHERE article_id=${id}`,
    publication:await sql`SELECT * FROM publications WHERE article_id=${id}`,
    ledger:await sql`SELECT * FROM selected_ledger WHERE article_id=${id} ORDER BY seq`,
    grouping:await sql`SELECT * FROM grouping_overrides WHERE article_id=${id}`,
    pending:await sql`SELECT * FROM regroup_pending WHERE article_id=${id}`,
    audit:await sql`SELECT * FROM audit_log WHERE subject=${`content:${id}`} ORDER BY id`,
    jobs:await sql`SELECT id,name,data,state FROM pgboss.job WHERE data->>'articleId'=${id} OR singleton_key=${`publication:${id}`} ORDER BY id`,
  };
}
async function failAt(table: "audit_log" | "publications" | "pgboss.job", id: string, fn:()=>Promise<unknown>) {
  const name=`content_atomic_${tag()}`;
  const condition=table==='audit_log'?`NEW.subject='content:${id}'`:table==='publications'?`NEW.article_id='${id}'`:`NEW.singleton_key='publication:${id}'`;
  await sql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'injected content admin failure'; END IF; RETURN NEW; END $$`);
  await sql.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try { await assert.rejects(fn,/injected content admin failure/); }
  finally { await sql.unsafe(`DROP TRIGGER ${name} ON ${table}`); await sql.unsafe(`DROP FUNCTION ${name}()`); }
}
test("a visibility audit failure rolls back the override, projection, sync ledger and ranking job",async()=>{
  const id=await article(), before=await state(id);
  await failAt('audit_log',id,()=>setVisibility(id,{visibility:'withdrawn',reason:'test',version:0},'test'));
  assert.deepEqual(await state(id),before);
});
test("a failed publication write leaves no manual correction",async()=>{
  const id=await article(),before=await state(id);
  await failAt('publications',id,()=>overrideFields(id,{fields:{title:'新标题'},reason:'test',version:0},'test'));
  assert.deepEqual(await state(id),before);
});
test("an override audit failure rolls back both the manual input and public text",async()=>{
  const id=await article(),before=await state(id);
  await failAt('audit_log',id,()=>overrideFields(id,{fields:{title:'新标题',summary:'新摘要'},reason:'test',version:0},'test'));
  assert.deepEqual(await state(id),before);
});
test("a search-index audit failure restores all indexing fields",async()=>{
  const id=await article(),before=await state(id);
  await failAt('audit_log',id,()=>setSeoIndexed(id,{indexed:false,reason:'test'},'test'));
  assert.deepEqual(await state(id),before);
});
test("a failed ranking enqueue cannot partially withdraw the article",async()=>{
  const id=await article(),before=await state(id);
  await failAt('pgboss.job',id,()=>setVisibility(id,{visibility:'withdrawn',reason:'test',version:0},'test'));
  assert.deepEqual(await state(id),before);
});
test("a regroup audit failure preserves the old manual decision and creates no pending task",async()=>{
  const id=await article();
  await sql`INSERT INTO grouping_overrides(article_id,reason,actor) VALUES(${id},'keep standalone','test')`;
  const before=await state(id);
  await failAt('audit_log',id,()=>rerun(id,'group',`request-${tag()}`,'test'));
  assert.deepEqual(await state(id),before);
});
test("an analysis or extraction audit failure restores the processing handoff and body status",async()=>{
  for (const step of ['analyze','extract'] as const) {
    const id=await article();await sql`UPDATE articles SET processing_state='analyzed' WHERE id=${id}`;
    const before=await state(id);
    await failAt('audit_log',id,()=>rerun(id,step,`request-${tag()}`,'test'));
    assert.deepEqual(await state(id),before,step);
  }
});
test("the same manual request remains idempotent after its first job completes",async()=>{
  for (const step of ['group','analyze','extract'] as const) {
    const id=await article(),requestId=`request-${tag()}`;
    const first=await rerun(id,step,requestId,'test');assert.ok(first!.jobId);
    await sql`UPDATE pgboss.job SET state='completed',completed_on=now() WHERE id=${first!.jobId}`;
    const before=await state(id);
    assert.deepEqual(await rerun(id,step,requestId,'test'),first);
    assert.deepEqual(await state(id),before,step);
  }
});
test("concurrent corrections keep optimistic versions and reject the losing tab",async()=>{
  const id=await article();
  const result=await Promise.allSettled(['甲','乙'].map(title=>overrideFields(id,{fields:{title},reason:'test',version:0},'test')));
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  const rejected=result.find(r=>r.status==='rejected');assert.ok(rejected?.status==='rejected' && rejected.reason instanceof Conflict);
  const current=await state(id);assert.equal(current.override[0]!.version,1);assert.equal(current.audit.length,1);
  assert.equal(current.publication[0]!.title,current.override[0]!.fields.title);
});
test("concurrent retries of one rerun command commit just one handoff and audit",async()=>{
  const id=await article(),requestId=`request-${tag()}`,before=await state(id);
  const results=await Promise.all(Array.from({length:5},()=>rerun(id,'analyze',requestId,'test')));
  assert.ok(results[0]!.jobId);
  for (const result of results) assert.deepEqual(result,results[0]);
  const current=await state(id);
  assert.equal(current.article!.processing_generation,before.article!.processing_generation+1);
  assert.equal(current.jobs.length,1);assert.equal(current.audit.length,1);
});
test("admin HTTP corrections publish current text, withdrawals hide it, and invalid reruns change nothing",async()=>{
  const original={devAdmin:config.devAdmin,environmentName:config.environmentName};
  config.devAdmin={displayName:'Content Test'};config.environmentName='development';
  const app=await buildApp(),id=await article(),headers={'x-csrf-token':'dev'};
  try {
    const edited=await app.inject({method:'POST',url:`/api/admin/content/${id}/override`,headers,payload:{fields:{title:'HTTP 当前标题'},reason:'test',version:0}});
    assert.equal(edited.statusCode,200,edited.body);
    assert.ok((await app.inject({url:`/api/site/items/${id}`})).body.includes('HTTP 当前标题'));
    assert.ok((await app.inject({url:'/api/v1/items?mode=selected'})).body.includes('HTTP 当前标题'));
    const before=await state(id);
    const invalid=await app.inject({method:'POST',url:`/api/admin/content/${id}/rerun`,headers:{...headers,'idempotency-key':`request-${tag()}`},payload:{step:'invalid'}});
    assert.equal(invalid.statusCode,400,invalid.body);assert.deepEqual(await state(id),before);
    for (const [operation,payload] of [['visibility',{visibility:'invalid',reason:'test',version:1}],['seo',{indexed:'false',reason:'test'}]] as const) {
      const rejected=await app.inject({method:'POST',url:`/api/admin/content/${id}/${operation}`,headers,payload});
      assert.equal(rejected.statusCode,400,rejected.body);assert.deepEqual(await state(id),before);
    }
    const missing=await app.inject({method:'POST',url:`/api/admin/content/missing-${tag()}/visibility`,headers,payload:{visibility:'withdrawn',reason:'test',version:0}});
    assert.equal(missing.statusCode,404,missing.body);
    const withdrawn=await app.inject({method:'POST',url:`/api/admin/content/${id}/visibility`,headers,payload:{visibility:'withdrawn',reason:'test',version:1}});
    assert.equal(withdrawn.statusCode,200,withdrawn.body);
    assert.equal((await app.inject({url:`/api/site/items/${id}`})).statusCode,404);
    assert.ok(!(await app.inject({url:'/api/v1/items?mode=selected'})).body.includes(id));
    assert.equal((await state(id)).audit.length,2);
  }finally{await app.close();Object.assign(config,original);}
});
