import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFile, spawnSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { backupEnabled, backupOverview, runBackup } from "@aihot/backend/operations/backup";
import { checkRestoredSequences, compareSnapshots, postgresConnection, readBackupManifest } from "@aihot/backend/operations/backup-manifest";
import { collectFindings } from "@aihot/backend/operations/alerts";

const run = promisify(execFile);
const cli = ['pg_dump','pg_restore','tar'].every(c=>spawnSync(c,['--version'],{stdio:'ignore'}).status===0);
if (!cli && process.env.BACKUP_TEST_REQUIRE_CLI==='true') throw new Error('backup integration checks require PostgreSQL clients and tar');
const originalDir = config.dataDir;
const originalUrl = config.databaseUrl;
const originalLocal = process.env.BACKUP_LOCAL_ENABLED;
const T = tag();
let dir: string;
let saved: { key:string;value:unknown }[];
let manifest: string;
const storeKeys = ['DB_BACKUP_STORE_SECRET_ID','DB_BACKUP_STORE_SECRET_KEY','DB_BACKUP_STORE_BUCKET','DB_BACKUP_STORE_REGION','DB_BACKUP_STORE_DOMAIN'];
const storeBefore = Object.fromEntries(storeKeys.map(k=>[k,process.env[k]]));

before(async()=>{
  await getBoss();
  dir=await mkdtemp(path.join(os.tmpdir(),'aihot-backup-test-'));
  config.dataDir=dir;
  process.env.BACKUP_LOCAL_ENABLED='true';
  for (const k of storeKeys) delete process.env[k];
  saved=await sql`SELECT key,value FROM settings WHERE key LIKE 'backup.%'`;
  await sql`DELETE FROM settings WHERE key LIKE 'backup.%'`;
  await mkdir(path.join(dir,'uploads'));
  await writeFile(path.join(dir,'uploads','test.txt'),'uploaded file survives restore');
  await sql`INSERT INTO receipts(logical_key,service,purpose,status,error,attempts,billing_review)
    VALUES (${T},'backup-test','backup_test','unknown','lost response retained',1,
      ${sql.json({billed:true,amount:0,source:'operator',actor:'test:backup',note:'zero cost',at:new Date().toISOString()})})`;
});
after(async()=>{
  config.dataDir=originalDir;config.databaseUrl=originalUrl;
  if (originalLocal===undefined) delete process.env.BACKUP_LOCAL_ENABLED; else process.env.BACKUP_LOCAL_ENABLED=originalLocal;
  for (const k of storeKeys) if (storeBefore[k]===undefined) delete process.env[k]; else process.env[k]=storeBefore[k];
  await sql`DELETE FROM receipts WHERE logical_key=${T}`;
  await sql`DELETE FROM settings WHERE key LIKE 'backup.%'`;
  for (const s of saved??[]) await sql`INSERT INTO settings(key,value,updated_by) VALUES (${s.key},${sql.json(s.value as never)},'test')`;
  if (dir) await rm(dir,{recursive:true,force:true});
  await stopBoss();await closeDb();
});

test('database passwords stay out of child command arguments, including encoded and query passwords',()=>{
  const a=postgresConnection('postgres://user:secret%24%3A%40@localhost:5432/backup_test?sslmode=require');
  assert.equal(a.env.PGPASSWORD,'secret$:@');
  assert.equal(a.url,'postgres://user@localhost:5432/backup_test?sslmode=require');
  const b=postgresConnection('postgres://user:ignored@localhost/backup_test?password=query-secret');
  assert.equal(b.env.PGPASSWORD,'query-secret');
  assert.ok(!b.url.includes('secret'));
  assert.throws(()=>postgresConnection('postgres://user:secret%invalid@localhost/test'),/invalid PostgreSQL connection URL/);
});

