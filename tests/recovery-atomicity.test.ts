import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after,before,test } from 'node:test';
import postgres from 'postgres';
import { sql,closeDb } from '@aihot/backend/db';
import { config } from '@aihot/backend/config';
import { upsertMaterial } from '@aihot/backend/content/materials';
import { paidRequest } from '@aihot/backend/providers/receipts';
import { autoReleaseUnknownReceipts,confirmZeroCostReceipts,releaseReceipt,requeueFailedArticles } from '@aihot/backend/admin/runs';
import { failureGroupSql,sweepUnprocessed } from '@aihot/backend/jobs/content';
import { ensureQueue,QUEUES,stopBoss } from '@aihot/backend/jobs/queue';
import { buildApp } from '../apps/api/src/app.ts';

const prefix=`recovery-atomic-${tag()}`,actor=`test:${prefix}`,articles:string[]=[],receipts:number[]=[];
const control=postgres(process.env.DATABASE_URL!,{max:1,onnotice:()=>{}});
before(async()=>{
 await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at) VALUES(${prefix},${prefix},'rss','T1','editorial','2100-01-01')`;
 await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES(${prefix},100000,100000,100000)`;
 for(const q of [QUEUES.analyze,QUEUES.extractBody,QUEUES.group,QUEUES.digest])await ensureQueue(q);
});
after(async()=>{
 await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=ANY(${articles}::text[])`;
 await sql`DELETE FROM audit_log WHERE actor=${actor} OR subject=ANY(${receipts.map(id=>`receipt:${id}`)}::text[])`;
 await sql`DELETE FROM model_fallback_routes WHERE primary_receipt_id=ANY(${receipts}::bigint[])`;
 await sql`DELETE FROM receipts WHERE id=ANY(${receipts}::bigint[])`;
 await sql`DELETE FROM articles WHERE id=ANY(${articles}::text[])`;
 await sql`DELETE FROM sources WHERE id=${prefix}`;await sql`DELETE FROM budgets WHERE service=${prefix}`;
 await stopBoss();await control.end();await closeDb();
});
async function article(error=`transient ${prefix}-${tag()}`){
 const {articleId:id}=await upsertMaterial({sourceId:prefix,url:`https://example.org/${prefix}/${tag()}`,title:'recovery fixture',bodyText:'test body',bodyStatus:'ok',via:'fetch',publishedAt:new Date()});
 articles.push(id);await sql`UPDATE articles SET processing_state='failed',processing_error=${error},processing_attempts=3 WHERE id=${id}`;return id;
}
async function lost(id?:string,revision=1){
 const subject=id ? `article:${id}@${revision}` : `${prefix}:${tag()}`;
 await assert.rejects(paidRequest({service:prefix,model:'test',purpose:id?'prefilter_article':'recovery_fixture',subject,identity:tag()},async()=>{throw new Error('fetch failed');}));
 const [row]=await sql<{id:number;updated_at:Date}[]>`SELECT id,updated_at FROM receipts WHERE subject=${subject} ORDER BY id DESC LIMIT 1`;
 receipts.push(row!.id);return{id:row!.id,version:row!.updated_at.toISOString()};
}
async function state(id:string,rid:number){return{
 article:await sql`SELECT * FROM articles WHERE id=${id}`,
 receipt:await sql`SELECT * FROM receipts WHERE id=${rid}`,
 attempts:await sql`SELECT * FROM receipt_attempts WHERE receipt_id=${rid}`,
 jobs:await sql`SELECT * FROM pgboss.job WHERE data->>'articleId'=${id} ORDER BY id`,
 audit:await sql`SELECT * FROM audit_log WHERE subject=${`receipt:${rid}`} ORDER BY id`,
};}
async function fault(table:'audit_log'|'pgboss.job',id:string,rid:number,fn:()=>Promise<unknown>){
 const name=`recovery_atomic_${tag()}`,condition=table==='audit_log'?`NEW.actor='${actor}'`:`NEW.data->>'articleId'='${id}'`;
 await sql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'injected recovery failure'; END IF; RETURN NEW; END $$`);
 await sql.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
 try{await assert.rejects(fn,/injected recovery failure/);}finally{await sql.unsafe(`DROP TRIGGER ${name} ON ${table}`);await sql.unsafe(`DROP FUNCTION ${name}()`);}
}
const key=()=>`recovery-${tag()}`;
const groupFor=async(id:string)=>(await sql`SELECT ${failureGroupSql()} AS error FROM articles WHERE id=${id}`)[0]!.error as string;
for(const table of ['audit_log','pgboss.job'] as const){
 test(`a release ${table} failure rolls back the receipt, attempt, business handoff and queue`,async()=>{
  const id=await article(),r=await lost(id),before=await state(id,r.id);
  await fault(table,id,r.id,()=>releaseReceipt(r.id,{billed:false,note:'test',version:r.version},actor,{requestId:key()}));
  assert.deepEqual(await state(id,r.id),before);
 });
 test(`a bulk ${table} failure preserves every failure and generation`,async()=>{
  const id=await article(),before=await state(id,0),group=await groupFor(id);
  await fault(table,id,0,()=>requeueFailedArticles({group,reason:'test'},actor,{requestId:key()}));
  assert.deepEqual(await state(id,0),before);
 });
}
test('release retries return the original result even after a later unknown attempt',async()=>{
 const id=await article(),r=await lost(id),requestId=key(),input={billed:false,note:'test',version:r.version};
 const first=await releaseReceipt(r.id,input,actor,{requestId});assert.equal(first!.requeued,true);
 await sql`UPDATE pgboss.job SET state='completed',completed_on=now() WHERE data->>'articleId'=${id}`;
 await sql`UPDATE receipts SET status='unknown',updated_at=now(),attempts=attempts+1 WHERE id=${r.id}`;
 const before=await state(id,r.id);
 assert.deepEqual(await releaseReceipt(r.id,input,actor,{requestId}),first);
 assert.deepEqual(await state(id,r.id),before);
 await assert.rejects(releaseReceipt(r.id,{...input,note:'changed'},actor,{requestId}),/参数已改变/);
 assert.deepEqual(await state(id,r.id),before);
});
test('concurrent releases with one command commit one attempt note and one handoff',async()=>{
 const id=await article(),r=await lost(id),requestId=key();
 const results=await Promise.all([1,2].map(()=>releaseReceipt(r.id,{billed:false,note:'test',version:r.version},actor,{requestId})));
 assert.deepEqual(results[0],results[1]);const after=await state(id,r.id);
 assert.equal(after.jobs.length,1);assert.equal(after.audit.length,1);assert.ok(after.attempts[0]!.released_at);
 assert.equal(after.attempts[0]!.status,'unknown');assert.ok(after.attempts[0]!.error);
});
test('bulk recovery excludes current unknowns but does not confuse an older revision with current input',async()=>{
 const message=`mixed ${prefix}-${tag()}`,known=await article(message),unknown=await article(message),stale=await article(message);
 const r=await lost(unknown),old=await lost(stale,0),unknownBefore=await state(unknown,r.id),group=await groupFor(known);
 const result=await requeueFailedArticles({group,reason:'test'},actor,{requestId:key()});
 assert.deepEqual(result,{requeued:2,enqueued:2,skippedUnknown:1});assert.deepEqual(await state(unknown,r.id),unknownBefore);
 assert.equal((await state(stale,old.id)).article[0]!.processing_state,'new');
});
test('an unknown-outcome error is preserved even when its receipt record is unavailable',async()=>{
 const id=await article(`receipt outcome unknown ${prefix}`),before=await state(id,0);
 const result=await requeueFailedArticles({group:await groupFor(id),reason:'test'},actor,{requestId:key()});
 assert.deepEqual(result,{requeued:0,enqueued:0,skippedUnknown:1});assert.deepEqual(await state(id,0),before);
});
test('bulk command replay cannot restart articles that failed again after processing',async()=>{
 const id=await article(),group=await groupFor(id),requestId=key(),input={group,reason:'test'};
 const first=await requeueFailedArticles(input,actor,{requestId});
 await sql`UPDATE pgboss.job SET state='completed',completed_on=now() WHERE data->>'articleId'=${id}`;
 await sql`UPDATE articles SET processing_state='failed',processing_error=${group} WHERE id=${id}`;
 const before=await state(id,0);assert.deepEqual(await requeueFailedArticles(input,actor,{requestId}),first);assert.deepEqual(await state(id,0),before);
 await assert.rejects(requeueFailedArticles({...input,reason:'changed'},actor,{requestId}),/参数已改变/);
 assert.deepEqual(await state(id,0),before);
});
test('large recovery commits 500 initial jobs and leaves the remaining handoff for the normal sweep',async()=>{
 const message=`batch ${prefix}-${tag()}`,batch:string[]=[];
 for(let i=0;i<501;i++)batch.push(await article(message));
 await sql`UPDATE articles SET created_at=now()-interval '4 minutes' WHERE id=ANY(${batch}::text[])`;
 const group=await groupFor(batch[0]!);
 assert.deepEqual(await requeueFailedArticles({group,reason:'test'},actor,{requestId:key()}),{requeued:501,enqueued:500,skippedUnknown:0});
 const [pending]=await sql<{id:string;processing_generation:number}[]>`SELECT id,processing_generation FROM articles WHERE id=ANY(${batch}::text[]) AND processing_queued_at IS NULL`;
 assert.ok(pending);assert.equal(pending.processing_generation,1);
 await sweepUnprocessed();
 const jobs=await sql`SELECT data FROM pgboss.job WHERE data->>'articleId'=ANY(${batch}::text[])`;
 assert.equal(jobs.length,501);assert.equal((await sql`SELECT * FROM articles WHERE id=ANY(${batch}::text[]) AND processing_queued_at IS NULL`).length,0);
});
test('a confirmed zero-cost receipt cannot be released by the ordinary recovery action',async()=>{
 const id=await article(),r=await lost(id);await confirmZeroCostReceipts({receiptIds:[r.id],note:'test zero cost'},actor);
 const before=await state(id,r.id);await assert.rejects(releaseReceipt(r.id,{billed:true,note:'test',version:r.version},actor,{requestId:key()}),/已确认计费/);
 assert.deepEqual(await state(id,r.id),before);
});
test('automatic release rechecks a billing confirmation committed after its candidate scan',async()=>{
 const r=await lost();await sql`UPDATE receipts SET updated_at=now()-interval '31 minutes' WHERE id=${r.id}`;
 let recovery:Promise<unknown>|undefined;
 await control.begin(async tx=>{
  await tx`SELECT id FROM receipts WHERE id=${r.id} FOR UPDATE`;
  recovery=autoReleaseUnknownReceipts();
  const deadline=Date.now()+5000;let waiting=false;
  while(Date.now()<deadline){
   const [row]=await tx`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query ILIKE '%receipts%') AS waiting`;
   if(row!.waiting){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(waiting,'automatic recovery reached the locked receipt');
  await tx`UPDATE receipts SET billing_review='{"billed":true,"amount":0}'::jsonb WHERE id=${r.id}`;
 });
 await recovery;assert.equal((await sql`SELECT status FROM receipts WHERE id=${r.id}`)[0]!.status,'unknown');
 assert.equal((await sql`SELECT * FROM audit_log WHERE subject=${`receipt:${r.id}`} AND action='receipt.release'`).length,0);
});
test('HTTP recovery rejects missing command IDs, invalid billing flags and stale versions without writes',async()=>{
 const previous={devAdmin:config.devAdmin,environmentName:config.environmentName};config.devAdmin={displayName:'Recovery Test'};config.environmentName='development';
 const app=await buildApp(),id=await article(),r=await lost(id),before=await state(id,r.id),headers={'x-csrf-token':'dev','idempotency-key':key()};
 try{
  const url=`/api/admin/receipts/${r.id}/release`;
  for(const input of [
   {headers:{'x-csrf-token':'dev'},payload:{billed:false,note:'test',version:r.version,attempts:1}},
   {headers,payload:{billed:'false',note:'test',version:r.version,attempts:1}},
   {headers,payload:{billed:false,note:'test',attempts:1}},
   {headers,payload:{billed:false,note:'test',version:r.version}},
  ]) assert.equal((await app.inject({method:'POST',url,...input})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url,headers,payload:{billed:false,note:'test',version:'2000-01-01T00:00:00.000Z',attempts:1}})).statusCode,409);
  assert.deepEqual(await state(id,r.id),before);
  const payload={billed:false,note:'test',version:r.version,attempts:1};const first=await app.inject({method:'POST',url,headers,payload});assert.equal(first.statusCode,200,first.body);
  const second=await app.inject({method:'POST',url,headers,payload});assert.equal(second.statusCode,200,second.body);assert.deepEqual(second.json(),first.json());
 }finally{await app.close();Object.assign(config,previous);}
});
test('a later attempt cannot use the old billing decision even with an identical page timestamp',async()=>{
 const id=await article(),r=await lost(id);
 await sql.begin(async tx=>{
  await tx`UPDATE receipts SET attempts=2,updated_at=${r.version}::timestamptz WHERE id=${r.id}`;
  await tx`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status,error) VALUES(${r.id},2,${prefix},'test','unknown','later fixture loss')`;
 });
 const before=await state(id,r.id);
 await assert.rejects(releaseReceipt(r.id,{billed:false,note:'test',version:r.version,attempts:1},actor,{requestId:key()}),/新的请求尝试/);
 assert.deepEqual(await state(id,r.id),before);
});
