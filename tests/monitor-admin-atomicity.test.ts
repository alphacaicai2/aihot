import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { sql, closeDb } from '@aihot/backend/db';
import { relinkPost, resolveMonitorPost, setWithdrawn, updateMonitorEvent } from '@aihot/backend/admin/monitor';
import { applyRecognition } from '@aihot/backend/monitor/assemble';
import { config } from '@aihot/backend/config';
import { buildApp } from '../apps/api/src/app.ts';

const prefix = `monitor-atomic-${tag()}`, actor = `test:${prefix}`;
after(async () => {
  await sql`DELETE FROM monitor_state WHERE key LIKE ${`failures:${prefix}%`}`;
  await sql`DELETE FROM monitor_events WHERE id LIKE ${`${prefix}%`}`;
  await sql`DELETE FROM monitor_posts WHERE id LIKE ${`${prefix}%`}`;
  await sql`DELETE FROM audit_log WHERE actor = ${actor} OR subject LIKE ${`monitor-event:${prefix}%`} OR subject LIKE ${`monitor-post:${prefix}%`}`;
  await closeDb();
});
async function fixture() {
  const post = `${prefix}-${tag()}`, from = `${post}-a`, to = `${post}-b`;
  await sql`INSERT INTO monitor_posts(id,author,published_at,text,url) VALUES(${post},'test',now(),'test post','https://example.org/test')`;
  await sql`INSERT INTO monitor_events(id,type,status,title,scope,label,created_at,updated_at)
    SELECT id,'direct_reset','announced','test event','test','test',now(),now() FROM unnest(${[from,to]}::text[]) id`;
  await sql`INSERT INTO monitor_event_posts(event_id,post_id,stage,action,text,original_text) VALUES(${from},${post},'announce','announce','test','test')`;
  await sql`INSERT INTO monitor_state(key,value) VALUES(${`failures:${post}`},'{"count":3}')`;
  return { post, from, to };
}
const version = async (id: string) => (await sql<{ updated_at: Date }[]>`SELECT updated_at FROM monitor_events WHERE id=${id}`)[0]!.updated_at.toISOString();
async function state(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    events: await sql`SELECT * FROM monitor_events WHERE id IN ${sql([f.from,f.to])} ORDER BY id`,
    posts: await sql`SELECT * FROM monitor_posts WHERE id=${f.post}`,
    links: await sql`SELECT * FROM monitor_event_posts WHERE post_id=${f.post} ORDER BY event_id`,
    failures: await sql`SELECT * FROM monitor_state WHERE key=${`failures:${f.post}`}`,
    audit: await sql`SELECT * FROM audit_log WHERE subject IN ${sql([`monitor-post:${f.post}`,`monitor-event:${f.from}`,`monitor-event:${f.to}`])} ORDER BY id`,
  };
}
async function fault(f: Awaited<ReturnType<typeof fixture>>, deferred: boolean, fn: () => Promise<unknown>) {
  const name = `monitor_atomic_${tag()}`;
  const table = deferred ? 'monitor_events' : 'audit_log';
  const condition = deferred ? `NEW.id='${f.from}'` : `NEW.actor='${actor}'`;
  await sql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'injected monitor failure'; END IF; RETURN NEW; END $$`);
  await sql.unsafe(deferred
    ? `CREATE CONSTRAINT TRIGGER ${name} AFTER UPDATE ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${name}()`
    : `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try { await assert.rejects(fn, /injected monitor failure/); }
  finally { await sql.unsafe(`DROP TRIGGER ${name} ON ${table}`); await sql.unsafe(`DROP FUNCTION ${name}()`); }
}
for (const action of ['edit','withdraw','relink'] as const) {
  test(`a deferred ${action} failure rolls back both state and audit`, async () => {
    const f = await fixture(), before = await state(f), v = await version(f.from);
    await fault(f,true,() => action === 'edit'
      ? updateMonitorEvent(f.from,{patch:{scope:'changed'},reason:'test',version:v},actor)
      : action === 'withdraw' ? setWithdrawn(f.from,{withdrawn:true,reason:'test',version:v},actor)
      : relinkPost({postId:f.post,fromEventId:f.from,toEventId:f.to,reason:'test'},actor));
    assert.deepEqual(await state(f),before);
  });
}
for (const action of ['skip','reviewed'] as const) {
  test(`a ${action} audit failure leaves post recognition and failure history unchanged`,async () => {
    const f = await fixture(), before = await state(f);
    await fault(f,false,() => resolveMonitorPost(f.post,{action,reason:'test'},actor));
    assert.deepEqual(await state(f),before);
  });
}
test('relinking to the same event cannot erase its source evidence',async () => {
  const f=await fixture(),before=await state(f);
  await assert.rejects(() => relinkPost({postId:f.post,fromEventId:f.from,toEventId:f.from,reason:'test'},actor));
  assert.deepEqual(await state(f),before);
});
test('an existing target link is preserved and rejects a conflicting move',async () => {
  const f=await fixture();
  await sql`INSERT INTO monitor_event_posts(event_id,post_id,stage,text,original_text) VALUES(${f.to},${f.post},'confirm','different','different')`;
  const before=await state(f);
  await assert.rejects(() => relinkPost({postId:f.post,fromEventId:f.from,toEventId:f.to,reason:'test'},actor),/目标事件/);
  assert.deepEqual(await state(f),before);
});
test('a committed move preserves evidence, advances both versions and writes one audit',async () => {
  const f=await fixture(),a=await version(f.from),b=await version(f.to);
  await relinkPost({postId:f.post,fromEventId:f.from,toEventId:f.to,reason:'test'},actor);
  const after=await state(f);
  assert.equal(after.links.length,1);assert.equal(after.links[0]!.event_id,f.to);assert.equal(after.links[0]!.original_text,'test');
  assert.notEqual(await version(f.from),a);assert.notEqual(await version(f.to),b);assert.equal(after.audit.length,1);
  await assert.rejects(() => updateMonitorEvent(f.from,{patch:{scope:'stale'},reason:'test',version:a},actor),/刷新/);
});
test('concurrent duplicate skips commit once and the recognizer respects the manual decision',async () => {
  const f=await fixture();
  const result=await Promise.allSettled([1,2].map(() => resolveMonitorPost(f.post,{action:'skip',reason:'test'},actor)));
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await state(f)).audit.length,1);assert.equal((await state(f)).failures.length,0);
  const applied=await applyRecognition(f.post,{relevant:false,translationZh:null,contextZh:[],outage:null,needsReview:false,propositions:[],model:'test',promptVersion:'test',receiptId:0});
  assert.deepEqual(applied,{eventIds:[],notify:[]});
  assert.equal((await state(f)).posts[0]!.recognition.skipped,true);
});
test('concurrent edits with one version commit once and retain one audit',async () => {
  const f=await fixture(),v=await version(f.from);
  const result=await Promise.allSettled(['first','second'].map(scope=>updateMonitorEvent(f.from,{patch:{scope},version:v,reason:'test'},actor)));
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await state(f)).audit.length,1);
});
test('HTTP rejects invalid flags, actions, missing versions and self-moves without changing state',async () => {
  const original={devAdmin:config.devAdmin,environmentName:config.environmentName};
  config.devAdmin={displayName:'Monitor Test'};config.environmentName='development';
  const app=await buildApp(),f=await fixture(),before=await state(f),headers={'x-csrf-token':'dev'};
  try {
    const cases=[
      {url:`/api/admin/monitor/events/${f.from}/withdrawn`,payload:{withdrawn:'false',reason:'test',version:await version(f.from)}},
      {url:`/api/admin/monitor/posts/${f.post}/resolve`,payload:{action:'other',reason:'test'}},
      {url:`/api/admin/monitor/events/${f.from}/withdrawn`,payload:{withdrawn:true,reason:'test'}},
      {url:'/api/admin/monitor/relink',payload:{postId:f.post,fromEventId:f.from,toEventId:f.from,reason:'test'}},
    ];
    for(const c of cases){const reply=await app.inject({method:'POST',headers,...c});assert.equal(reply.statusCode,400,reply.body);}
    assert.deepEqual(await state(f),before);
  } finally {await app.close();Object.assign(config,original);}
});
test('the admin HTTP workflow commits edits, receipt reviews and withdrawal with fresh versions',async () => {
  const original={devAdmin:config.devAdmin,environmentName:config.environmentName};
  config.devAdmin={displayName:'Monitor Test'};config.environmentName='development';
  const app=await buildApp(),f=await fixture(),headers={'x-csrf-token':'dev'};
  try {
    let v=await version(f.from);
    for(const c of [
      {method:'PATCH' as const,url:`/api/admin/monitor/events/${f.from}`,payload:{patch:{scope:'corrected scope'},reason:'test'}},
      {method:'POST' as const,url:`/api/admin/monitor/events/${f.from}/receipt-review`,payload:{occurredOn:null,reason:'test'}},
      {method:'POST' as const,url:`/api/admin/monitor/events/${f.from}/withdrawn`,payload:{withdrawn:true,reason:'test'}},
      {method:'POST' as const,url:`/api/admin/monitor/events/${f.from}/withdrawn`,payload:{withdrawn:false,reason:'test'}},
    ]) {
      const reply=await app.inject({headers,...c,payload:{...c.payload,version:v}});
      assert.equal(reply.statusCode,200,reply.body);
      const next=reply.json().updated_at;assert.notEqual(next,v);v=next;
    }
    const after=await state(f);
    assert.equal(after.events[0]!.scope,'corrected scope');assert.equal(after.events[0]!.status,'confirmed');
    assert.equal(after.events[0]!.confirmation_basis,'receipt_review');assert.equal(after.events[0]!.withdrawn,false);
    assert.deepEqual(after.audit.map(a=>a.action),['monitor.update','monitor.update','monitor.withdraw','monitor.restore']);
  } finally {await app.close();Object.assign(config,original);}
});
