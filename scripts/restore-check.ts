// Restore a trusted application backup into an EMPTY throwaway *_test or *_ci database.
// No worker, model, collection or notification process is started, and no existing data is dropped.
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import postgres from "postgres";
import { checkRestoredSequences, compareSnapshots, databaseSnapshot, fileSha256, postgresConnection, readBackupManifest } from "@aihot/backend/operations/backup-manifest";

const run = promisify(execFile);
const [file, ...extra] = process.argv.slice(2);
if (!file || extra.length) throw new Error("Usage: RESTORE_DATABASE_URL=postgres://.../empty_test node scripts/restore-check.ts /backup/manifest.json");
const target = process.env.RESTORE_DATABASE_URL;
if (!target) throw new Error("RESTORE_DATABASE_URL is required; DATABASE_URL is never used as the restore target");
let url: URL;
try {url=new URL(target);} catch {throw new Error("invalid RESTORE_DATABASE_URL");}
if (!/_(test|ci)$/.test(decodeURIComponent(url.pathname.slice(1)))) throw new Error("restore target must be a throwaway *_test or *_ci database");
if ([...url.searchParams.keys()].some(k=>k!=='sslmode')) throw new Error("restore target accepts only the sslmode connection option");
const manifest = await readBackupManifest(path.resolve(file));
const dir = path.dirname(path.resolve(file));
for (const object of manifest.objects) {
  const full = path.join(dir,object.file);
  const info = await lstat(full);
  if (!info.isFile() || info.size!==object.bytes || await fileSha256(full)!==object.sha256) throw new Error(`backup checksum failed: ${object.file}`);
}
const db = postgres(target,{ max:1,onnotice:()=>{} });
try {
  const [actual] = await db<{ name:string }[]>`SELECT current_database() AS name`;
  if (!/_(test|ci)$/.test(actual!.name)) throw new Error("connected database is not a throwaway test database");
  const [exists] = await db`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' LIMIT 1`;
  if (exists) throw new Error("restore target must be empty; existing objects are never overwritten");
  const connection = postgresConnection(target);
  const started = Date.now();
  await run('pg_restore',['--exit-on-error','--single-transaction','--no-owner','--no-acl','--no-password',
    '--dbname',connection.url,path.join(dir,'database.dump')],{ env:connection.env,timeout:60*60_000,maxBuffer:16*1024*1024 });
  const restored = await db.begin('isolation level repeatable read read only',tx=>databaseSnapshot(tx));
  const compared = compareSnapshots(manifest.database,restored);
  const sequences = await db.begin('isolation level repeatable read read only',tx=>checkRestoredSequences(tx));
  const filesDir = await mkdtemp(path.join(os.tmpdir(),'aihot-restore-files-'));
  await mkdir(filesDir,{ recursive:true,mode:0o700 });
  await run('tar',['-xzf',path.join(dir,'uploads.tar.gz'),'-C',filesDir,'--no-same-owner','--no-same-permissions'],{ timeout:15*60_000 });
  console.log(JSON.stringify({ backup:manifest.id,backupAt:manifest.at,database:actual!.name,
    ...compared,sequences,filesDir,seconds:Number(((Date.now()-started)/1000).toFixed(2)),restored:true }));
} finally {
  await db.end({timeout:5});
}
