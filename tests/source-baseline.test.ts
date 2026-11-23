import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { identityKeyFor } from "@aihot/backend/content/materials";
import type { SourceRow } from "@aihot/backend/sources/types";

const T = tag();
let entries = ["first", "old", "older"];
let oldTitle = "Existing undated AI research";
let broken = false;
let jsonEntries: Array<{ slug: string; title: string; date?: string | number | null }> = [];
const server = http.createServer((req, res) => {
  if (broken) { res.writeHead(503); res.end("temporarily unavailable"); return; }
  if (req.url === "/dates.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(jsonEntries)); return;
  }
  res.writeHead(200, { "content-type": "application/rss+xml" });
  res.end(`<rss version="2.0"><channel><title>Research</title>${entries.map((key) =>
    `<item><title>${key === "old" ? oldTitle : `AI research ${key}`}</title><link>https://example.org/${T}/${key}</link><description>${key} source summary</description></item>`).join("")}</channel></rss>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await stopBoss(); await closeDb(); });
const source = async (id: string, baseline: boolean) => sql`
  INSERT INTO sources (id,name,kind,config,tier,participation_mode,next_fetch_at) VALUES
  (${id},'Research','rss',${sql.json({ feedUrl: url, _aihot: { initialBackfillLimit: 1, initialBackfillMonths: 12, skipInitialRemainder: baseline } })},'T2','editorial','2100-01-01')`;
const rows = (id: string) => sql`SELECT url,title,backfill,backfill_reason FROM articles WHERE source_id=${id} ORDER BY url`;

test("initial stock stays suppressed, while a new URL and a changed stock entry are collected", async () => {
  const id = `baseline-${T}`;
  await source(id, true);
  assert.equal((await collectSource(id, { force: true })).created, 1);
  assert.equal((await collectSource(id, { force: true })).created, 0);
  assert.equal((await rows(id)).length, 1);
  entries = ["new", ...entries];
  assert.equal((await collectSource(id, { force: true })).created, 1);
  const newItem = (await rows(id)).find((r) => r.url.endsWith("/new"));
  assert.equal(newItem?.backfill, false, "a new undated URL appeared after the baseline");
  oldTitle = "Updated AI research and a new framework";
  assert.equal((await collectSource(id, { force: true })).created, 1);
  const old = (await rows(id)).find((r) => r.url.endsWith("/old"));
  assert.equal(old?.backfill, true);
  assert.equal(old?.backfill_reason, "initial-baseline-update");
  assert.equal((await collectSource(id, { force: true })).created, 0);
});

test("a failed initial fetch leaves no baseline, and a later successful first import is bounded", async () => {
  const id = `baseline-failure-${T}`;
  // Different material identities from the previous test.
  entries = ["failure-first", "failure-old", "failure-older"];
  await source(id, true);
  broken = true;
  assert.equal((await collectSource(id, { force: true })).status, "failed");
  const [s] = await sql`SELECT cursor FROM sources WHERE id=${id}`;
  assert.equal(s.cursor, null);
  broken = false;
  assert.equal((await collectSource(id, { force: true })).created, 1);
  assert.equal((await collectSource(id, { force: true })).created, 0);
});

test("ordinary subscriptions keep their existing second-poll backfill behavior", async () => {
  const id = `baseline-legacy-${T}`;
  entries = ["legacy-first", "legacy-old", "legacy-older"];
  await source(id, false);
  assert.equal((await collectSource(id, { force: true })).created, 1);
  assert.equal((await collectSource(id, { force: true })).created, 2);
});

for (const unit of ["epoch_ms", "epoch_s"]) test(`invalid ${unit} dates are unknown throughout baseline collection`, async () => {
  const id = `baseline-dates-${unit}-${T}`;
  const date = Math.floor(Date.now() / 1000) * 1000;
  const epoch = (ms: number) => unit === "epoch_s" ? ms / 1000 : ms;
  jsonEntries = [
    { slug: "invalid", title: "AI research with an invalid date", date: "not-a-number" },
    { slug: "valid", title: "Dated AI research", date: epoch(date) },
    { slug: "missing", title: "Undated AI research" },
    { slug: "overflow", title: "AI research with an out-of-range date", date: 1e20 },
    { slug: "stock", title: "Dated baseline stock", date: epoch(date) },
  ];
  const c = { url: `${url}/dates.json`, titlePaths: ["title"], publishedAtPath: "date", publishedAtUnit: unit,
    urlTemplate: `https://example.org/${id}/{slug}`,
    _aihot: { initialBackfillLimit: 2, initialBackfillMonths: 12, skipInitialRemainder: true } };
  // Use the real parser: these are Invalid Date objects, not simply missing dates.
  const candidates = await fetchJsonList({ config: c } as unknown as SourceRow);
  assert.ok(Number.isNaN(candidates[0]!.publishedAt!.getTime()));
  assert.ok(Number.isNaN(candidates[3]!.publishedAt!.getTime()));
  await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,next_fetch_at)
    VALUES (${id},'JSON dates','json_list',${sql.json(c)},'T2','editorial','2100-01-01')`;
  const first = await collectSource(id, { force: true });
  assert.deepEqual([first.status, first.found, first.created, first.revised], ["ok", 5, 2, 0]);
  const stored = () => sql`SELECT url,published_at,published_at_claim,backfill,backfill_reason FROM articles WHERE source_id=${id} ORDER BY url`;
  const firstRows = await stored();
  assert.equal(firstRows[0]!.published_at, null);
  assert.equal(firstRows[0]!.published_at_claim, null);
  assert.equal(firstRows[1]!.published_at.toISOString(), new Date(date).toISOString());
  const [saved] = await sql`SELECT cursor,health,fail_count FROM sources WHERE id=${id}`;
  assert.equal(saved!.health, "ok"); assert.equal(saved!.fail_count, 0);
  assert.equal(Object.keys(saved!.cursor.initialRemainder).length, 3);
  for (const candidate of candidates.slice(2)) {
    const key = sha256(identityKeyFor({ ...candidate, sourceId: id, via: "fetch" }));
    assert.equal(saved!.cursor.initialRemainder[key], sha256(stableJson({ title: candidate.title,
      excerpt: candidate.excerpt ?? null, bodyText: candidate.bodyText ?? null,
      publishedAt: candidate.publishedAt && Number.isFinite(candidate.publishedAt.getTime()) ? candidate.publishedAt.toISOString() : null })));
  }
  // Another invalid representation and a missing date produce the same baseline signature.
  jsonEntries[2]!.date = "invalid-now";
  jsonEntries[3]!.date = null;
  const repeat = await collectSource(id, { force: true });
  assert.deepEqual([repeat.status, repeat.created, repeat.revised], ["ok", 0, 0]);
  assert.deepEqual(await stored(), firstRows);
  jsonEntries[3] = { slug: "overflow", title: "Updated AI research", date: "still-invalid" };
  jsonEntries[4]!.date = epoch(date + 1000);
  jsonEntries.unshift({ slug: "new", title: "New AI research", date: "invalid" });
  const changed = await collectSource(id, { force: true });
  assert.deepEqual([changed.status, changed.created, changed.revised], ["ok", 3, 0]);
  const changedRows = await stored();
  const fresh = changedRows.find(r => r.url.endsWith("/new"))!;
  assert.equal(fresh.published_at, null); assert.equal(fresh.backfill, false);
  for (const slug of ["overflow", "stock"]) {
    assert.equal(changedRows.find(r => r.url.endsWith(`/${slug}`))!.backfill_reason, "initial-baseline-update");
  }
  const final = await collectSource(id, { force: true });
  assert.deepEqual([final.status, final.created, final.revised], ["ok", 0, 0]);
  const runs = await sql`SELECT status FROM fetch_runs WHERE source_id=${id}`;
  assert.equal(runs.length, 4); assert.ok(runs.every(r => r.status === "ok"));
});

test("ordinary JSON collection retains its import cap and valid dates alongside invalid dates", async () => {
  const id = `ordinary-dates-${T}`;
  const date = Math.floor(Date.now() / 1000) * 1000;
  jsonEntries = [{ slug: "invalid", title: "Invalid date", date: "invalid" },
    { slug: "valid", title: "Valid date", date }, { slug: "missing", title: "Missing date" }];
  const c = { url: `${url}/dates.json`, titlePaths: ["title"], publishedAtPath: "date", publishedAtUnit: "epoch_ms",
    urlTemplate: `https://example.org/${id}/{slug}`, _aihot: { initialBackfillLimit: 1 } };
  await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,next_fetch_at)
    VALUES (${id},'Ordinary JSON dates','json_list',${sql.json(c)},'T2','editorial','2100-01-01')`;
  const first = await collectSource(id, { force: true });
  const second = await collectSource(id, { force: true });
  assert.deepEqual([first.status, first.created, second.status, second.created], ["ok", 1, "ok", 2]);
  const rows = await sql`SELECT url,published_at,published_at_claim FROM articles WHERE source_id=${id} ORDER BY url`;
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.published_at_claim, null); assert.equal(rows[1]!.published_at_claim, null);
  assert.equal(rows[2]!.published_at.toISOString(), new Date(date).toISOString());
  const [saved] = await sql`SELECT cursor FROM sources WHERE id=${id}`;
  assert.equal(saved!.cursor.initialRemainder, undefined);
});
