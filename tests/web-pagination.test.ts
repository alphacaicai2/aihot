import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";
import { fetchWebList } from "@aihot/backend/sources/web-list";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";

const T = tag();
const requests: string[] = [];
const card = (id: number) => `<article><a href="https://example.org/${T}/original-${id}">Original analysis ${id}</a><time>2026-09-01</time></article>`;
let base = "";
const server = createServer((req, res) => {
  const url = req.url!; requests.push(url);
  res.setHeader("content-type", "text/html");
  if (url === "/first") res.end(`${card(1)}<a class="next" href="?page=2">Next</a>`);
  else if (url === "/first?page=2") res.end(`${card(1)}${card(2)}<a class="next" href="?page=3">Next</a>`);
  else if (url === "/first?page=3") res.end(`${card(3)}<a class="next" href="?page=4">Next</a>`);
  else if (url === "/ambiguous") res.end(`${card(1)}<a class="next" href="/two">Next</a><a class="next" href="/three">Next</a>`);
  else if (url === "/external") res.end(`${card(1)}<a class="next" href="https://unrelated.example/secret">Next</a>`);
  else if (url === "/loop") res.end(`${card(1)}<a class="next" href="/loop">Next</a>`);
  else if (url === "/broken") res.end(`${card(1)}<a class="next" href="/missing">Next</a>`);
  else if (url === "/disabled") res.end(`${card(1)}<a class="next" href="/missing" aria-disabled="true">Next</a>`);
  else if (url === "/redirect") { res.statusCode = 302; res.setHeader("location", `${base}/should-not-follow`); res.end(); }
  else if (url === "/redirect-list") res.end(`${card(1)}<a class="next" href="/redirect">Next</a>`);
  else { res.statusCode = 404; res.end("Missing"); }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await stopBoss(); await closeDb(); });
const source = (path: string, extra = {}) => ({ id: `pages-${T}`, kind: "web_list", config: {
  url: `${base}${path}`, parseMode: "html", itemSelector: "article", linkSelector: "a", titleSelector: "a", publishedAtSelector: "time",
  nextPageSelector: "a.next", maxPages: 3, ...extra,
} }) as never;

test("native listing follows only declared next links, caps pages and keeps the first duplicate", async () => {
  requests.length = 0;
  const rows = await fetchWebList(source("/first"));
  assert.deepEqual(rows.map(row => row.title), ["Original analysis 1", "Original analysis 2", "Original analysis 3"]);
  assert.deepEqual(requests, ["/first", "/first?page=2", "/first?page=3"]);
  requests.length = 0;
  assert.equal((await fetchWebList(source("/first", { nextPageSelector: undefined, maxPages: undefined }))).length, 1);
  assert.deepEqual(requests, ["/first"], "ordinary sources still read one listing");
});

test("ambiguous, external, looping or failed pagination cannot silently yield a partial result", async () => {
  for (const [path, reason] of [["/ambiguous", /ambiguous/], ["/external", /origin/], ["/loop", /loop/], ["/broken", /HTTP 404/], ["/redirect-list", /redirects/]] as const)
    await assert.rejects(fetchWebList(source(path)), reason);
  assert.ok(!requests.includes("/should-not-follow"));
  assert.equal((await fetchWebList(source("/disabled"))).length, 1);
  for (const extra of [{ maxPages: 6 }, { maxPages: 1 }, { maxPages: 2.5 }, { maxPages: undefined }, { nextPageSelector: undefined }, { parseMode: "markdown" }, { baseUrl: base }])
    assert.throws(() => assertSupportedConfig("web_list", (source("/first", extra) as any).config), /pagination|nextPageSelector|maxPages/);
});

test("complete paginated discovery participates in initial subscription cap and repeat baseline", async () => {
  const id = `pages-subscription-${T}`;
  const c = { ...(source("/first") as any).config, detail: { maxFetches: 0 }, _aihot: { initialBackfillLimit: 2, initialBackfillMonths: 12, skipInitialRemainder: true } };
  await sql`INSERT INTO sources(id,name,kind,config,tier,participation_mode,next_fetch_at) VALUES(${id},'Paged originals','web_list',${sql.json(c)},'T2','editorial','2100-01-01')`;
  const first = await collectSource(id);
  assert.deepEqual([first.status, first.found, first.created, first.revised], ["ok", 3, 2, 0]);
  const repeat = await collectSource(id);
  assert.deepEqual([repeat.status, repeat.found, repeat.created, repeat.revised], ["ok", 3, 0, 0]);
  const rows = await sql`SELECT title,revision FROM articles WHERE source_id=${id} ORDER BY title`;
  assert.deepEqual(rows.map(row => [row.title, row.revision]), [["Original analysis 1", 1], ["Original analysis 2", 1]]);
});
