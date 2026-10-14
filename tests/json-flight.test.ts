// Next.js listings embed research posts with contributor/sector arrays in Flight strings.
import "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import type { SourceRow } from "@aihot/backend/sources/types";

const posts = [
  { title: 'AI [infrastructure] and "agents"', path: "/atlas/ai", publishedAt: "2026-10-06T17:56:00Z", sectors: [{ slug: "ai" }], contributors: [] },
  { title: "Cloud economics", path: "/atlas/cloud", publishedAt: "2026-09-25T10:00:00Z", sectors: [], contributors: [{ name: "Research team" }] },
];
const flight = (payload: string) => `<script>self.__next_f.push(${JSON.stringify([1, payload])})</script>`;
let html = "";
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(html);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
const source: SourceRow = { id: "test-flight", name: "Test Flight", kind: "json_list",
  tier: "T2", participation_mode: "editorial", first_party: false, interval_minutes: 60,
  enabled: true, cursor: null, fail_count: 0, config: {
  url: base, mode: "html_json_key", jsonKey: "posts", titlePaths: ["title"],
  urlTemplate: "https://example.org{raw:path}", publishedAtPath: "publishedAt",
} };
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test("Flight listing preserves every post, nested arrays, and brackets in titles", async () => {
  html = flight(`4a:I[123,[],"PostGrid"]\nc:["$","component",null,${JSON.stringify({ posts, other: [] })}]`);
  const rows = await fetchJsonList(source);
  assert.deepEqual(rows.map((r) => [r.title, r.url, r.publishedAt?.toISOString()]), [
    [posts[0]!.title, "https://example.org/atlas/ai", "2026-10-06T17:56:00.000Z"],
    [posts[1]!.title, "https://example.org/atlas/cloud", "2026-09-25T10:00:00.000Z"],
  ]);
});

test("a malformed Flight block does not conceal a later valid listing", async () => {
  html = flight('c:{"posts":[{"broken":true}') + flight(`c:${JSON.stringify({ posts })}`);
  assert.equal((await fetchJsonList(source)).length, 2);
});

test("non-array properties are skipped and Flight content is never executed", async () => {
  html = flight(`c:{"posts":"$ref"}\nd:${JSON.stringify({ posts })}`);
  assert.equal((await fetchJsonList(source)).length, 2);
  html = '<script>self.__next_f.push([1, (() => { throw Error("executed"); })()])</script>';
  await assert.rejects(fetchJsonList(source), /embedded key posts not found/);
});