test('content comparison rejects missing tables and equal row counts with changed data',()=>{
  const a={tables:{'public.receipts':{rows:1,fingerprint:'a'.repeat(32)}}};
  assert.throws(()=>compareSnapshots(a,{tables:{}}),/restored data differs/);
  assert.throws(()=>compareSnapshots(a,{tables:{'public.receipts':{rows:1,fingerprint:'b'.repeat(32)}}}),/restored data differs/);
  assert.deepEqual(compareSnapshots(a,a),{tables:1,rows:1});
});

test('only one process can back up at a time; a skipped run does not change attempt state',async()=>{
  const lock=await sql.reserve();
  try {
    await lock`SELECT pg_advisory_lock(hashtext('ops.backup'))`;
    const r=await runBackup();
    assert.deepEqual(r,{skipped:'already running'});
    assert.equal((await backupOverview()).lastAttempt,null);
  } finally {
    await lock`SELECT pg_advisory_unlock(hashtext('ops.backup'))`;lock.release();
  }
});

test('restored sequence checks detect ID reuse without consuming another ID',async()=>{
  const [saved]=await sql<{last_value:number;is_called:boolean}[]>`SELECT last_value,is_called FROM receipts_id_seq`;
  try {
    await sql`SELECT setval('receipts_id_seq',1,false)`;
    await assert.rejects(checkRestoredSequences(sql),/can reuse an ID: public.receipts_id_seq/);
    assert.equal((await sql`SELECT last_value FROM receipts_id_seq`)[0].last_value,1);
  } finally {await sql`SELECT setval('receipts_id_seq',${saved.last_value},${saved.is_called})`;}
  assert.ok(await checkRestoredSequences(sql)>0);
});

test('a complete backup restores all table contents, billing confirmations and uploaded files', {skip:!cli},async()=>{
  assert.equal(backupEnabled(),true);
  const r=await runBackup();
  assert.ok('manifest' in r);
  manifest=r.manifest;
  assert.equal(r.uploaded,false);
  assert.equal((await stat(path.dirname(manifest))).mode & 0o777,0o700);
  assert.equal((await stat(manifest)).mode & 0o777,0o600);
  const m=await readBackupManifest(manifest);
  assert.ok(m.database.tables['public.receipts'].rows>0);
  assert.equal((await backupOverview()).lastAttempt?.status,'completed');
  const database=`backup_restore_${T}_test`;
  await sql`CREATE DATABASE ${sql(database)}`;
  const target=new URL(originalUrl);target.pathname=`/${database}`;
  try {
    const {stdout}=await run(process.execPath,['scripts/restore-check.ts',manifest],{env:{...process.env,RESTORE_DATABASE_URL:target.toString()}});
    const proof=JSON.parse(stdout);
    assert.equal(proof.restored,true);
    assert.equal(proof.tables,Object.keys(m.database.tables).length);
    assert.equal(await readFile(path.join(proof.filesDir,'uploads','test.txt'),'utf8'),'uploaded file survives restore');
    await rm(proof.filesDir,{recursive:true,force:true});
  } finally { await sql`DROP DATABASE ${sql(database)} WITH (FORCE)`; }
});

test('restore rejects production names, existing databases, path traversal and damaged archive bytes', {skip:!cli},async()=>{
  const target=new URL(originalUrl);target.pathname='/not_a_test_database';
  await assert.rejects(run(process.execPath,['scripts/restore-check.ts',manifest],{env:{...process.env,RESTORE_DATABASE_URL:target.toString()}}),/throwaway/);
  await assert.rejects(run(process.execPath,['scripts/restore-check.ts',manifest],{env:{...process.env,RESTORE_DATABASE_URL:originalUrl}}),/must be empty/);
  const original=await readFile(manifest,'utf8');
  const malicious=JSON.parse(original);malicious.objects[0].file='../database.dump';
  await writeFile(manifest,JSON.stringify(malicious));
  await assert.rejects(readBackupManifest(manifest),/invalid backup object/);
  await writeFile(manifest,original);
  const dump=path.join(path.dirname(manifest),'database.dump');
  const size=(await stat(dump)).size;
  await appendFile(dump,'damaged');
  try {
    await assert.rejects(run(process.execPath,['scripts/restore-check.ts',manifest],{env:{...process.env,RESTORE_DATABASE_URL:originalUrl}}),/checksum failed/);
  } finally { await truncate(dump,size); }
});

