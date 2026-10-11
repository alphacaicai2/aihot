// An admin failure must leave neither an unaudited source/job nor an audit for a rolled-back edit.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { createSource, updateSource, fetchNow, Conflict } from "@aihot/backend/admin/sources";
import { ensureQueue, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { republishKey } from "@aihot/backend/jobs/publication";
import { config } from "@aihot/backend/config";
import { buildApp } from "../apps/api/src/app.ts";

const prefix = `atomic-${tag()}`;
const sources: string[] = [];
const subject = (id: string) => `source:${id}`;
const draft = (id: string, feed = id) => ({ id, name: id, kind: "rss", config: { feedUrl: `https://example.org/${feed}.xml` } });
async function source() {
  const id = `${prefix}-${sources.length}`;
  sources.push(id);
  await sql`INSERT INTO sources (id,name,kind,config,next_fetch_at) VALUES (${id},${id},'rss',${sql.json(draft(id).config)},'2100-01-01')`;
  return (await sql`SELECT * FROM sources WHERE id=${id}`)[0]!;
}
async function state(id: string) {
  return {
    source: (await sql`SELECT * FROM sources WHERE id=${id}`)[0] ?? null,
    audit: await sql`SELECT actor,action,reason,before,after FROM audit_log WHERE subject=${subject(id)} ORDER BY id`,
    settings: await sql`SELECT * FROM settings WHERE key=${republishKey(id)}`,
    jobs: await sql`SELECT id,name,data FROM pgboss.job WHERE data->>'sourceId'=${id} ORDER BY id`,
  };
}
async function failDuring(table: "audit_log" | "pgboss.job", id: string, fn: () => Promise<unknown>) {
  const trigger = `source_admin_${tag()}`;
  const match = table === "audit_log" ? `NEW.subject = '${subject(id)}'` : `NEW.data->>'sourceId' = '${id}'`;
  await sql.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${match} THEN RAISE EXCEPTION 'injected source admin failure'; END IF; RETURN NEW; END $$`);
  await sql.unsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
  try { await assert.rejects(fn, /injected source admin failure/); }
  finally {
    await sql.unsafe(`DROP TRIGGER ${trigger} ON ${table}`);
    await sql.unsafe(`DROP FUNCTION ${trigger}()`);
  }
}
before(async () => {
  for (const queue of [QUEUES.republishSource, QUEUES.fetchSource, QUEUES.mpCheck]) await ensureQueue(queue);
});
after(async () => {
  await sql`DELETE FROM pgboss.job WHERE data->>'sourceId'=ANY(${sources}::text[])`;
  await sql`DELETE FROM settings WHERE key=ANY(${sources.map(republishKey)}::text[])`;
  await sql`DELETE FROM audit_log WHERE subject=ANY(${sources.map(subject)}::text[])`;
  await sql`DELETE FROM sources WHERE id=ANY(${sources}::text[])`;
  await stopBoss();
  await closeDb();
});

test("a republish queue failure rolls back the source, status and audit together", async () => {
  const row = await source(), before = await state(row.id);
  await failDuring("pgboss.job", row.id, () => updateSource(row.id, { patch: { name: "edited" }, version: row.updated_at.toISOString(), reason: "test" }, "test"));
  assert.deepEqual(await state(row.id), before);
});

test("a source audit failure leaves the edit and republish job uncommitted", async () => {
  const row = await source(), before = await state(row.id);
  await failDuring("audit_log", row.id, () => updateSource(row.id, { patch: { participation_mode: "isolated" }, version: row.updated_at.toISOString() }, "test"));
  assert.deepEqual(await state(row.id), before);
});

test("creating a source rolls back when its audit cannot be saved", async () => {
  const id = `${prefix}-create-fail`; sources.push(id);
  const before = await state(id);
  await failDuring("audit_log", id, () => createSource(draft(id), "test"));
  assert.deepEqual(await state(id), before);
});

test("source edits commit with their audit, republish status and job", async () => {
  const row = await source();
  const after = await updateSource(row.id, { patch: { name: "current name", participation_mode: "isolated" }, version: row.updated_at.toISOString(), reason: "review" }, "editor");
  assert.equal(after!.name, "current name");
  const current = await state(row.id);
  assert.equal(current.settings[0]!.value.status, "queued");
  assert.equal(current.jobs.length, 1);
  assert.equal(current.jobs[0]!.name, QUEUES.republishSource);
  assert.deepEqual(current.audit.map(a => [a.actor,a.action,a.reason,a.before,a.after]), [["editor","source.update","review",{name: row.name,participation_mode:row.participation_mode},{name:"current name",participation_mode:"isolated"}]]);
});

test("manual RSS and MP jobs roll back if their audit fails", async () => {
  for (const kind of ["rss", "mp_account"]) {
    const row = await source();
    await sql`UPDATE sources SET kind=${kind} WHERE id=${row.id}`;
    const before = await state(row.id);
    await failDuring("audit_log", row.id, () => fetchNow(row.id, "test"));
    assert.deepEqual(await state(row.id), before, kind);
  }
});

test("a failed manual enqueue leaves no audit, while a successful job has the matching audit", async () => {
  const row = await source(), before = await state(row.id);
  await failDuring("pgboss.job", row.id, () => fetchNow(row.id, "test"));
  assert.deepEqual(await state(row.id), before);
  const result = await fetchNow(row.id, "test");
  const current = await state(row.id);
  assert.equal(current.jobs.length, 1);
  assert.equal(result!.jobId, current.jobs[0]!.id);
  assert.deepEqual(current.audit[0]!.after, { jobId: result!.jobId });
});

test("concurrent creation of the same feed commits only one source and one audit", async () => {
  const ids = Array.from({ length: 8 }, (_, n) => `${prefix}-duplicate-${n}`);
  sources.push(...ids);
  const results = await Promise.all(ids.map(id => createSource(draft(id, `${prefix}-shared`), "test")));
  assert.equal(results.filter(r => r.created).length, 1);
  const winner = results.find(r => r.created)!;
  assert.ok(winner.created);
  for (const result of results) if (!result.created) assert.equal(result.duplicate.id, winner.source.id);
  assert.equal((await sql`SELECT id FROM sources WHERE id=ANY(${ids}::text[])`).length, 1);
  assert.equal((await sql`SELECT id FROM audit_log WHERE subject=ANY(${ids.map(subject)}::text[])`).length, 1);
});

test("conflicting versions and empty patches leave source, audit and queue unchanged", async () => {
  const row = await source(), before = await state(row.id);
  await assert.rejects(() => updateSource(row.id, { patch: { name: "stale" }, version: "2000-01-01T00:00:00.000Z" }, "test"), Conflict);
  assert.equal((await updateSource(row.id, { patch: {}, version: row.updated_at.toISOString() }, "test"))!.name, row.name);
  assert.deepEqual(await state(row.id), before);
});

test("the admin HTTP source flow retains CSRF, conflict handling and the committed audit history", async () => {
  const original = { devAdmin: config.devAdmin, environmentName: config.environmentName };
  config.devAdmin = { displayName: "Source Test" };
  config.environmentName = "development";
  const app = await buildApp();
  const id = `${prefix}-http`; sources.push(id);
  const headers = { "x-csrf-token": "dev" };
  try {
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/sources", payload: draft(id) })).statusCode, 403);
    assert.equal((await state(id)).source, null);
    const created = await app.inject({ method: "POST", url: "/api/admin/sources", payload: draft(id), headers });
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(created.json().created, true);
    const version = created.json().source.updated_at;
    const patch = { name: "HTTP edited source" };
    const edited = await app.inject({ method: "PATCH", url: `/api/admin/sources/${id}`, payload: { patch, version }, headers });
    assert.equal(edited.statusCode, 200, edited.body);
    const stale = await app.inject({ method: "PATCH", url: `/api/admin/sources/${id}`, payload: { patch, version: "2000-01-01T00:00:00.000Z" }, headers });
    assert.equal(stale.statusCode, 409, stale.body);
    const fetched = await app.inject({ method: "POST", url: `/api/admin/sources/${id}/fetch`, headers });
    assert.equal(fetched.statusCode, 200, fetched.body);
    const detail = await app.inject({ url: `/api/admin/sources/${id}` });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().source.name, patch.name);
    assert.deepEqual(detail.json().history.map((h: { action: string }) => h.action).sort(), ["source.create", "source.fetch", "source.update"]);
    assert.equal((await state(id)).jobs.length, 2);
  } finally {
    await app.close();
    Object.assign(config, original);
  }
});
