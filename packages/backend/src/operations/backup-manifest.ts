import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Db } from "../db.ts";

export interface DatabaseSnapshot {
  tables: Record<string, { rows: number; fingerprint: string }>;
}
export interface BackupObject {
  file: string;
  bytes: number;
  sha256: string;
}
export interface BackupManifest {
  version: 1;
  id: string;
  at: string;
  database: DatabaseSnapshot;
  objects: BackupObject[];
}

export async function fileSha256(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

// Used inside the same exported snapshot as pg_dump. Every table's complete row content is
// hashed in a stable order, including queues, receipts and the operator's billing confirmations.
export async function databaseSnapshot(db: Db): Promise<DatabaseSnapshot> {
  await db`SET LOCAL TIME ZONE 'UTC'`;
  const tables = await db<{ schema: string; name: string }[]>`
    SELECT n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p') AND NOT c.relispartition
      AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    ORDER BY 1, 2`;
  const out: DatabaseSnapshot = { tables: {} };
  for (const t of tables) {
    const name = `${t.schema}.${t.name}`;
    const [r] = await db<{ rows: number; fingerprint: string }[]>`
      SELECT count(*)::int AS rows, md5(coalesce(string_agg(hash, '' ORDER BY hash), '')) AS fingerprint
      FROM (SELECT md5(to_jsonb(t)::text) AS hash FROM ${db(name)} t) hashed`;
    out.tables[name] = { rows: r!.rows, fingerprint: r!.fingerprint };
  }
  return out;
}

// libpq gets the password from the child environment, never command arguments or error messages.
export function postgresConnection(url: string) {
  let connection: URL;
  let password: string;
  try {
    connection = new URL(url);
    if (!['postgres:','postgresql:'].includes(connection.protocol)) throw new Error();
    password = connection.searchParams.get("password") ?? decodeURIComponent(connection.password);
  } catch { throw new Error("invalid PostgreSQL connection URL"); }
  connection.password = "";
  connection.searchParams.delete("password");
  return { url: connection.toString(), env: { ...process.env, PGPASSWORD: password } };
}

export async function readBackupManifest(file: string): Promise<BackupManifest> {
  const m = JSON.parse(await readFile(file, "utf8")) as BackupManifest;
  if (m.version !== 1 || typeof m.id !== "string" || !Number.isFinite(Date.parse(m.at)) || !m.database?.tables || !Array.isArray(m.objects)) {
    throw new Error("invalid backup manifest");
  }
  for (const [name, t] of Object.entries(m.database.tables)) {
    if (!name.includes(".") || !Number.isSafeInteger(t.rows) || t.rows < 0 || !/^[a-f0-9]{32}$/.test(t.fingerprint)) throw new Error("invalid database fingerprint");
  }
  const names = new Set<string>();
  for (const o of m.objects) {
    if (typeof o.file !== "string" || path.basename(o.file) !== o.file || !["database.dump", "uploads.tar.gz"].includes(o.file)
      || names.has(o.file) || !Number.isSafeInteger(o.bytes) || o.bytes <= 0 || !/^[a-f0-9]{64}$/.test(o.sha256)) throw new Error("invalid backup object");
    names.add(o.file);
  }
  if (names.size !== 2) throw new Error("backup must include the database and uploaded files");
  return m;
}

export function compareSnapshots(expected: DatabaseSnapshot, actual: DatabaseSnapshot) {
  const names = [...new Set([...Object.keys(expected.tables), ...Object.keys(actual.tables)])].sort();
  const different = names.filter(name => expected.tables[name]?.rows !== actual.tables[name]?.rows
    || expected.tables[name]?.fingerprint !== actual.tables[name]?.fingerprint);
  if (different.length) throw new Error(`restored data differs: ${different.join(", ")}`);
  return { tables: names.length, rows: names.reduce((n, name) => n + actual.tables[name]!.rows, 0) };
}

// Sequences are not MVCC data: pg_dump may see later increments than the exported row snapshot.
// Exact equality is inappropriate; the next value must be beyond all restored IDs instead.
export async function checkRestoredSequences(db: Db) {
  const columns = await db<{ table: string; column: string; sequence: string; increment: number }[]>`
    SELECT n.nspname||'.'||c.relname AS table,a.attname AS column,
      sn.nspname||'.'||sc.relname AS sequence,s.seqincrement::int AS increment
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    JOIN pg_class sc ON sc.oid=pg_get_serial_sequence(format('%I.%I',n.nspname,c.relname),a.attname)::regclass
    JOIN pg_namespace sn ON sn.oid=sc.relnamespace JOIN pg_sequence s ON s.seqrelid=sc.oid
    WHERE c.relkind IN ('r','p') AND NOT c.relispartition
      AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'`;
  for (const c of columns) {
    const [range]=await db<{ first:string|null;last:string|null }[]>`
      SELECT min(${db(c.column)})::text AS first,max(${db(c.column)})::text AS last FROM ${db(c.table)}`;
    if (range!.first===null) continue;
    const [state]=await db<{ value:string;called:boolean }[]>`SELECT last_value::text AS value,is_called AS called FROM ${db(c.sequence)}`;
    const next=BigInt(state!.value)+(state!.called ? BigInt(c.increment) : 0n);
    if (c.increment>0 ? next<=BigInt(range!.last!) : next>=BigInt(range!.first!)) throw new Error(`restored sequence can reuse an ID: ${c.sequence}`);
  }
  return columns.length;
}
