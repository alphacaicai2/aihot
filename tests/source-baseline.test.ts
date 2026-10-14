import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";

const T = tag();
let entries = ["first", "old", "older"];
let oldTitle = "Existing undated AI research";
let broken = false;
const server = http.createServer((_req, res) => {
  if (broken) { res.writeHead(503); res.end("temporarily unavailable"); return; }
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
