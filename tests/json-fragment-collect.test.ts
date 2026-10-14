import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";
import { fetchJsonList } from "@aihot/backend/sources/json-list";

const T = tag();
const body = "A synthetic long editorial paragraph about a fictional market and its technical constraints. ".repeat(20);
const issues = Array.from({ length: 97 }, (_, i) => ({ slug: `issue-${i}`, title: `Synthetic issue ${i}`,
  dateLabel: "September 2026", blocks: [{ type: "paragraph", text: `${body}End of issue ${i}.` }] }));
const server = http.createServer((req, res) => {
  const plain = req.url === "/plain.json";
  res.writeHead(200, { "content-type": plain ? "application/json" : "application/javascript" });
  res.end(plain ? JSON.stringify([{ id: "one", title: "Ordinary JSON one", content: body },
    { id: "two", title: "Ordinary JSON two", content: body }]) : `const N=${JSON.stringify(issues)};`);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await stopBoss(); await closeDb();
});

test("native JSON fragment articles remain distinct through bounded first import and unchanged repeat", async () => {
  const id = `json-fragments-${T}`;
  const c = { url: `${base}/issues.js`, mode: "javascript_array", arrayMatchKeys: ["slug", "title", "blocks"],
    titlePaths: ["title"], summaryBlocksPath: "blocks", summaryIsBody: true, publishedAtPath: "dateLabel",
    urlTemplate: `https://example.org/${T}/insights#newsletter-{slug}`, preserveUrlFragment: true,
    _aihot: { initialBackfillLimit: 3, initialBackfillMonths: 12, skipInitialRemainder: true } };
  await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,next_fetch_at)
    VALUES (${id},'Synthetic newsletters','json_list',${sql.json(c)},'T2','editorial','2100-01-01')`;
  const first = await collectSource(id, { force: true });
  assert.deepEqual([first.status, first.found, first.created, first.revised], ["ok", 97, 3, 0]);
  const rows = await sql`SELECT url,identity_key,title,body_text,body_status,revision,backfill,published_at FROM articles WHERE source_id=${id} ORDER BY url`;
  assert.equal(rows.length, 3, "the initial cap counts three different newsletter fragments");
  assert.equal(new Set(rows.map(row => row.identity_key)).size, 3);
  assert.deepEqual(rows.map(row => row.url), [0, 1, 2].map(i => `https://example.org/${T}/insights#newsletter-issue-${i}`));
  for (const [i, row] of rows.entries()) {
    assert.equal(row.title, `Synthetic issue ${i}`);
    assert.equal(row.body_text, `${body}End of issue ${i}.`);
    assert.equal(row.body_status, "ok");
    assert.equal(row.published_at, null);
    assert.equal(row.backfill, true);
  }
  const [saved] = await sql`SELECT cursor FROM sources WHERE id=${id}`;
  assert.equal(Object.keys(saved!.cursor.initialRemainder).length, 94, "the baseline retains each unimported fragment separately");
  const repeat = await collectSource(id, { force: true });
  assert.deepEqual([repeat.status, repeat.found, repeat.created, repeat.revised], ["ok", 97, 0, 0]);
  const afterRows = await sql`SELECT url,identity_key,title,body_text,body_status,revision,backfill,published_at FROM articles WHERE source_id=${id} ORDER BY url`;
  assert.deepEqual(afterRows, rows, "repeat polling neither collapses identities nor revises imported issues");
});

test("ordinary JSON uses its existing URL identity without an explicit candidate identity override", async () => {
  const id = `json-plain-${T}`;
  const c = { url: `${base}/plain.json`, titlePaths: ["title"], summaryPaths: ["content"], summaryIsBody: true,
    urlTemplate: `https://example.org/${T}/plain/{id}`,
    _aihot: { initialBackfillLimit: 2, initialBackfillMonths: 12, skipInitialRemainder: true } };
  const candidates = await fetchJsonList({ config: c } as never);
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every(candidate => candidate.identityKey === undefined));
  await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,next_fetch_at)
    VALUES (${id},'Ordinary JSON','json_list',${sql.json(c)},'T2','editorial','2100-01-01')`;
  const first = await collectSource(id, { force: true });
  const repeat = await collectSource(id, { force: true });
  assert.deepEqual([first.status, first.created, first.revised], ["ok", 2, 0]);
  assert.deepEqual([repeat.status, repeat.created, repeat.revised], ["ok", 0, 0]);
});
