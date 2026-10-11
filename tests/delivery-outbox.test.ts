import {tag,gate} from './setup.ts';
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import http from 'node:http';
import {sql,closeDb} from '@aihot/backend/db';
import {config} from '@aihot/backend/config';
import {resolveDelivery,runsOverview} from '@aihot/backend/admin/runs';
import {deliverContent,markStaleDeliveries} from '@aihot/backend/notify/deliver';
import {ensureQueue,stopBoss} from '@aihot/backend/jobs/queue';
import {upsertMaterial} from '@aihot/backend/content/materials';
import {publishArticle} from '@aihot/backend/publication/publish';
import {buildApp} from '../apps/api/src/app.ts';
import {FEATURES} from '@aihot/industry/features';

const prefix=`delivery-outbox-${tag()}`,actor=`test:${prefix}`,target=prefix,ids:number[]=[],articles:string[]=[];
const oldPush=config.feishuContentPushEnabled;
let hits=0,body='{"code":0}',status=200,hold:(()=>Promise<void>)|null=null,destroy=false,location:string|null=null;
const cards:unknown[]=[];
const server=http.createServer(async(req,res)=>{
 const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));hits++;cards.push(JSON.parse(Buffer.concat(chunks).toString()).card);
 if(hold)await hold();if(destroy){req.socket.destroy();return;}
 res.writeHead(status,{'content-type':'application/json',...(location?{location}:{})});res.end(body);
});
before(async()=>{
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 process.env.DELIVERY_OUTBOX_TEST_WEBHOOK=`http://127.0.0.1:${(server.address() as {port:number}).port}`;config.feishuContentPushEnabled=true;
 await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at) VALUES(${prefix},${prefix},'rss','T1','editorial','2100-01-01')`;
 await sql`INSERT INTO notify_targets(key,purpose,kind,enabled,config_ref) VALUES(${target},'content','feishu_webhook',true,'DELIVERY_OUTBOX_TEST_WEBHOOK')`;
 await ensureQueue('notify.delivery');
});
after(async()=>{
 config.feishuContentPushEnabled=oldPush;delete process.env.DELIVERY_OUTBOX_TEST_WEBHOOK;
 await sql`DELETE FROM pgboss.job WHERE data->>'deliveryId'=ANY(${ids.map(String)}::text[]) OR data->>'articleId'=ANY(${articles}::text[]) OR singleton_key=ANY(${articles.map(id=>`publication:${id}`)}::text[])`;
 await sql`DELETE FROM audit_log WHERE actor=${actor} OR subject=ANY(${ids.map(id=>`delivery:${id}`)}::text[])`;
 await sql`DELETE FROM deliveries WHERE target_key=${target}`;
 await sql`DELETE FROM monitor_events WHERE id LIKE ${`${prefix}%`}`;await sql`DELETE FROM monitor_posts WHERE id LIKE ${`${prefix}%`}`;
 await sql`DELETE FROM articles WHERE id=ANY(${articles}::text[])`;await sql`DELETE FROM sources WHERE id=${prefix}`;await sql`DELETE FROM notify_targets WHERE key=${target}`;
 await stopBoss();await closeDb();await new Promise<void>(resolve=>server.close(()=>resolve()));
});
const key=()=>`delivery-${tag()}`;
async function article(){
 const {articleId:id}=await upsertMaterial({sourceId:prefix,url:`https://example.org/${prefix}/${tag()}`,title:'test news',bodyText:'test body',bodyStatus:'ok',via:'fetch',publishedAt:new Date()});articles.push(id);
 await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected) VALUES(${id},1,'rule','pass','original title','original summary',95,true)`;
 await publishArticle(id,{releasedAt:new Date(Date.now()-60000)});return id;
}
async function fixture(){
 const articleId=await article();const [r]=await sql`INSERT INTO deliveries(target_key,subject_kind,subject_id,dedupe_key,status,attempts,payload,content_at)
  VALUES(${target},'selected',${articleId},${tag()},'unknown',1,'{"old":true}',now()) RETURNING id`;
 ids.push(r!.id);return {id:Number(r!.id),articleId};
}
async function input(id:number,outcome:'sent'|'drop'|'resend'='resend'){
 const [r]=await sql`SELECT * FROM deliveries WHERE id=${id}`;
 return {outcome,note:'test',version:r!.updated_at.toISOString(),attempts:r!.attempts as number,generation:r!.dispatch_generation as number};
}
async function state(id:number){return{row:(await sql`SELECT * FROM deliveries WHERE id=${id}`)[0],attempts:await sql`SELECT * FROM delivery_attempts WHERE delivery_id=${id} ORDER BY generation`,audit:await sql`SELECT * FROM audit_log WHERE subject=${`delivery:${id}`} ORDER BY id`,jobs:await sql`SELECT * FROM pgboss.job WHERE data->>'deliveryId'=${String(id)} ORDER BY id`};}
async function fault(table:'audit_log'|'pgboss.job',id:number,fn:()=>Promise<unknown>){
 const name=`delivery_fault_${tag()}`,condition=table==='audit_log'?`NEW.subject='delivery:${id}'`:`NEW.data->>'deliveryId'='${id}'`;
 await sql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'injected delivery failure'; END IF; RETURN NEW; END $$`);
 await sql.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
 try{await assert.rejects(fn,/injected delivery failure/);}finally{await sql.unsafe(`DROP TRIGGER ${name} ON ${table}`);await sql.unsafe(`DROP FUNCTION ${name}()`);}
}
for(const outcome of ['sent','drop','resend'] as const)test(`${outcome} audit failure leaves the original state and sends nothing`,async()=>{
 const f=await fixture(),before=await state(f.id),sent=hits,args=await input(f.id,outcome);
 await fault('audit_log',f.id,()=>resolveDelivery(f.id,args,actor,{requestId:key()}));assert.deepEqual(await state(f.id),before);assert.equal(hits,sent);
});
test('a failed queue insert rolls back resend authorisation and audit',async()=>{
 const f=await fixture(),before=await state(f.id),sent=hits,args=await input(f.id);
 await fault('pgboss.job',f.id,()=>resolveDelivery(f.id,args,actor,{requestId:key()}));assert.deepEqual(await state(f.id),before);assert.equal(hits,sent);
});
test('resend authorisation commits one job and one audit without posting from the admin call',async()=>{
 const f=await fixture(),args=await input(f.id),requestId=key(),sent=hits;
 const results=await Promise.all([1,2].map(()=>resolveDelivery(f.id,args,actor,{requestId})));
 assert.deepEqual(results[0],results[1]);assert.equal(results[0]!.status,'pending');assert.equal(hits,sent);
 const after=await state(f.id);assert.equal(after.jobs.length,1);assert.equal(after.audit.length,1);assert.equal(after.attempts.length,1);assert.equal(after.row!.attempts,1);
});
test('dropping resolves the issue instead of leaving another failed item',async()=>{
 const f=await fixture();await resolveDelivery(f.id,await input(f.id,'drop'),actor,{requestId:key()});
 assert.equal((await state(f.id)).row!.status,'skipped');assert.ok(!(await runsOverview()).deliveries.some(d=>d.id===f.id));
});
test('stale versions cannot mark a newer delivery as arrived',async()=>{
 const f=await fixture(),args=await input(f.id,'sent');await sql`UPDATE deliveries SET updated_at=updated_at+interval '1 second' WHERE id=${f.id}`;
 const before=await state(f.id);await assert.rejects(resolveDelivery(f.id,args,actor,{requestId:key()}),/发生变化/);assert.deepEqual(await state(f.id),before);
});
test('HTTP rejects invalid actions without falling through to resend',async()=>{
 const previous={devAdmin:config.devAdmin,environmentName:config.environmentName};config.devAdmin={displayName:'Delivery Test'};config.environmentName='development';
 const app=await buildApp(),f=await fixture(),args=await input(f.id),before=await state(f.id),sent=hits;
 try{const r=await app.inject({method:'POST',url:`/api/admin/deliveries/${f.id}/resolve`,headers:{'x-csrf-token':'dev','idempotency-key':key()},payload:{...args,outcome:'invalid'}});assert.equal(r.statusCode,400);assert.deepEqual(await state(f.id),before);assert.equal(hits,sent);}
 finally{await app.close();Object.assign(config,previous);}
});

