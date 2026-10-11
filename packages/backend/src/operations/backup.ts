// Database and file backups: a custom-format dump plus uploaded files and a content manifest, sent
// to the existing object store (Tencent COS through its S3-compatible API, AWS Signature V4) under
// daily/ (Sundays also weekly/, the 1st also monthly/). A few local copies are kept.
import { execFile } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";
import { databaseSnapshot, fileSha256, postgresConnection, readBackupManifest, type BackupManifest } from "./backup-manifest.ts";

const run = promisify(execFile);
const KEEP_LOCAL = 3;

interface Store {
  secretId: string;
  secretKey: string;
  bucket: string;
  region: string;
  endpoint: string;
}

/** Backups run where the object store is configured (production); development never uploads. */
export function backupConfigured(): boolean {
  return store() !== null;
}

export function backupEnabled(): boolean {
  return backupConfigured() || process.env.BACKUP_LOCAL_ENABLED === "true";
}

function store(): Store | null {
  const get = (k: string) => process.env[k] || credential("integrations", k) || null;
  const secretId = get("DB_BACKUP_STORE_SECRET_ID");
  const secretKey = get("DB_BACKUP_STORE_SECRET_KEY");
  const bucket = get("DB_BACKUP_STORE_BUCKET");
  const region = get("DB_BACKUP_STORE_REGION");
  if (!secretId || !secretKey || !bucket || !region) return null;
  const domain = get("DB_BACKUP_STORE_DOMAIN");
  return { secretId, secretKey, bucket, region, endpoint: domain ? `https://${domain.replace(/^https?:\/\//, "")}` : `https://${bucket}.cos.${region}.myqcloud.com` };
}

const hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

/** AWS Signature V4 headers for one request (exported for the test vector check). */
export function signV4(opts: {
  method: string; url: URL; region: string; service?: string; accessKey: string; secretKey: string; payloadHash: string; headers?: Record<string, string>; now?: Date;
}): Record<string, string> {
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const service = opts.service ?? "s3";
  const headers: Record<string, string> = { ...(opts.headers ?? {}), host: opts.url.host, "x-amz-content-sha256": opts.payloadHash, "x-amz-date": amzDate };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonicalQuery = [...opts.url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const canonicalPath = opts.url.pathname.split("/").map((s) => encodeURIComponent(decodeURIComponent(s))).join("/");
  const canonical = [opts.method, canonicalPath, canonicalQuery, names.map((n) => `${n}:${lower[n]}\n`).join(""), names.join(";"), opts.payloadHash].join("\n");
  const scope = `${day}/${opts.region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${opts.secretKey}`, day), opts.region), service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

