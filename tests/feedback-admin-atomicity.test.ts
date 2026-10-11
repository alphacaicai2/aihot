import { tag, gate } from './setup.ts';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql, closeDb } from '@aihot/backend/db';
import { config } from '@aihot/backend/config';
import { banSource, unbanSource, updateFeedback, eraseFeedback } from '@aihot/backend/admin/feedback';
import { buildApp } from '../apps/api/src/app.ts';
import { cleanupFeedbackFiles } from '@aihot/backend/operations/feedback-files';
import { feedbackSourceHash, forwardPendingFeedback, submitFeedback } from '@aihot/backend/operations/feedback';
import { forwardFeedbackToFeishu } from '@aihot/backend/notify/feishu';

const prefix=`feedback-atomic-${tag()}`,actor=`test:${prefix}`,ids:number[]=[];
const dir=await mkdtemp(path.join(tmpdir(),'aihot-feedback-admin-'));config.dataDir=dir;
await mkdir(path.join(dir,'feedback-screenshots'));
after(async()=>{
  await sql`DELETE FROM feedback_file_cleanup WHERE feedback_id=ANY(${ids}::bigint[])`;
  await sql`DELETE FROM feedback WHERE id=ANY(${ids}::bigint[])`;
  await sql`DELETE FROM feedback_bans WHERE source_hash LIKE ${`${prefix}%`}`;
  await sql`DELETE FROM audit_log WHERE actor=${actor} OR subject=ANY(${ids.map(id=>`feedback:${id}`)}::text[])`;
  await closeDb();await rm(dir,{recursive:true,force:true});
});
async function feedback(filename=`${tag()}.png`){
  const file=path.join(dir,'feedback-screenshots',filename);await writeFile(file,'private screenshot');
  const [row]=await sql`INSERT INTO feedback(content,email,page_url,screenshot_key,source_hash,forward_error)
    VALUES('private text','reader@example.org','/daily',${`local:${filename}`},${prefix},'pending') RETURNING id,updated_at`;
  ids.push(row!.id);return {id:Number(row!.id),file,filename,version:(row!.updated_at as Date).toISOString()};
}
async function state(id:number){return {row:(await sql`SELECT * FROM feedback WHERE id=${id}`)[0],audit:await sql`SELECT * FROM audit_log WHERE subject=${`feedback:${id}`} ORDER BY id`,cleanup:await sql`SELECT * FROM feedback_file_cleanup WHERE feedback_id=${id}`};}
async function fault(deferred:boolean,id:number,fn:()=>Promise<unknown>){
  const name=`feedback_atomic_${tag()}`,table=deferred?'feedback':'audit_log';
  const condition=deferred?`NEW.id=${id}`:`NEW.actor='${actor}'`;
  await sql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'injected feedback failure'; END IF; RETURN NEW; END $$`);
  await sql.unsafe(deferred?`CREATE CONSTRAINT TRIGGER ${name} AFTER UPDATE ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${name}()`:`CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try{await assert.rejects(fn,/injected feedback failure/);}finally{await sql.unsafe(`DROP TRIGGER ${name} ON ${table}`);await sql.unsafe(`DROP FUNCTION ${name}()`);}
}
test('a deferred update failure leaves no success audit',async()=>{
  const f=await feedback(),before=await state(f.id);
  await fault(true,f.id,()=>updateFeedback(f.id,{status:'resolved',note:'test',version:f.version},actor));
  assert.deepEqual(await state(f.id),before);
});
test('a failed ban audit leaves the source able to submit',async()=>{
  const f=await feedback(),hash=`${prefix}-ban`;
  await fault(false,f.id,()=>banSource(hash,'test',actor));
  assert.equal((await sql`SELECT * FROM feedback_bans WHERE source_hash=${hash}`).length,0);
});
test('a failed unban audit preserves the ban and its reason',async()=>{
  const f=await feedback(),hash=`${prefix}-unban`;await banSource(hash,'original reason',actor);
  const before=await sql`SELECT * FROM feedback_bans WHERE source_hash=${hash}`;
  await fault(false,f.id,()=>unbanSource(hash,actor));assert.deepEqual(await sql`SELECT * FROM feedback_bans WHERE source_hash=${hash}`,before);
});
test('an erasure audit failure preserves the material, screenshot and forwarding state',async()=>{
  const f=await feedback(),before=await state(f.id);
  await fault(false,f.id,()=>eraseFeedback(f.id,'test',actor));assert.deepEqual(await state(f.id),before);
  assert.equal(await readFile(f.file,'utf8'),'private screenshot');
});
test('a deferred erasure failure cannot delete the screenshot or keep an audit',async()=>{
  const f=await feedback(),before=await state(f.id);
  await fault(true,f.id,()=>eraseFeedback(f.id,'test',actor));assert.deepEqual(await state(f.id),before);
  assert.equal(await readFile(f.file,'utf8'),'private screenshot');
});
test('erasing one legacy shared screenshot preserves the other submission',async()=>{
  const f=await feedback(),other=await feedback(f.filename);
  await eraseFeedback(f.id,'test',actor);assert.equal(await readFile(other.file,'utf8'),'private screenshot');
  assert.equal((await state(other.id)).row!.screenshot_key,`local:${f.filename}`);
});
test('committed erasure removes personal material and prevents future forwarding',async()=>{
  const f=await feedback();await eraseFeedback(f.id,'test',actor);
  const {row,audit}=await state(f.id);assert.ok(row!.erased_at);assert.equal(row!.email,null);assert.equal(row!.page_url,null);assert.equal(row!.screenshot_key,null);assert.equal(row!.forward_error,null);
  assert.equal(audit.length,1);await assert.rejects(readFile(f.file),{code:'ENOENT'});
});
test('concurrent repeated bans create exactly one audit',async()=>{
  const hash=`${prefix}-duplicate`;
  await Promise.all([1,2].map(()=>banSource(hash,'test',actor)));
  assert.equal((await sql`SELECT count(*)::int n FROM audit_log WHERE subject=${`feedback-source:${hash}`} AND action='feedback.ban'`)[0]!.n,1);
});
test('invalid feedback edits return HTTP 400 without changing the material',async()=>{
  const original={devAdmin:config.devAdmin,environmentName:config.environmentName};config.devAdmin={displayName:'Feedback Test'};config.environmentName='development';
  const app=await buildApp(),f=await feedback(),before=await state(f.id);
  try{
    for(const payload of [{status:'other',version:f.version},{note:123,version:f.version},{note:'test'}]){
      const result=await app.inject({method:'PATCH',url:`/api/admin/feedback/${f.id}`,headers:{'x-csrf-token':'dev'},payload});assert.equal(result.statusCode,400,result.body);
    }
    assert.deepEqual(await state(f.id),before);
  }finally{await app.close();Object.assign(config,original);}
});
test('filesystem failure leaves a durable cleanup record and retries while forwarding is disabled',async()=>{
  const f=await feedback();await rm(f.file);await mkdir(f.file);
  const result=await eraseFeedback(f.id,'test',actor);assert.equal(result!.cleanupPending,true);
  const first=await state(f.id);assert.ok(first.row!.erased_at);assert.equal(first.cleanup[0]!.attempts,1);assert.equal(first.cleanup[0]!.last_error,'EISDIR');
  await rm(f.file,{recursive:true});await writeFile(f.file,'temporary cleanup retry');
  process.env.FEISHU_INTERNAL_ENABLED='false';await forwardPendingFeedback();
  assert.equal((await state(f.id)).cleanup.length,0);await assert.rejects(readFile(f.file),{code:'ENOENT'});
  assert.equal((await state(f.id)).audit.length,1);
});
test('repeated erasure is idempotent and never audits or forwards the deleted material again',async()=>{
  const f=await feedback();await Promise.all([1,2].map(()=>eraseFeedback(f.id,'test',actor)));
  assert.equal((await state(f.id)).audit.length,1);
  assert.equal((await state(f.id)).row!.forward_error,null);
});
test('shared legacy files are cleaned only after their final reference is erased',async()=>{
  const f=await feedback(),other=await feedback(f.filename);
  assert.equal((await eraseFeedback(f.id,'test',actor))!.cleanupPending,true);
  await eraseFeedback(other.id,'test',actor);
  await assert.rejects(readFile(f.file),{code:'ENOENT'});
  await cleanupFeedbackFiles();
  await assert.rejects(readFile(f.file),{code:'ENOENT'});assert.equal((await state(f.id)).cleanup.length,0);
});
test('identical new uploads own different files and erasing one preserves the other',async()=>{
  process.env.FEISHU_INTERNAL_ENABLED='false';
  const input={content:'test identical files',screenshot:{mime:'image/png',data:Buffer.from('same screenshot')},ip:'203.0.113.230',userAgent:prefix};
  const a=await submitFeedback(input),b=await submitFeedback(input);ids.push(a.id,b.id);
  const ak=(await state(a.id)).row!.screenshot_key,bk=(await state(b.id)).row!.screenshot_key;assert.notEqual(ak,bk);
  await eraseFeedback(a.id,'test',actor);assert.equal(await readFile(path.join(dir,'feedback-screenshots',bk.slice(6)),'utf8'),'same screenshot');
});
test('HTTP erasure requires a fresh version and clears screenshot access after commit',async()=>{
  const original={devAdmin:config.devAdmin,environmentName:config.environmentName};config.devAdmin={displayName:'Feedback Test'};config.environmentName='development';
  const app=await buildApp(),f=await feedback(),headers={'x-csrf-token':'dev'};
  try{
    const url=`/api/admin/feedback/${f.id}/erase`;
    assert.equal((await app.inject({method:'POST',url,headers,payload:{reason:'test'}})).statusCode,400);
    await updateFeedback(f.id,{note:'new handling',version:f.version},actor);
    assert.equal((await app.inject({method:'POST',url,headers,payload:{reason:'test',version:f.version}})).statusCode,409);
    const v=(await state(f.id)).row!.updated_at.toISOString();
    assert.equal((await app.inject({method:'POST',url,headers,payload:{reason:{unexpected:true},version:v}})).statusCode,400);
    const result=await app.inject({method:'POST',url,headers,payload:{reason:'test',version:v}});assert.equal(result.statusCode,200,result.body);
    assert.equal(result.json().cleanupPending,false);
    assert.equal((await app.inject({url:`/api/admin/feedback/${f.id}/screenshot`})).statusCode,404);
  }finally{await app.close();Object.assign(config,original);}
});
test('banned sources are rejected on the public submission path',async()=>{
  const input={content:'test blocked source',ip:'203.0.113.231',userAgent:prefix},hash=feedbackSourceHash(input.ip,input.userAgent);
  try{await banSource(hash,'test',actor);await assert.rejects(submitFeedback(input),{status:403});}
  finally{await unbanSource(hash,actor);}
});
test('concurrent forwards send once; a completed erasure cannot send again',async()=>{
  const f=await feedback(),native=globalThis.fetch;let sent=0,hold=false;
  const started=gate(),resume=gate();
  const previous={enabled:process.env.FEISHU_INTERNAL_ENABLED,id:process.env.FEISHU_APP_ID,secret:process.env.FEISHU_APP_SECRET,chat:process.env.FEISHU_INTERNAL_CHAT_ID};
  process.env.FEISHU_INTERNAL_ENABLED='true';process.env.FEISHU_APP_ID='test-app';process.env.FEISHU_APP_SECRET='test-secret';process.env.FEISHU_INTERNAL_CHAT_ID='test-chat';
  globalThis.fetch=(async(input)=>{
    const url=String(input);assert.ok(url.startsWith('https://open.feishu.cn/'));
    if(url.includes('/auth/'))return Response.json({code:0,tenant_access_token:'test',expire:7200});
    if(url.includes('/images'))return Response.json({code:0,data:{image_key:'test-image'}});
    sent++;
    if(hold){started.open();await resume.promise;}
    return Response.json({code:0,data:{message_id:'test-message'}});
  }) as typeof fetch;
  try{
    const results=await Promise.all([1,2].map(()=>forwardFeedbackToFeishu(f.id)));
    assert.deepEqual(results.sort(),['disabled','sent']);assert.equal(sent,1);
    await eraseFeedback(f.id,'test',actor);assert.equal(await forwardFeedbackToFeishu(f.id),'disabled');assert.equal(sent,1);
    const other=await feedback();hold=true;
    const forwarding=forwardFeedbackToFeishu(other.id);await started.promise;
    const erasing=eraseFeedback(other.id,'test',actor);resume.open();
    await Promise.all([forwarding,erasing]);
    const final=(await state(other.id)).row!;
    assert.ok(final.erased_at && final.forwarded_at);assert.equal(final.screenshot_key,null);assert.equal(final.email,null);assert.equal(final.forward_error,null);
    assert.equal(await forwardFeedbackToFeishu(other.id),'disabled');assert.equal(sent,2);
  }finally{
    globalThis.fetch=native;
    for(const [key,value] of Object.entries({FEISHU_INTERNAL_ENABLED:previous.enabled,FEISHU_APP_ID:previous.id,FEISHU_APP_SECRET:previous.secret,FEISHU_INTERNAL_CHAT_ID:previous.chat}))if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
});
