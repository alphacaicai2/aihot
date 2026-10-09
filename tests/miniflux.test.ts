import { stub, Reply, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { collectSource } from "@aihot/backend/sources/collect";
import { sourceIdentity } from "@aihot/backend/admin/sources";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { listMinifluxFeeds } from "@aihot/backend/sources/miniflux";

const sourceId = `test-miniflux-${tag()}`;
let fail = false;
let paused = false;
let errors = 0;
const queries: URL[] = [];
const entries = Array.from({ length: 65 }, (_, i) => ({
  id: i + 1, title: `Model release ${i + 1}`, url: `https://example.com/miniflux-${sourceId}-${i}`,
  published_at: new Date().toISOString(), changed_at: new Date().toISOString(),
  content: `<script>SECRET_SCRIPT</script><p>${"New model facts and evidence. ".repeat(20)}</p>`,
}));
let server: Awaited<ReturnType<typeof stub>>;
before(async () => {
  config.allowPrivateNetworkFetch = true;
  server = await stub((_hit, req) => {
    assert.equal(req.body, "", "Miniflux access never writes upstream");
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/v1/feeds/7") return { id: 7, disabled: paused, parsing_error_count: errors };
    assert.equal(url.pathname, "/v1/feeds/7/entries");
    queries.push(url);
    if (fail) return new Reply(503, { error_message: "private details must not be logged" });
    const afterId = Number(url.searchParams.get("after_entry_id"));
    return { entries: entries.filter((e) => e.id > afterId).slice(0, Number(url.searchParams.get("limit"))) };
  });
  process.env.MINIFLUX_BASE_URL = server.url;
  process.env.MINIFLUX_TOKEN = "test-miniflux-token";
  await sql`INSERT INTO sources (id, name, kind, config, site_fulltext, next_fetch_at)
    VALUES (${sourceId}, 'Test Miniflux', 'rss', ${sql.json({ minifluxFeedId: 7 })}, false, '2100-01-01')`;
});
after(async () => { await server.close(); await stopBoss(); await closeDb(); });
const cursor = async () => (await sql`SELECT cursor FROM sources WHERE id = ${sourceId}`)[0]!.cursor;

test("a missing endpoint fails without requesting an implicit personal service", async () => {
  const previous = process.env.MINIFLUX_BASE_URL;
  const hits = server.hits();
  delete process.env.MINIFLUX_BASE_URL;
  try {
    await assert.rejects(listMinifluxFeeds(), /MINIFLUX_BASE_URL missing/);
    assert.equal(server.hits(), hits);
  } finally { process.env.MINIFLUX_BASE_URL = previous; }
});

test("first-import cap and restart pagination retain every entry and its baseline flag", async () => {
  const first = await collectSource(sourceId);
  assert.equal(first.created, 30);
  assert.equal((await cursor()).rss.miniflux.pending.afterId, 30);
  assert.equal((await collectSource(sourceId)).created, 35);
  assert.equal((await cursor()).rss.miniflux.pending, null);
  const [counts] = await sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE backfill)::int AS baseline
    FROM articles WHERE source_id = ${sourceId}`;
  assert.deepEqual([counts!.total, counts!.baseline], [65, 65]);
  assert.deepEqual(queries[0]!.searchParams.getAll("status"), ["read", "unread"]);
  assert.ok(queries[0]!.searchParams.has("published_after"));
});

test("replaying cached entries neither duplicates nor revises them; HTML summaries stay unconfirmed", async () => {
  const result = await collectSource(sourceId);
  assert.deepEqual([result.created, result.revised], [0, 0]);
  assert.ok(queries.at(-1)!.searchParams.has("changed_after"));
  const [article] = await sql`SELECT body_status, body_text, excerpt, revision FROM articles WHERE source_id = ${sourceId} LIMIT 1`;
  assert.equal(article!.body_status, "unconfirmed");
  assert.equal(article!.body_text, null);
  assert.ok(!article!.excerpt.includes("SECRET_SCRIPT"));
  assert.equal(article!.revision, 1);
});

test("an upstream error never advances a partially completed scan or leaks its body", async () => {
  const previous = await cursor();
  fail = true;
  const result = await collectSource(sourceId);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "Miniflux HTTP 503");
  assert.deepEqual(await cursor(), previous);
  fail = false;
});

test("cached entries remain usable while the upstream feed health is degraded", async () => {
  errors = 12;
  assert.equal((await collectSource(sourceId)).status, "ok");
  const [source] = await sql`SELECT health, last_error FROM sources WHERE id = ${sourceId}`;
  assert.equal(source!.health, "degraded");
  assert.match(source!.last_error, /12 fetch errors/);
  errors = 0;
});

test("paused Miniflux subscriptions are not ingested and retain the last cursor", async () => {
  const previous = await cursor();
  paused = true;
  assert.equal((await collectSource(sourceId)).status, "failed");
  assert.deepEqual(await cursor(), previous);
  paused = false;
});

test("explicit full-feed configuration upgrades previously stored summaries", async () => {
  await sql`UPDATE sources SET config = config || '{"summaryIsBody":true}'::jsonb WHERE id = ${sourceId}`;
  const result = await collectSource(sourceId);
  assert.ok(result.revised > 0);
  const [article] = await sql`SELECT body_status, body_html FROM articles WHERE source_id = ${sourceId} AND body_text IS NOT NULL LIMIT 1`;
  assert.equal(article!.body_status, "ok");
  assert.ok(!article!.body_html.includes("script"));
  assert.equal(sourceIdentity("rss", { minifluxFeedId: 7 }), "miniflux:7");
});
