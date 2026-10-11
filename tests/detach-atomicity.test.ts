import {tag,gate} from './setup.ts';
import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {sql,closeDb} from '@aihot/backend/db';
import {config} from '@aihot/backend/config';
import {upsertMaterial} from '@aihot/backend/content/materials';
import {publishArticle} from '@aihot/backend/publication/publish';
import {contentChain,detachFromFact} from '@aihot/backend/admin/content';
import {mergeStoryInto} from '@aihot/backend/events/merge';
import {Conflict} from '@aihot/backend/admin/sources';
import {ensureQueue,QUEUES,stopBoss} from '@aihot/backend/jobs/queue';
import {buildApp} from '../apps/api/src/app.ts';

const source=`detach-${tag()}`,ids:string[]=[],storyIds:number[]=[],factIds:number[]=[];
before(async()=>{
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,enabled,next_fetch_at) VALUES(${source},${source},'rss','T1','editorial',false,'2100-01-01')`;
  for(const q of [QUEUES.digest,'cron.hot.rank'])await ensureQueue(q);
});
after(async()=>{
  try {
  await sql`DELETE FROM pgboss.job WHERE data->>'storyId'=ANY(${storyIds.map(String)}::text[]) OR singleton_key=ANY(${ids.map(id=>`publication:${id}`)}::text[])`;
  await sql`DELETE FROM audit_log WHERE subject=ANY(${[...ids.map(id=>`content:${id}`),...storyIds.map(id=>`story:${id}`),...factIds.map(id=>`fact:${id}`)]}::text[])`;
  await sql`DELETE FROM articles WHERE id=ANY(${ids}::text[])`;
  await sql`DELETE FROM facts WHERE id=ANY(${factIds}::bigint[])`;
  await sql`DELETE FROM story_aliases WHERE story_id=ANY(${storyIds}::bigint[])`;
  await sql`UPDATE stories SET merged_into=NULL WHERE id=ANY(${storyIds}::bigint[])`;
  await sql`DELETE FROM stories WHERE id=ANY(${storyIds}::bigint[])`;
  await sql`DELETE FROM sources WHERE id=${source}`;
  } finally { await stopBoss();await closeDb(); }
});
async function report(age:number){
  const {articleId:id}=await upsertMaterial({sourceId:source,url:`https://example.org/detach/${tag()}`,title:'事件报道',bodyText:'当前正文',bodyStatus:'ok',via:'fetch',publishedAt:new Date(Date.now()-age)});
  ids.push(id);
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected) VALUES(${id},1,'rule','pass','当前事件标题','当前事件摘要',90,true)`;
  await publishArticle(id,{releasedAt:new Date(Date.now()-60000)});return id;
}
async function fixture(){
  const a=await report(7200000),b=await report(3600000);
  const [story]=await sql<{id:number}[]>`INSERT INTO stories(public_id,title,first_report_at,latest_at) VALUES(${randomUUID()},'原事件',now(),now()) RETURNING id`;storyIds.push(story!.id);
  const [fact]=await sql<{id:number}[]>`INSERT INTO facts(public_id,story_id,title,subject,action) VALUES(${randomUUID()},${story!.id},'原事实','旧主张','旧动作') RETURNING id`;factIds.push(fact!.id);
  await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${fact!.id},${a},'primary'),(${fact!.id},${b},'report')`;
  for(const id of [a,b]){
    await sql`INSERT INTO story_signals(story_id,article_id,participant_key,source_id,kind,observed_at) VALUES(${story!.id},${id},${`source:${source}`},${source},'editorial',now())`;
    await publishArticle(id);
  }
  await sql`UPDATE stories SET digest='{}',latest='旧综述',summary='旧摘要',digest_updated_at=now() WHERE id=${story!.id}`;
  await sql`INSERT INTO regroup_pending(article_id) VALUES(${a})`;
  return {a,b,story:story!.id,fact:fact!.id};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function state(f:Fixture){
  const articles=[f.a,f.b];
  return {
    articles:await sql`SELECT * FROM articles WHERE id=ANY(${articles}) ORDER BY id`,
    members:await sql`SELECT * FROM fact_articles WHERE fact_id=${f.fact} ORDER BY article_id`,
    signals:await sql`SELECT * FROM story_signals WHERE story_id=${f.story} ORDER BY article_id`,
    facts:await sql`SELECT * FROM facts WHERE id=${f.fact}`,stories:await sql`SELECT * FROM stories WHERE id=${f.story}`,
    pubs:await sql`SELECT * FROM publications WHERE article_id=ANY(${articles}) ORDER BY article_id`,
    ledger:await sql`SELECT * FROM selected_ledger WHERE article_id=ANY(${articles}) ORDER BY seq`,
    manual:await sql`SELECT * FROM grouping_overrides WHERE article_id=ANY(${articles}) ORDER BY article_id`,
    pending:await sql`SELECT * FROM regroup_pending WHERE article_id=ANY(${articles}) ORDER BY article_id`,
    audit:await sql`SELECT * FROM audit_log WHERE subject IN (${`content:${f.a}`},${`content:${f.b}`},${`fact:${f.fact}`},${`story:${f.story}`}) ORDER BY id`,
    jobs:await sql`SELECT id,name,data,state FROM pgboss.job WHERE data->>'storyId'=${String(f.story)} OR singleton_key=ANY(${articles.map(id=>`publication:${id}`)}) ORDER BY id`,
  };
}
async function failure(table:string,condition:string,fn:()=>Promise<unknown>){
  const n=`detach_failure_${tag()}`;
  await sql.unsafe(`CREATE FUNCTION ${n}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'injected detach failure'; END IF; RETURN NEW; END $$`);
  await sql.unsafe(`CREATE TRIGGER ${n} BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${n}()`);
  try{await assert.rejects(fn,/injected detach failure/);}
  finally{await sql.unsafe(`DROP TRIGGER ${n} ON ${table}`);await sql.unsafe(`DROP FUNCTION ${n}()`);}
}
for(const [name,table,condition] of [
  ['audit','audit_log',(f:Fixture)=>`NEW.subject='content:${f.a}' AND NEW.action='content.detach'`],
  ['detached projection','publications',(f:Fixture)=>`NEW.article_id='${f.a}'`],
  ['remaining report projection','publications',(f:Fixture)=>`NEW.article_id='${f.b}'`],
  ['digest handoff','pgboss.job',(f:Fixture)=>`NEW.name='events.digest' AND NEW.data->>'storyId'='${f.story}'`],
  ['ranking handoff','pgboss.job',(f:Fixture)=>`NEW.singleton_key='publication:${f.a}'`],
] as const)test(`a failed ${name} restores membership, signals, claims, projections, ledger and manual state`,async()=>{
  const f=await fixture();await sql`DELETE FROM pgboss.job WHERE data->>'storyId'=${String(f.story)}`;
  const before=await state(f);await failure(table,condition(f),()=>detachFromFact(f.a,'test detach','test'));assert.deepEqual(await state(f),before);
});
test('a successful detach moves the public item and remaining reading anchor in the same commit',async()=>{
  const f=await fixture(),before=await state(f),version=(await contentChain(f.a))!.groupingVersion;
  assert.equal((await detachFromFact(f.a,'test detach','test',{version}))!.detached,1);
  const after=await state(f),a=after.pubs.find(p=>p.article_id===f.a)!,b=after.pubs.find(p=>p.article_id===f.b)!;
  assert.equal(a.fact_id,null);assert.equal(a.story_id,null);assert.equal(b.fact_id,f.fact);
  assert.equal(b.sort_at.getTime(),b.timeline_at.getTime());assert.ok(b.sort_at>before.pubs.find(p=>p.article_id===f.b)!.sort_at);
  assert.equal(after.members.length,1);assert.equal(after.signals.length,1);assert.equal(after.signals[0]!.article_id,f.b);
  assert.equal(after.pending.length,0);assert.equal(after.manual.length,1);assert.equal(after.stories[0]!.digest,null);assert.equal(after.facts[0]!.subject,null);
  assert.ok(after.jobs.some(j=>j.name==='events.digest'&&j.data.afterCorrection===true));
  assert.ok(after.jobs.some(j=>j.name==='cron.hot.rank'));
  assert.equal(after.audit.filter(a=>a.action==='content.detach').length,1);
  assert.deepEqual(after.ledger,before.ledger); // v1 item text is unchanged; grouping lives in the public projection.
});
test('a heat-only report can be detached without a fact row and stays manually standalone',async()=>{
  const f=await fixture(),id=await report(0);
  await sql`INSERT INTO story_signals(story_id,article_id,participant_key,source_id,kind,observed_at) VALUES(${f.story},${id},${`source:${source}`},${source},'signal',now())`;
  const chain=(await contentChain(id))!;assert.equal(chain.membership.length,0);assert.equal(chain.heatSignals.length,1);
  assert.deepEqual(await detachFromFact(id,'remove discussion signal','test',{version:chain.groupingVersion}),{detached:0});
  assert.equal((await sql`SELECT * FROM story_signals WHERE article_id=${id}`).length,0);
  assert.equal((await sql`SELECT * FROM grouping_overrides WHERE article_id=${id}`).length,1);
});
test('a newer pending regroup rejects a stale detach without cancelling the newer request',async()=>{
  const f=await fixture(),version=(await contentChain(f.a))!.groupingVersion;
  await sql`UPDATE regroup_pending SET requested_at=clock_timestamp()+interval '1 second' WHERE article_id=${f.a}`;
  const before=await state(f);await assert.rejects(()=>detachFromFact(f.a,'old page','test',{version}),Conflict);assert.deepEqual(await state(f),before);
});
test('a story merge invalidates the old grouping token before a stale detach can remove the new membership',async()=>{
  const from=await fixture(),into=await fixture(),version=(await contentChain(from.a))!.groupingVersion;
  await mergeStoryInto(from.story,into.story,'test merge','test');
  const before=await state(from);await assert.rejects(()=>detachFromFact(from.a,'old page','test',{version}),Conflict);assert.deepEqual(await state(from),before);
  assert.equal((await sql`SELECT story_id FROM publications WHERE article_id=${from.a}`)[0]!.story_id,into.story);
});
test('two concurrent submissions from the same page commit one detach and reject the stale second one',async()=>{
  const f=await fixture(),version=(await contentChain(f.a))!.groupingVersion;
  const results=await Promise.allSettled([detachFromFact(f.a,'one','test',{version}),detachFromFact(f.a,'two','test',{version})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.ok(results.some(r=>r.status==='rejected'&&r.reason instanceof Conflict));
  assert.equal((await state(f)).audit.filter(a=>a.action==='content.detach').length,1);
});
test('concurrent detaches of two reports sharing a fact finish with consistent standalone projections',async()=>{
  const f=await fixture();await Promise.all([detachFromFact(f.a,'one','test'),detachFromFact(f.b,'two','test')]);
  const after=await state(f);assert.equal(after.members.length,0);assert.equal(after.signals.length,0);
  assert.ok(after.pubs.every(p=>p.fact_id===null&&p.story_id===null));assert.equal(after.manual.length,2);
});
test('a detach and a concurrent story merge do not deadlock or leave the detached report in the merged projection',async()=>{
  const from=await fixture(),into=await fixture();
  await Promise.all([detachFromFact(from.a,'one','test'),mergeStoryInto(from.story,into.story,'test merge','test')]);
  const [a]=await sql`SELECT fact_id,story_id FROM publications WHERE article_id=${from.a}`;assert.deepEqual(a,{fact_id:null,story_id:null});
  assert.equal((await sql`SELECT * FROM fact_articles WHERE article_id=${from.a}`).length,0);
  assert.equal((await sql`SELECT * FROM story_signals WHERE article_id=${from.a}`).length,0);
});
test('unknown articles and empty or non-string reasons make no detach writes',async()=>{
  assert.equal(await detachFromFact(`missing-${tag()}`,'test','test'),null);
  const f=await fixture(),before=await state(f);
  for(const reason of ['',42])await assert.rejects(()=>detachFromFact(f.a,reason as string,'test'),e=>(e as {statusCode:number}).statusCode===400);
  assert.deepEqual(await state(f),before);
});
test('a diagnostic page and its grouping token come from one snapshot while a concurrent membership change commits',async()=>{
  const f=await fixture(),before=(await contentChain(f.a))!;
  const blocker=postgres(config.databaseUrl,{max:1,onnotice:()=>{}}),held=gate(),inspect=gate();
  const lock=blocker.begin(async tx=>{
    await tx`LOCK TABLE analyses IN ACCESS EXCLUSIVE MODE`;held.open();await inspect.promise;
    let waiting=false;
    for(let n=0;n<100;n++){
      const [row]=await tx`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
        AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%FROM analyses%'`;
      if(row!.n){waiting=true;break;}
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.ok(waiting,'diagnostic read reached the blocked analysis query');
    await tx`DELETE FROM fact_articles WHERE article_id=${f.a}`;
    await tx`DELETE FROM story_signals WHERE article_id=${f.a}`;
    await tx`UPDATE publications SET fact_id=NULL,story_id=NULL WHERE article_id=${f.a}`;
    await tx`INSERT INTO grouping_overrides(article_id,reason,actor) VALUES(${f.a},'concurrent change','test')`;
  });
  let reading:ReturnType<typeof contentChain>|undefined;
  try{
    await held.promise;reading=contentChain(f.a);inspect.open();await lock;
    const page=(await reading)!;assert.deepEqual(page.membership,before.membership);assert.deepEqual(page.heatSignals,before.heatSignals);
    assert.equal(page.publication!.fact_id,f.fact);assert.equal(page.groupingVersion,before.groupingVersion);
    assert.notEqual((await contentChain(f.a))!.groupingVersion,page.groupingVersion);
  }finally{inspect.open();await lock.catch(()=>{});await reading?.catch(()=>{});await blocker.end();}
});
test('the actual admin HTTP flow exposes current grouping, rejects stale and missing tokens, and serves the standalone item',async()=>{
  const f=await fixture(),original={devAdmin:config.devAdmin,env:config.environmentName};config.devAdmin={displayName:'Detach Test'};config.environmentName='development';
  const app=await buildApp(),url=`/api/admin/content/${f.a}`,headers={'x-csrf-token':'dev'};
  try{
    const chain=(await app.inject({url})).json();assert.match(chain.groupingVersion,/^[0-9a-f]{64}$/);
    assert.equal((await app.inject({method:'POST',url:`${url}/detach`,headers,payload:{reason:'test'}})).statusCode,400);
    assert.equal((await app.inject({method:'POST',url:`${url}/detach`,headers,payload:{reason:'test',version:'0'.repeat(64)}})).statusCode,409);
    assert.equal((await app.inject({method:'POST',url:`/api/admin/content/missing-${tag()}/detach`,headers,payload:{reason:'test',version:chain.groupingVersion}})).statusCode,404);
    const detached=await app.inject({method:'POST',url:`${url}/detach`,headers,payload:{reason:'test',version:chain.groupingVersion}});assert.equal(detached.statusCode,200,detached.body);
    const current=(await app.inject({url})).json();assert.equal(current.membership.length,0);assert.equal(current.heatSignals.length,0);assert.notEqual(current.groupingVersion,chain.groupingVersion);
    const publicItem=await app.inject({url:`/api/site/items/${f.a}`});assert.equal(publicItem.statusCode,200,publicItem.body);assert.equal(publicItem.json().story,null);
  }finally{await app.close();config.devAdmin=original.devAdmin;config.environmentName=original.env;}
});