test('a failed database dump keeps the last good backup and redacts its connection password', {skip:!cli},async()=>{
  const previous=(await backupOverview()).lastLocal;
  const wrong=new URL(originalUrl);wrong.password=`secret-failed-${T}`;
  config.databaseUrl=wrong.toString();
  try { await assert.rejects(runBackup(),/database failed/); }
  finally { config.databaseUrl=originalUrl; }
  const view=await backupOverview();
  assert.deepEqual(view.lastLocal,previous);
  assert.equal(view.lastAttempt?.status,'failed');
  assert.ok(!view.lastAttempt?.error?.includes(`secret-failed-${T}`));
  assert.ok((await collectFindings()).some(f=>f.key==='backup.failed'));
  assert.ok(!(await readdir(path.join(dir,'backups'))).some(n=>n.startsWith('.partial-')));
});

test('an upload failure preserves the completed local copy without claiming an offsite success', {skip:!cli},async()=>{
  const originalFetch=globalThis.fetch;
  for (const [k,v] of Object.entries({DB_BACKUP_STORE_SECRET_ID:'test-key',DB_BACKUP_STORE_SECRET_KEY:'test-secret',DB_BACKUP_STORE_BUCKET:'test',DB_BACKUP_STORE_REGION:'test',DB_BACKUP_STORE_DOMAIN:'127.0.0.1'})) process.env[k]=v;
  globalThis.fetch=async(_url,init)=>{
    (init?.body as unknown as {destroy():void}).destroy();
    return new Response('storage unavailable',{status:503});
  };
  try { await assert.rejects(runBackup(),/upload failed/); }
  finally {globalThis.fetch=originalFetch;for (const k of storeKeys) delete process.env[k];}
  const view=await backupOverview();
  assert.ok(view.lastLocal?.manifest);
  assert.equal(view.lastOffsite,null);
  assert.equal(view.lastAttempt?.status,'failed');
  assert.equal(view.lastAttempt?.stage,'upload');
  assert.ok(!view.lastAttempt?.error?.includes('test-secret'));
});

test('an unreadable uploads layout cannot replace the last complete backup with an empty archive', {skip:!cli},async()=>{
  const previous=(await backupOverview()).lastLocal;
  const uploads=path.join(dir,'uploads');
  await rm(uploads,{recursive:true});
  await writeFile(uploads,'wrong layout');
  try {await assert.rejects(runBackup(),/files failed.*uploads must be a directory/s);}
  finally {await rm(uploads);await mkdir(uploads);}
  assert.deepEqual((await backupOverview()).lastLocal,previous);
  assert.equal((await backupOverview()).lastAttempt?.stage,'files');
});

test('retention removes only older complete bundles and keeps unrelated or incomplete directories', {skip:!cli},async()=>{
  const protectedDir=path.join(dir,'backups',`backup-20000101000000-${'a'.repeat(36)}`);
  await mkdir(protectedDir);
  await writeFile(path.join(protectedDir,'keep.txt'),'not a complete backup');
  for (let i=0;i<4;i++) await runBackup(new Date(Date.now()+1000*i));
  const entries=await readdir(path.join(dir,'backups'));
  const complete=[];
  for (const entry of entries) if (await readBackupManifest(path.join(dir,'backups',entry,'manifest.json')).then(()=>true,()=>false)) complete.push(entry);
  assert.equal(complete.length,3);
  assert.equal(await readFile(path.join(protectedDir,'keep.txt'),'utf8'),'not a complete backup');
});