const dispatch=async(id:number,generation:number)=>(await import('@aihot/backend/notify/deliver')).dispatchDelivery(id,generation);
async function authorised(){const f=await fixture();await resolveDelivery(f.id,await input(f.id),actor,{requestId:key()});return f;}
test('concurrent worker dispatches claim one network attempt and use the current card',async()=>{
 const f=await authorised(),sent=hits;
 await sql`UPDATE publications SET title='corrected title' WHERE article_id=${f.articleId}`;
 await Promise.all([dispatch(f.id,1),dispatch(f.id,1)]);assert.equal(hits,sent+1);
 assert.equal((cards.at(-1) as {header:{title:{content:string}}}).header.title.content,'corrected title');
 const after=await state(f.id);assert.equal(after.row!.status,'sent');assert.equal(after.row!.attempts,2);assert.equal(after.attempts[0]!.attempt,2);
});
test('a committed command replay after an unknown result cannot authorise another send',async()=>{
 const f=await fixture(),args=await input(f.id),requestId=key();const first=await resolveDelivery(f.id,args,actor,{requestId});
 status=503;body='{"error":"ambiguous"}';const sent=hits;try{await dispatch(f.id,1);await dispatch(f.id,1);assert.equal(hits,sent+1);assert.equal((await state(f.id)).row!.status,'unknown');assert.deepEqual(await resolveDelivery(f.id,args,actor,{requestId}),first);assert.equal(hits,sent+1);}
 finally{status=200;body='{"code":0}';}
});
for(const reply of ['<html>proxy page</html>','{}'])test(`HTTP 200 with ${reply} is not a delivery acknowledgement`,async()=>{
 const f=await authorised();body=reply;try{assert.equal((await dispatch(f.id,1)).status,'unknown');}finally{body='{"code":0}';}
});
test('transport loss is preserved and cannot be replayed automatically',async()=>{
 const f=await authorised(),sent=hits;destroy=true;try{await dispatch(f.id,1);await dispatch(f.id,1);assert.equal(hits,sent+1);assert.equal((await state(f.id)).row!.status,'unknown');}finally{destroy=false;}
});
test('a failed result commit after POST leaves sending and queue retries do not POST again',async()=>{
 const f=await authorised(),name=`delivery_commit_${tag()}`,sent=hits;
 await sql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=${f.id} AND NEW.status='sent' THEN RAISE EXCEPTION 'injected result failure'; END IF; RETURN NEW; END $$`);
 await sql.unsafe(`CREATE TRIGGER ${name} BEFORE UPDATE ON deliveries FOR EACH ROW EXECUTE FUNCTION ${name}()`);
 try{await assert.rejects(dispatch(f.id,1),/injected result failure/);}finally{await sql.unsafe(`DROP TRIGGER ${name} ON deliveries`);await sql.unsafe(`DROP FUNCTION ${name}()`);}
 assert.equal(hits,sent+1);assert.equal((await dispatch(f.id,1)).status,'sending');assert.equal(hits,sent+1);
 await sql`UPDATE deliveries SET updated_at=now()-interval '16 minutes' WHERE id=${f.id}`;await markStaleDeliveries();assert.equal((await state(f.id)).row!.status,'unknown');
});
test('late network success cannot overwrite a later manual decision',async()=>{
 const f=await authorised(),started=gate(),resume=gate();hold=async()=>{started.open();await resume.promise;};
 const request=dispatch(f.id,1);try{
  await started.promise;await sql`UPDATE deliveries SET updated_at=now()-interval '16 minutes' WHERE id=${f.id}`;await markStaleDeliveries();
  await resolveDelivery(f.id,await input(f.id,'drop'),actor,{requestId:key()});resume.open();await request;
  const after=await state(f.id);assert.equal(after.row!.status,'skipped');assert.equal(after.attempts[0]!.status,'unknown');assert.equal(after.attempts[0]!.late_response.status,'sent');
 }finally{resume.open();hold=null;await request;}
});
test('lost pending jobs resume the same authorised generation once',async()=>{
 const f=await authorised();await sql`DELETE FROM pgboss.job WHERE data->>'deliveryId'=${String(f.id)}`;
 await sql`UPDATE deliveries SET updated_at=now()-interval '16 minutes' WHERE id=${f.id}`;
 await markStaleDeliveries();await markStaleDeliveries();const after=await state(f.id);assert.equal(after.jobs.length,1);assert.equal(after.attempts.length,1);
 const sent=hits;await dispatch(f.id,1);await dispatch(f.id,1);assert.equal(hits,sent+1);
});
test('target disabling, reactivation and withdrawn content are checked before dispatch',async()=>{
 const f=await authorised(),sent=hits;await sql`UPDATE notify_targets SET enabled=false WHERE key=${target}`;
 try{assert.equal((await dispatch(f.id,1)).status,'skipped');}finally{await sql`UPDATE notify_targets SET enabled=true WHERE key=${target}`;}
 const old=await authorised();await sql`UPDATE notify_targets SET enabled_at=now()+interval '1 minute' WHERE key=${target}`;
 try{assert.equal((await dispatch(old.id,1)).status,'skipped');}finally{await sql`UPDATE notify_targets SET enabled_at=NULL WHERE key=${target}`;}
 const withdrawn=await authorised();await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${withdrawn.articleId}`;
 assert.equal((await dispatch(withdrawn.id,1)).status,'skipped');assert.equal(hits,sent);
});
test('initial delivery handoff is durable and deduplicated without sending from the producer',async()=>{
 const id=await article(),dedupeKey=tag(),sent=hits,req={subjectKind:'selected' as const,subjectId:id,dedupeKey,contentAt:new Date(),card:{old:true}};
 const results=await Promise.all([deliverContent(req),deliverContent(req)]);
 const rows=await sql`SELECT * FROM deliveries WHERE target_key=${target} AND dedupe_key=${dedupeKey}`;ids.push(rows[0]!.id);
 assert.equal(rows.length,1);assert.equal(results.flat().filter(r=>r.target===target).length,1);assert.equal(hits,sent);
 assert.equal((await state(rows[0]!.id)).jobs.length,1);await dispatch(rows[0]!.id,1);assert.equal(hits,sent+1);
});
test('a revoked source or silent correction cannot escape through the queued card',async()=>{
 const f=await authorised(),sent=hits;await sql`UPDATE sources SET participation_mode='isolated' WHERE id=${prefix}`;
 try{assert.equal((await dispatch(f.id,1)).status,'skipped');}finally{await sql`UPDATE sources SET participation_mode='editorial' WHERE id=${prefix}`;}
 const silent=await authorised();await sql`INSERT INTO editorial_overrides(article_id,fields) VALUES(${silent.articleId},'{"silent":true}')`;
 assert.equal((await dispatch(silent.id,1)).status,'skipped');assert.equal(hits,sent);
});
test('explicit server rejection is failed while redirects remain unknown and are not followed',async()=>{
 const f=await authorised();body='{"code":400,"msg":"rejected"}';try{assert.equal((await dispatch(f.id,1)).status,'failed');}finally{body='{"code":0}';}
 const redirected=await authorised(),sent=hits;status=302;location=process.env.DELIVERY_OUTBOX_TEST_WEBHOOK!+'/redirected';
 try{assert.equal((await dispatch(redirected.id,1)).status,'unknown');assert.equal(hits,sent+1);}finally{status=200;location=null;}
});
test('sending switches are rechecked and do not permit queue authorisation in a disabled environment',async()=>{
 const f=await authorised(),sent=hits;config.feishuContentPushEnabled=false;
 try{
  assert.equal((await dispatch(f.id,1)).status,'skipped');assert.equal((await state(f.id)).row!.attempts,1);
  const disabled=await fixture(),before=await state(disabled.id);await assert.rejects(resolveDelivery(disabled.id,await input(disabled.id),actor,{requestId:key()}),/未启用/);assert.deepEqual(await state(disabled.id),before);
 }finally{config.feishuContentPushEnabled=true;}
 assert.equal(hits,sent);
});
test('a stopped queue generation cannot send after an operator gave up',async()=>{
 const f=await authorised();await sql`UPDATE deliveries SET status='unknown' WHERE id=${f.id}`;
 await resolveDelivery(f.id,await input(f.id,'drop'),actor,{requestId:key()});const sent=hits;
 assert.equal((await dispatch(f.id,1)).status,'obsolete');assert.equal(hits,sent);
});
test('queue insertion failure cannot leave a partially initialised producer delivery',async()=>{
 const id=await article(),dedupeKey=tag(),name=`delivery_producer_${tag()}`,sent=hits;
 await sql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name='notify.delivery' THEN RAISE EXCEPTION 'injected producer failure'; END IF; RETURN NEW; END $$`);
 await sql.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON pgboss.job FOR EACH ROW EXECUTE FUNCTION ${name}()`);
 try{await assert.rejects(deliverContent({subjectKind:'selected',subjectId:id,dedupeKey,contentAt:new Date(),card:{old:true}}),/injected producer failure/);}
 finally{await sql.unsafe(`DROP TRIGGER ${name} ON pgboss.job`);await sql.unsafe(`DROP FUNCTION ${name}()`);}
 assert.equal((await sql`SELECT * FROM deliveries WHERE target_key=${target} AND dedupe_key=${dedupeKey}`).length,0);assert.equal(hits,sent);
});
test('operator confirmation cannot race with another command based on the same delivery page',async()=>{
 const f=await fixture(),args=await input(f.id,'sent');
 const results=await Promise.allSettled([resolveDelivery(f.id,args,actor,{requestId:key()}),resolveDelivery(f.id,{...args,outcome:'drop'},actor,{requestId:key()})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await state(f.id)).audit.length,1);
});
test('reset dispatch uses the current snapshot in its transaction and excludes withdrawn events',async()=>{
 const features=FEATURES as unknown as {codexResetMonitor:boolean},original=features.codexResetMonitor;
 features.codexResetMonitor=true;
 try{
  const post=`${prefix}-post`,event=`${prefix}-reset`;
  await sql`INSERT INTO monitor_posts(id,author,published_at,text,url) VALUES(${post},'test',now(),'synthetic reset confirmation','https://example.org/reset')`;
  await sql`INSERT INTO monitor_events(id,type,status,title,label,confirmed_at,confirmation_basis,created_at,updated_at)
    VALUES(${event},'direct_reset','confirmed','synthetic reset','synthetic reset',now(),'source_post',now(),now())`;
  await sql`INSERT INTO monitor_event_posts(event_id,post_id,stage,action,text,original_text) VALUES(${event},${post},'confirm','confirm','synthetic reset','synthetic reset confirmation')`;
  const [row]=await sql`INSERT INTO deliveries(target_key,subject_kind,subject_id,dedupe_key,status,attempts,payload,content_at)
    VALUES(${target},'codex_reset',${event},${`codex:${post}:${event}:confirm`},'unknown',1,'{"old":true}',now()) RETURNING id`;
  const id=Number(row!.id);ids.push(id);await resolveDelivery(id,await input(id),actor,{requestId:key()});const sent=hits;
  assert.equal((await dispatch(id,1)).status,'sent');assert.equal(hits,sent+1);
  await sql`UPDATE deliveries SET status='unknown' WHERE id=${id}`;await resolveDelivery(id,await input(id),actor,{requestId:key()});
  await sql`UPDATE monitor_events SET withdrawn=true WHERE id=${event}`;
  assert.equal((await dispatch(id,2)).status,'skipped');assert.equal(hits,sent+1);
 }finally{features.codexResetMonitor=original;}
});
