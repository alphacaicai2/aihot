// Hold real provider/extraction responses while a new revision or admin request takes ownership.
import { gate, Reply, stub, tag } from './setup.ts';
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import type { PgBoss } from 'pg-boss';
import { config } from '@aihot/backend/config';
import { sql, closeDb } from '@aihot/backend/db';
import { upsertMaterial } from '@aihot/backend/content/materials';
import { queueProcessing, registerContentJobs, registerExtractionJobs } from '@aihot/backend/jobs/content';
import { analyzeArticle } from '@aihot/backend/editorial/analyze';
import { publishArticle } from '@aihot/backend/publication/publish';
import { QUEUES,getBoss,stopBoss,shutdownSignal } from '@aihot/backend/jobs/queue';

const source=`ownership-${tag()}`;
let active: { asked:ReturnType<typeof gate<void>>; answer:ReturnType<typeof gate<void>>; failure:boolean };
let page: { asked:ReturnType<typeof gate<void>>; answer:ReturnType<typeof gate<void>>; body:string; reset:boolean };
const provider=await stub(async (_hit,req)=>{
  const current=active;current.asked.open();await current.answer.promise;
  if(current.failure) return new Reply(503,{error:'temporary provider outage'});
  return {id:'ownership-stub',choices:[{message:{content:JSON.stringify({label:'BLOCK',reason:'not industry news'})}}],usage:{prompt_tokens:10,completion_tokens:10}};
});
const pageServer=http.createServer(async (_req,res)=>{
  page.asked.open(); await page.answer.promise;
  if(page.reset){res.destroy();return;}
  res.writeHead(200,{'content-type':'text/html'});res.end(page.body);
});
await new Promise<void>(resolve=>pageServer.listen(0,'127.0.0.1',resolve));
const pageUrl=`http://127.0.0.1:${(pageServer.address() as {port:number}).port}`;
process.env.DASHSCOPE_BASE_URL=`${provider.url}/v1`;process.env.DASHSCOPE_API_KEY='test-key';
process.env.JINA_BASE_URL=provider.url;process.env.JINA_API_KEY='test-key';
process.env.JINA_BODY_FALLBACK='false';config.allowPrivateNetworkFetch=true;
type Handler=(jobs:Array<{data:{articleId:string;attemptTag?:string}}>)=>Promise<any>;
const handlers=new Map<string,Handler>();
const registration={work:async (name:string,_opts:unknown,handler:Handler)=>{handlers.set(name,handler);}} as unknown as PgBoss;
before(async()=>{
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at) VALUES (${source},'Ownership tests','rss','T1','editorial','2100-01-01')`;
  await sql`UPDATE budgets SET per_minute=1000,per_hour=10000,per_day=100000 WHERE service IN ('dashscope','jina')`;
  await registerContentJobs(registration,1);await registerExtractionJobs(registration);
});
after(async()=>{active?.answer.open();page?.answer.open();await provider.close();await new Promise<void>(resolve=>pageServer.close(()=>resolve()));await stopBoss();await closeDb();});
const invoke=(name:string,id:string)=>handlers.get(name)!([{data:{articleId:id}}]);
function model(failure=false){active={asked:gate(),answer:gate(),failure};return active;}
function body(reset=false,text='Old extracted body. '.repeat(40)){page={asked:gate(),answer:gate(),reset,body:`<html><head><title>Article</title></head><body><article><h1>Article</h1><p>${text}</p></article></body></html>`};return page;}
async function article(pending=false){
  const material={sourceId:source,url:pending?`${pageUrl}/${tag()}`:`https://example.org/ownership/${tag()}`,title:'Old input',bodyText:pending?null:'An unrelated report with sufficient text for judging.',bodyStatus:pending?'pending' as const:'ok' as const,via:'fetch' as const,publishedAt:new Date()};
  const {articleId}=await upsertMaterial(material);await queueProcessing(articleId);return {id:articleId,material};
}
async function snapshot(id:string){const [row]=await sql`SELECT revision,title,body_text,body_status,processing_state,processing_error,processing_attempts,processing_generation,processing_retry_at::text,processing_queued_at::text FROM articles WHERE id=${id}`;return {...row};}
async function supersede(f:Awaited<ReturnType<typeof article>>){
  await upsertMaterial({...f.material,title:'New input',bodyText:'New authoritative body',bodyStatus:'ok'});
  await queueProcessing(f.id);
  await sql`UPDATE articles SET processing_attempts=2,processing_error='new revision is waiting',processing_retry_at=now()+interval '20 minutes' WHERE id=${f.id}`;
  return snapshot(f.id);
}

