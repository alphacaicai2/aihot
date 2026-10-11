import { tag, gate } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import postgres from "postgres";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { modelFor, modelSources } from "@aihot/backend/editorial/models";
import { switchModel } from "@aihot/backend/admin/models";
import { updateBudget, setTargetEnabled, replaceContactQr } from "@aihot/backend/admin/settings";
import { loadContact } from "@aihot/backend/site/contact";
import { sha256 } from "@aihot/backend/lib/ids";
import { buildApp } from "../apps/api/src/app.ts";

const actor=`settings-test:${tag()}`,service=`budget-${tag()}`,target=`target-${tag()}`;
const originalDir=config.dataDir;
let dir:string,saved: Array<{key:string;value:unknown;updated_by:string|null;updated_at:Date}>;
before(async()=>{
  saved=await sql`SELECT * FROM settings WHERE key IN ('contact_qr','models.prefilter')`;
  dir=await mkdtemp(path.join(os.tmpdir(),'aihot-settings-test-'));config.dataDir=dir;
  await sql`INSERT INTO notify_targets(key,purpose,kind,enabled) VALUES(${target},'content','log',false)`;
});
after(async()=>{
  await sql`DELETE FROM settings WHERE key IN ('contact_qr','models.prefilter')`;
  for(const row of saved)await sql`INSERT INTO settings(key,value,updated_by,updated_at) VALUES(${row.key},${sql.json(row.value as never)},${row.updated_by},${row.updated_at})`;
  await sql`DELETE FROM audit_log WHERE actor=${actor}`;
  await sql`DELETE FROM budgets WHERE service=${service}`;
  await sql`DELETE FROM notify_targets WHERE key=${target}`;
  config.dataDir=originalDir;await rm(dir,{recursive:true,force:true});await closeDb();
});
async function auditFailure(subject:string,fn:()=>Promise<unknown>){
  const name=`settings_atomic_${tag()}`;
  await sql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.actor='${actor}' AND NEW.subject='${subject}' THEN RAISE EXCEPTION 'injected settings audit failure'; END IF; RETURN NEW; END $$`);
  await sql.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try{await assert.rejects(fn,/injected settings audit failure/);}
  finally{await sql.unsafe(`DROP TRIGGER ${name} ON audit_log`);await sql.unsafe(`DROP FUNCTION ${name}()`);}
}
const qr=(color:string)=>sharp({create:{width:140,height:140,channels:3,background:color}}).png().toBuffer();
const withoutKey=(row:Record<string,unknown>)=>({per_minute:row.per_minute,per_hour:row.per_hour,per_day:row.per_day});

test('an audit failure rolls back an existing budget and a newly created budget',async()=>{
  await sql`DELETE FROM budgets WHERE service=${service}`;
  for(const existing of [false,true]){
    if(existing)await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES(${service},1,10,100)`;
    const before=await sql`SELECT * FROM budgets WHERE service=${service}`;
    await auditFailure(`budget:${service}`,()=>updateBudget(service,{perMinute:9,perHour:90,perDay:900,reason:'test'},actor));
    assert.deepEqual(await sql`SELECT * FROM budgets WHERE service=${service}`,before);
  }
});
test('concurrent budget changes audit the actual preceding value including the first insert',async()=>{
  await sql`DELETE FROM budgets WHERE service=${service}`;await sql`DELETE FROM audit_log WHERE actor=${actor} AND subject=${`budget:${service}`}`;
  await Promise.all(Array.from({length:6},(_,n)=>updateBudget(service,{perMinute:n+1,perHour:10,perDay:100,reason:`change ${n}`},actor)));
  const history=await sql`SELECT before,after FROM audit_log WHERE actor=${actor} AND subject=${`budget:${service}`} ORDER BY id`;
  assert.equal(history.length,6);assert.equal(history[0]!.before,null);
  for(let n=1;n<history.length;n++)assert.deepEqual(history[n]!.before,withoutKey(history[n-1]!.after));
  assert.deepEqual(withoutKey((await sql`SELECT * FROM budgets WHERE service=${service}`)[0]!),withoutKey(history.at(-1)!.after));
});
test('a notification audit failure preserves enabled and enabled_at',async()=>{
  const before=await sql`SELECT * FROM notify_targets WHERE key=${target}`;
  await auditFailure(`notify-target:${target}`,()=>setTargetEnabled(target,true,'test',actor));
  assert.deepEqual(await sql`SELECT * FROM notify_targets WHERE key=${target}`,before);
});
test('concurrent notification changes audit their real before and after state',async()=>{
  await sql`DELETE FROM audit_log WHERE actor=${actor} AND subject=${`notify-target:${target}`}`;
  await Promise.all([true,false,true,false].map(value=>setTargetEnabled(target,value,'test',actor)));
  const history=await sql`SELECT before,after FROM audit_log WHERE actor=${actor} AND subject=${`notify-target:${target}`} ORDER BY id`;
  for(let n=1;n<history.length;n++)assert.deepEqual(history[n]!.before,{enabled:history[n-1]!.after.enabled,enabled_at:history[n-1]!.after.enabled_at});
});
test('notification activation time is sampled after a blocked target lock',async()=>{
  await sql`UPDATE notify_targets SET enabled=false,enabled_at=NULL WHERE key=${target}`;
  const blocker=postgres(config.databaseUrl,{max:1,onnotice:()=>{}});
  const held=gate(),check=gate(),observed=gate(),release=gate();
  let unlockedAt:Date;
  const lock=blocker.begin(async tx=>{
    await tx`SELECT key FROM notify_targets WHERE key=${target} FOR UPDATE`;held.open();await check.promise;
    for(let n=0;n<100;n++){
      const [row]=await tx`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND wait_event_type='Lock' AND query ILIKE '%notify_targets%'`;
      if(row!.n>0){observed.open();break;}
      await new Promise(resolve=>setTimeout(resolve,5));
      if(n===99)throw new Error('notification update did not reach the target lock');
    }
    await release.promise;
    const [clock]=await tx<{ at:Date }[]>`SELECT clock_timestamp() AS at`;unlockedAt=clock!.at;
  });
  let pending:ReturnType<typeof setTargetEnabled>|undefined;
  try{
    await held.promise;pending=setTargetEnabled(target,true,'test',actor);check.open();
    await Promise.race([observed.promise,lock.then(()=>{throw new Error('lock holder finished early')})]);
    release.open();await lock;
    const result=await pending;assert.ok(new Date(result!.enabled_at as Date).getTime()>=unlockedAt!.getTime());
  }finally{release.open();check.open();await lock.catch(()=>{});await pending?.catch(()=>{});await blocker.end();}
});
test('a failed model switch preserves both its committed setting and the runtime choice',async()=>{
  await switchModel('prefilter','default','test',actor);
  const before=await sql`SELECT * FROM settings WHERE key='models.prefilter'`;
  assert.equal(await modelFor('prefilter'),'default');
  await auditFailure('capability:prefilter',()=>switchModel('prefilter','deepseek-flash','test',actor));
  assert.deepEqual(await sql`SELECT * FROM settings WHERE key='models.prefilter'`,before);
  assert.equal(await modelFor('prefilter'),'default');
});
test('concurrent model switches record the real prior committed choice',async()=>{
  await switchModel('prefilter','default','test',actor);
  await sql`DELETE FROM audit_log WHERE actor=${actor} AND subject='capability:prefilter'`;
  await Promise.all(['deepseek-flash','default','deepseek-flash','default'].map(model=>switchModel('prefilter',model,'test',actor)));
  const history=await sql`SELECT before,after FROM audit_log WHERE actor=${actor} AND subject='capability:prefilter' ORDER BY id`;
  for(let n=1;n<history.length;n++)assert.deepEqual(history[n]!.before,history[n-1]!.after);
});
test('a separate process sees a committed model switch on its next read without a cache timeout',async()=>{
  await switchModel('prefilter','default','test',actor);
  const child=spawn(process.execPath,['--input-type=module','-e',`import {modelFor} from '@aihot/backend/editorial/models';import {closeDb} from '@aihot/backend/db';console.log(await modelFor('prefilter'));process.stdin.once('data',async()=>{console.log(await modelFor('prefilter'));await closeDb();process.exit(0)});`],{stdio:['pipe','pipe','pipe']});
  const lines:string[]=[];let text='';const waiters:Array<(s:string)=>void>=[];
  child.stdout.on('data',data=>{text+=String(data);for(let i=text.indexOf('\n');i>=0;i=text.indexOf('\n')){const line=text.slice(0,i).trim();text=text.slice(i+1);const done=waiters.shift();if(done)done(line);else lines.push(line);}});
  const line=()=>new Promise<string>((resolve,reject)=>{if(lines.length)resolve(lines.shift()!);else{waiters.push(resolve);const timeout=setTimeout(()=>reject(new Error('model reader did not answer')),10000);timeout.unref();}});
  try{
    assert.equal(await line(),'default');
    await switchModel('prefilter','deepseek-flash','test',actor);child.stdin.write('read\n');
    assert.equal(await line(),'deepseek-flash');
  }finally{child.kill('SIGTERM');}
});
test('QR audit failures preserve settings and do not publish the rejected file',async()=>{
  await sql`DELETE FROM settings WHERE key='contact_qr'`;
  const before=await loadContact(),data=await qr('red');
  await auditFailure('settings:contact_qr',()=>replaceContactQr({slot:'wechatQr',data},actor));
  assert.deepEqual(await loadContact(),before);
  const app=await buildApp();
  try{
    for(const hash of [sha256(data),sha256(data).slice(0,8)])assert.equal((await app.inject({url:`/contact/qr-wechat-${hash}.png`})).statusCode,404);
  }finally{await app.close();}
});
test('concurrent QR uploads keep both slots and serve only committed uploaded images',async()=>{
  await sql`DELETE FROM settings WHERE key='contact_qr'`;
  const a=await qr('green'),b=await qr('blue');
  await Promise.all([replaceContactQr({slot:'wechatQr',data:a},actor),replaceContactQr({slot:'feishuQr',data:b},actor)]);
  const current=await loadContact();assert.ok(current.wechatQr && current.feishuQr);
  const app=await buildApp();
  try{
    assert.equal((await app.inject({url:current.wechatQr!})).statusCode,200);assert.equal((await app.inject({url:current.feishuQr!})).statusCode,200);
    const orphan=`qr-wechat-${'a'.repeat(64)}.png`;await mkdir(path.join(dir,'uploads'),{recursive:true});await writeFile(path.join(dir,'uploads',orphan),a);
    assert.equal((await app.inject({url:`/contact/${orphan}`})).statusCode,404);
  }finally{await app.close();}
});
test('a colliding QR file cannot be overwritten or become active',async()=>{
  const data=await qr('yellow'),file=path.join(dir,'uploads',`qr-wechat-${sha256(data)}.png`);
  await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'existing mismatched file');const before=await loadContact();
  await assert.rejects(()=>replaceContactQr({slot:'wechatQr',data},actor),/content.*match/);
  assert.equal(await readFile(file,'utf8'),'existing mismatched file');assert.deepEqual(await loadContact(),before);
});
test('committed legacy QR filenames and retained historical URLs remain readable',async()=>{
  const data=await qr('purple'),legacy=`/contact/qr-wechat-${sha256(data).slice(0,8)}.png`;
  await writeFile(path.join(dir,'uploads',path.basename(legacy)),data);
  const before=await loadContact();
  await sql`UPDATE settings SET value=${sql.json({...before,wechatQr:legacy})} WHERE key='contact_qr'`;
  await sql`INSERT INTO audit_log(actor,action,subject,after) VALUES(${actor},'settings.contact_qr','settings:contact_qr',${sql.json({wechatQr:legacy})})`;
  const next=await replaceContactQr({slot:'wechatQr',data:await qr('orange')},actor);
  const app=await buildApp();
  try{
    for(const url of [legacy,next.wechatQr!]){
      const response=await app.inject({url});assert.equal(response.statusCode,200);
      assert.match(String(response.headers['cache-control']),/immutable/);
    }
  }finally{await app.close();}
});
test('admin HTTP rejects string notification flags and invalid budgets without changing state',async()=>{
  const original={devAdmin:config.devAdmin,environmentName:config.environmentName};config.devAdmin={displayName:'Settings Test'};config.environmentName='development';const app=await buildApp();
  const headers={'x-csrf-token':'dev'};
  try{
    const before=await sql`SELECT * FROM notify_targets WHERE key=${target}`;
    const result=await app.inject({method:'POST',url:`/api/admin/notify-targets/${target}`,headers,payload:{enabled:'false',reason:'test'}});
    assert.equal(result.statusCode,400,result.body);assert.deepEqual(await sql`SELECT * FROM notify_targets WHERE key=${target}`,before);
    const budget=await sql`SELECT * FROM budgets WHERE service=${service}`;
    const bad=await app.inject({method:'PUT',url:`/api/admin/budgets/${service}`,headers,payload:{perMinute:2147483648,perHour:10,perDay:100,reason:'test'}});
    assert.equal(bad.statusCode,400,bad.body);assert.deepEqual(await sql`SELECT * FROM budgets WHERE service=${service}`,budget);
    const choice=(await modelSources()).prefilter;
    assert.equal((await app.inject({method:'POST',url:'/api/admin/models/prefilter',headers,payload:{reason:'omitted model'}})).statusCode,400);
    assert.deepEqual((await modelSources()).prefilter,choice);
  }finally{await app.close();Object.assign(config,original);}
});