async function upload(s: Store, key: string, file: string, sha: string, size: number) {
  const url = new URL(`${s.endpoint}/${key}`);
  const headers = signV4({ method: "PUT", url, region: s.region, accessKey: s.secretId, secretKey: s.secretKey, payloadHash: sha, headers: { "content-length": String(size), "content-type": "application/octet-stream" } });
  const res = await fetch(url, { method: "PUT", headers, body: createReadStream(file) as never, duplex: "half", signal: AbortSignal.timeout(60 * 60_000) } as RequestInit);
  if (!res.ok) throw new Error(`backup upload ${key}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
}

export interface BackupSummary {
  at: string;
  id: string;
  uploaded: boolean;
  manifest: string;
  objects: Array<{ key: string; bytes: number; sha256: string }>;
}
export interface BackupAttempt { at: string; id: string; status: "running" | "completed" | "failed"; stage?: string; error?: string }

async function save(key: string, value: object) {
  await sql`INSERT INTO settings (key,value,updated_by) VALUES (${key},${sql.json(value as never)},'backup')
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`;
}

export async function backupOverview() {
  const rows = await sql<{ key: string; value: BackupSummary | BackupAttempt }[]>`
    SELECT key,value FROM settings WHERE key IN ('backup.last','backup.last-local','backup.last-offsite','backup.last-attempt')`;
  const get = (key: string) => rows.find(r => r.key === key)?.value ?? null;
  return { enabled: backupEnabled(), offsiteConfigured: backupConfigured(),
    lastLocal: get('backup.last-local') as BackupSummary | null,
    lastOffsite: (get('backup.last-offsite') ?? ((get('backup.last') as BackupSummary | null)?.uploaded ? get('backup.last') : null)) as BackupSummary | null,
    lastAttempt: get('backup.last-attempt') as BackupAttempt | null };
}

async function pruneLocal(dir: string) {
  const complete: string[] = [];
  for (const name of (await readdir(dir)).filter(n => /^backup-[0-9]{14}-[a-f0-9-]{36}$/.test(n)).sort().reverse()) {
    if (await readBackupManifest(path.join(dir,name,'manifest.json')).then(() => true, () => false)) complete.push(name);
  }
  for (const name of complete.slice(KEEP_LOCAL)) await rm(path.join(dir,name), { recursive: true });
}

export async function runBackup(now = new Date()) {
  const s = store();
  const lock = await sql.reserve();
  const held = await lock<{ acquired: boolean }[]>`SELECT pg_try_advisory_lock(hashtext('ops.backup')) AS acquired`
    .catch(error=>{lock.release();throw error;});
  if (!held[0]!.acquired) { lock.release(); return { skipped: "already running" }; }
  const dir = path.join(config.dataDir,"backups");
  const id = `backup-${now.toISOString().replace(/[-:T]/g,'').slice(0,14)}-${randomUUID()}`;
  const staging = path.join(dir,`.partial-${randomUUID()}`);
  const destination = path.join(dir,id);
  let stage = "database";
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir,0o700);
    await mkdir(staging, { mode: 0o700 });
    await save('backup.last-attempt',{ at: now.toISOString(),id,status:'running' });
    const connection = postgresConnection(config.databaseUrl);
    const dump = path.join(staging,'database.dump');
    const database = await sql.begin('isolation level repeatable read read only', async tx => {
      const [snapshot] = await tx<{ id: string }[]>`SELECT pg_export_snapshot() AS id`;
      const contents = await databaseSnapshot(tx);
      await run('pg_dump',['--format=custom','--compress=6','--no-owner','--no-acl','--no-password',
        '--lock-wait-timeout=30s','--snapshot',snapshot!.id,'--file',dump,connection.url],
        { env: connection.env, timeout: 30*60_000, maxBuffer: 16*1024*1024 });
      return contents;
    });
    await run('pg_restore',['--list',dump],{ timeout: 60_000,maxBuffer: 64*1024*1024 });
    stage = "files";
    const files = path.join(staging,'uploads.tar.gz');
    const uploads = await stat(path.join(config.dataDir,'uploads')).then(i=> {
      if (!i.isDirectory()) throw new Error('uploads must be a directory');
      return true;
    },error=> {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    const pack = () => run('tar',uploads ? ['-czf',files,'-C',config.dataDir,'uploads'] : ['-czf',files,'-T','/dev/null'],{ timeout: 15*60_000 });
    await pack().catch(()=>pack());
    await run('tar',['-tzf',files],{ timeout: 60_000,maxBuffer: 64*1024*1024 });
    const objects = [];
    for (const file of [dump,files]) {
      await chmod(file,0o600);
      objects.push({ file: path.basename(file),bytes: (await stat(file)).size,sha256: await fileSha256(file) });
    }
    const manifest: BackupManifest = { version: 1,id,at: now.toISOString(),database,objects };
    await writeFile(path.join(staging,'manifest.json'),JSON.stringify(manifest,null,2),{ mode: 0o600 });
    await rename(staging,destination);
    const summary: BackupSummary = { at: now.toISOString(),id,uploaded: false,manifest: path.join(destination,'manifest.json'),
      objects: objects.map(o=>({ key: `local-only:${id}/${o.file}`,bytes:o.bytes,sha256:o.sha256 })) };
    await save('backup.last-local',summary);
    await pruneLocal(dir);
    stage = "upload";
    if (s) {
      const bj = new Date(now.getTime()+8*3600_000);
      const prefixes = ['daily',...(bj.getUTCDay() === 0 ? ['weekly'] : []),...(bj.getUTCDate() === 1 ? ['monthly'] : [])];
      summary.objects = [];
      for (const file of ['database.dump','uploads.tar.gz','manifest.json']) {
        const full = path.join(destination,file);
        const bytes = (await stat(full)).size;
        const sha256 = await fileSha256(full);
        for (const prefix of prefixes) {
          const key = `${prefix}/${id}/${file}`;
          await upload(s,key,full,sha256,bytes);
          summary.objects.push({ key,bytes,sha256 });
        }
      }
      summary.uploaded = true;
      await save('backup.last-offsite',summary);
    }
    await save('backup.last',summary);
    if (!s && !backupEnabled()) throw new Error('backup made locally but automatic backups are not enabled');
    await save('backup.last-attempt',{ at: now.toISOString(),id,status:'completed' });
    return summary;
  } catch (error) {
    let message = String(error instanceof Error ? error.message : error);
    let password = '';
    try {password=postgresConnection(config.databaseUrl).env.PGPASSWORD;} catch { /* Keep connection parsing failures safe too. */ }
    const secrets = [config.databaseUrl,password,s?.secretId,s?.secretKey].filter(Boolean) as string[];
    for (const secret of secrets) message=message.split(secret).join('[redacted]');
    await save('backup.last-attempt',{ at: now.toISOString(),id,status:'failed',stage,error:message.slice(0,500) });
    throw new Error(`backup ${stage} failed: ${message.slice(0,500)}`);
  } finally {
    try { await rm(staging,{ recursive: true,force: true }); }
    finally {
      try { await lock`SELECT pg_advisory_unlock(hashtext('ops.backup'))`; }
      finally { lock.release(); }
    }
  }
}
