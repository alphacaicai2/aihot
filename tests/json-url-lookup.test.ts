import "./setup.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";

let base = "", edition = 1, indexMode = "normal";
const requests: Array<{ path: string; auth?: string }> = [];
const server = createServer((req, res) => {
  requests.push({ path: req.url!, auth: req.headers.authorization });
  res.setHeader("content-type", "application/json");
  if (req.url === "/listing.json") res.end(JSON.stringify([{ title: `Original title ${edition}`, link: { to: edition, href: null }, date: "2026-10-12" }]));
  else if (indexMode === "redirect") { res.statusCode = 302; res.setHeader("location", `${base}/must-not-follow`); res.end(); }
  else if (indexMode === "html") { res.setHeader("content-type", "text/html"); res.end("<p>No public index</p>"); }
  else if (indexMode === "invalid") res.end("not JSON");
  else if (indexMode === "large") res.end(JSON.stringify({ padding: "x".repeat(4 * 1024 * 1024) }));
  else {
    const nodes = indexMode === "empty" ? [] : indexMode === "unmatched" ? [{ id: 99, path: "/other" }] :
      [{ path: "/404/" }, { id: edition, path: indexMode === "offsite" ? "https://other.example/not-the-article" : `/published-${edition}/` }];
    if (indexMode === "ambiguous") nodes.push({ id: edition, path: "/conflicting-reader/" });
    res.end(JSON.stringify({ nodes }));
  }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
const rule = { url: `${base}/index.json`, itemsPath: "nodes", keyPath: "id", valuePath: "path", itemKeyPath: "link.to" };
const source = { id: "published-page-index", kind: "json_list", config: { url: `${base}/listing.json`, titlePaths: ["title"], publishedAtPath: "date",
  externalIdPath: "link.to", headers: { authorization: "only-the-listing" }, urlLookup: rule } } as any;

test("public CMS page IDs resolve real current reader URLs without losing titles or forwarding credentials", async () => {
  assertSupportedConfig("json_list", source.config);
  let candidates = await fetchJsonList(source);
  assert.equal(candidates[0]?.url, `${base}/published-1/`);
  assert.equal(candidates[0]?.title, "Original title 1");
  assert.deepEqual(candidates[0]?.raw, { externalId: 1 });
  edition = 2;
  candidates = await fetchJsonList(source);
  assert.equal(candidates[0]?.url, `${base}/published-2/`);
  assert.equal(candidates[0]?.publishedAt?.toISOString(), "2026-10-12T00:00:00.000Z");
  assert.ok(requests.filter(r => r.path === "/listing.json").every(r => r.auth === "only-the-listing"));
  assert.ok(requests.filter(r => r.path === "/index.json").every(r => r.auth === undefined));
});

test("conflicting, restricted, unrelated or incomplete indices fail rather than inventing article slugs", async () => {
  for (const [mode, expected] of [["ambiguous", /ambiguous/], ["offsite", /publisher origin/], ["empty", /nonempty array/],
    ["unmatched", /no items mapped/], ["redirect", /redirects/], ["html", /non-JSON/], ["invalid", /not JSON/], ["large", /large|bytes|size|limit/i]] as const) {
    indexMode = mode;
    await assert.rejects(fetchJsonList(source), expected, mode);
  }
  assert.ok(!requests.some(r => r.path === "/must-not-follow"));
  indexMode = "normal";
});

test("URL index configuration is explicit and same-origin; ordinary JSON mappings keep working", async () => {
  for (const patch of [{ url: "https://other.example/index.json" }, { url: `${base}/not-json` }, { keyPath: "__proto__.id" }, { valuePath: "" }])
    assert.throws(() => assertSupportedConfig("json_list", { ...source.config, urlLookup: { ...rule, ...patch } }), /urlLookup/);
  const plain = { ...source, config: { url: `${base}/listing.json`, titlePaths: ["title"], urlTemplate: "https://example.org/read/{link.to}" } };
  assert.equal((await fetchJsonList(plain))[0]?.url, "https://example.org/read/2");
});