test('an old successful analysis keeps its history without clearing the newer revision queue or retry',async()=>{
  const f=await article(),hold=model();const running=invoke(QUEUES.analyze,f.id);await hold.asked.promise;
  const expected=await supersede(f);hold.answer.open();assert.equal((await running).state,'stale');
  assert.deepEqual(await snapshot(f.id),expected);
  assert.equal((await sql`SELECT count(*)::int AS n FROM analyses WHERE article_id=${f.id} AND input_revision=1`)[0]!.n,1);
});
test('a late provider failure cannot count against or reschedule the newer revision',async()=>{
  const f=await article(),hold=model(true);const running=invoke(QUEUES.analyze,f.id);await hold.asked.promise;
  const expected=await supersede(f);hold.answer.open();await running;assert.deepEqual(await snapshot(f.id),expected);
});
test('a newer manual re-evaluation of the same revision supersedes an older answer',async()=>{
  const f=await article(),hold=model();const running=invoke(QUEUES.analyze,f.id);await hold.asked.promise;
  await queueProcessing(f.id,{step:'analyze',attemptTag:`admin:${tag()}`});const expected=await snapshot(f.id);
  hold.answer.open();assert.equal((await running).state,'stale');assert.deepEqual(await snapshot(f.id),expected);
});
test('routing analysis to extraction preserves the queued extraction handoff',async()=>{
  const f=await article(true);const hits=provider.hits();assert.equal((await invoke(QUEUES.analyze,f.id)).state,'fetching-body');
  assert.ok((await snapshot(f.id)).processing_queued_at);assert.equal(provider.hits(),hits);
});
test('a late extracted body cannot replace a newer feed body or its processing state',async()=>{
  const f=await article(true),hold=body();const running=invoke(QUEUES.extractBody,f.id);await hold.asked.promise;
  const expected=await supersede(f);hold.answer.open();assert.equal((await running).state,'stale');assert.deepEqual(await snapshot(f.id),expected);
});
test('a late extraction error cannot consume attempts or downgrade a newer body',async()=>{
  process.env.JINA_BODY_FALLBACK='true';const f=await article(true),web=body(true),hold=model(true);
  web.answer.open();const running=invoke(QUEUES.extractBody,f.id);await hold.asked.promise;
  const expected=await supersede(f);hold.answer.open();await running;assert.deepEqual(await snapshot(f.id),expected);
  process.env.JINA_BODY_FALLBACK='false';
});
test('current provider failures still back off, and a successful retry clears its own bookkeeping',async()=>{
  const f=await article(),failed=model(true);failed.answer.open();assert.equal((await invoke(QUEUES.analyze,f.id)).state,'retrying');
  assert.equal((await snapshot(f.id)).processing_attempts,1);assert.ok((await snapshot(f.id)).processing_retry_at);
  await queueProcessing(f.id);const success=model();success.answer.open();assert.equal((await invoke(QUEUES.analyze,f.id)).state,'block');
  const current=await snapshot(f.id);assert.equal(current.processing_state,'blocked');assert.equal(current.processing_attempts,0);assert.equal(current.processing_retry_at,null);assert.equal(current.processing_queued_at,null);
});
test('successful extraction commits one body revision and hands analysis its own queue marker',async()=>{
  const f=await article(true),hold=body(false,'Current extracted body. '.repeat(40));hold.answer.open();
  assert.equal((await invoke(QUEUES.extractBody,f.id)).state,'ok');const current=await snapshot(f.id);
  assert.equal(current.revision,2);assert.match(current.body_text,/Current extracted body/);assert.ok(current.processing_queued_at);
});
test('an obsolete unknown outcome stays on its receipt without failing the newer input',async()=>{
  const f=await article(),hold=body(true);process.env.DASHSCOPE_BASE_URL=`${pageUrl}/v1`;
  try {
    const running=invoke(QUEUES.analyze,f.id);await hold.asked.promise;const expected=await supersede(f);hold.answer.open();
    assert.equal((await running).state,'stale');assert.deepEqual(await snapshot(f.id),expected);
    const rows=await sql`SELECT status,error FROM receipts WHERE subject=${`article:${f.id}@1`} AND purpose='prefilter_article'`;
    assert.equal(rows.length,1);assert.equal(rows[0]!.status,'unknown');assert.ok(rows[0]!.error);
  } finally {process.env.DASHSCOPE_BASE_URL=`${provider.url}/v1`;}
});
test('obsolete pending manual jobs are rejected before making a paid request',async()=>{
  const f=await article();await queueProcessing(f.id,{step:'analyze',attemptTag:`admin:${tag()}`});
  const [old]=await sql`SELECT data FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'articleId'=${f.id} ORDER BY created_on DESC LIMIT 1`;
  await queueProcessing(f.id,{step:'analyze',attemptTag:`admin:${tag()}`});const expected=await snapshot(f.id),hits=provider.hits();
  assert.equal((await handlers.get(QUEUES.analyze)!([{data:old!.data}])).state,'stale');assert.equal(provider.hits(),hits);assert.deepEqual(await snapshot(f.id),expected);
});
test('a deduplicated pending job is promoted to the newest input and can process it',async()=>{
  const f=await article();const [old]=await sql`SELECT id,data FROM pgboss.job WHERE name=${QUEUES.analyze} AND singleton_key=${f.id} AND state='created'`;
  await supersede(f);const [pending]=await sql`SELECT id,data FROM pgboss.job WHERE name=${QUEUES.analyze} AND singleton_key=${f.id} AND state='created'`;
  assert.equal(pending!.id,old!.id);assert.equal(pending!.data.revision,2);assert.ok(pending!.data.generation>old!.data.generation);
  const hold=model();hold.answer.open();assert.equal((await handlers.get(QUEUES.analyze)!([{data:pending!.data}])).state,'block');
  assert.equal((await sql`SELECT input_revision FROM analyses WHERE article_id=${f.id}`)[0]!.input_revision,2);
});
test('rolling back a processing handoff leaves neither its ownership change nor its queue job',async()=>{
  const f=await article(),expected=await snapshot(f.id),attemptTag=`admin:${tag()}`;
  await assert.rejects(sql.begin(async tx=>{await queueProcessing(f.id,{step:'analyze',attemptTag,db:tx});throw new Error('rollback handoff');}),/rollback handoff/);
  assert.deepEqual(await snapshot(f.id),expected);assert.equal((await sql`SELECT id FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'attemptTag'=${attemptTag}`).length,0);
});
test('an older manual answer stays in history but can never become the publication judgement',async()=>{
  const f=await article(),oldHold=model(),oldRunning=invoke(QUEUES.analyze,f.id);await oldHold.asked.promise;
  const attemptTag=`admin:${tag()}`;await queueProcessing(f.id,{step:'analyze',attemptTag});
  const [queued]=await sql`SELECT data FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'attemptTag'=${attemptTag}`;
  const newHold=model();newHold.answer.open();assert.equal((await handlers.get(QUEUES.analyze)!([{data:queued!.data}])).state,'block');
  const [current]=await sql`SELECT id FROM analyses WHERE article_id=${f.id} ORDER BY id DESC LIMIT 1`;const expected=await snapshot(f.id);
  oldHold.answer.open();assert.equal((await oldRunning).state,'stale');assert.deepEqual(await snapshot(f.id),expected);
  const [old]=await sql`SELECT superseded FROM analyses WHERE article_id=${f.id} ORDER BY id DESC LIMIT 1`;assert.equal(old!.superseded,true);
  await publishArticle(f.id);assert.equal((await sql`SELECT analysis_id FROM publications WHERE article_id=${f.id}`)[0]!.analysis_id,current!.id);
});
test('a real pg-boss worker accepts the owned job payload and commits its result',async()=>{
  const queueNames=QUEUES as {analyze:string};const boss=await getBoss(),original=QUEUES.analyze,queue=`ownership.real-${tag()}`;await boss.createQueue(queue,{policy:'short'});queueNames.analyze=queue;
  try {
    const hold=model();hold.answer.open();await registerContentJobs(boss,1);const f=await article();
    const deadline=Date.now()+12000;let row;
    do {row=(await sql`SELECT state,data FROM pgboss.job WHERE name=${queue} AND data->>'articleId'=${f.id}`)[0];if(row?.state==='completed')break;
      await new Promise(resolve=>setTimeout(resolve,20));} while(Date.now()<deadline);
    assert.equal(row?.state,'completed');assert.ok(row!.data.generation>0);assert.equal((await snapshot(f.id)).processing_state,'blocked');
  } finally {await boss.offWork(queue);queueNames.analyze=original;}
});
test('a publication failure after analysis is retryable and reuses its completed paid judgement',async()=>{
  const f=await article(),name=`ownership_fail_${tag()}`,hold=model();hold.answer.open();
  await sql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.article_id='${f.id}' THEN RAISE EXCEPTION 'test publication unavailable'; END IF; RETURN NEW; END $$`);
  await sql.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON publications FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try {
    assert.equal((await invoke(QUEUES.analyze,f.id)).state,'retrying');const current=await snapshot(f.id);
    assert.equal(current.processing_state,'new');assert.equal(current.processing_attempts,1);assert.ok(current.processing_retry_at);
    assert.equal((await sql`SELECT count(*)::int AS n FROM analyses WHERE article_id=${f.id} AND NOT superseded`)[0]!.n,1);
  } finally {await sql.unsafe(`DROP TRIGGER ${name} ON publications`);await sql.unsafe(`DROP FUNCTION ${name}()`);}
  const hits=provider.hits();await queueProcessing(f.id);assert.equal((await invoke(QUEUES.analyze,f.id)).state,'block');
  assert.equal(provider.hits(),hits);assert.ok((await sql`SELECT article_id FROM publications WHERE article_id=${f.id}`)[0]);
});
test('restart after an analysis commit resumes publication without a paid request or duplicate judgement',async()=>{
  const f=await article(),hold=model();hold.answer.open();await analyzeArticle(f.id);
  assert.equal((await sql`SELECT article_id FROM publications WHERE article_id=${f.id}`).length,0);const hits=provider.hits();
  const [queued]=await sql`SELECT data FROM pgboss.job WHERE name=${QUEUES.analyze} AND singleton_key=${f.id} AND state='created'`;
  assert.equal((await handlers.get(QUEUES.analyze)!([{data:queued!.data}])).state,'block');
  assert.equal(provider.hits(),hits);assert.equal((await sql`SELECT count(*)::int AS n FROM analyses WHERE article_id=${f.id}`)[0]!.n,1);
  assert.ok((await sql`SELECT article_id FROM publications WHERE article_id=${f.id}`)[0]);
});
test('shutdown during a failed extraction leaves article retries to the queue process',async()=>{
  process.env.JINA_BODY_FALLBACK='true';const f=await article(true),web=body(true),hold=model(true);web.answer.open();
  const expected=await snapshot(f.id),running=invoke(QUEUES.extractBody,f.id);await hold.asked.promise;
  shutdownSignal.abort();hold.answer.open();await assert.rejects(running);assert.deepEqual(await snapshot(f.id),expected);
});
