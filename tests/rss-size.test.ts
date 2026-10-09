import "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { config } from "@aihot/backend/config";
import { fetchRss } from "@aihot/backend/sources/rss";
import type { SourceRow } from "@aihot/backend/sources/types";

test("large RSS subscriptions can opt into a bounded limit without changing the default", async () => {
  const xml = `<rss version="2.0"><channel><item><title>Large feed</title><link>https://example.com/large</link>
    <description>${"x".repeat(9 * 1024 * 1024)}</description></item></channel></rss>`;
  const server = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "application/rss+xml" }); res.end(xml); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const previous = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  const source: SourceRow = { id: "large-rss", name: "Large RSS", kind: "rss", config: { feedUrl: `http://127.0.0.1:${port}/rss` },
    tier: "T2", participation_mode: "editorial", first_party: false, interval_minutes: 60, enabled: true, cursor: null, fail_count: 0 };
  try {
    await assert.rejects(fetchRss(source), /Response too large/);
    source.config.rssMaxBytes = 16 * 1024 * 1024;
    const result = await fetchRss(source);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]!.title, "Large feed");
    source.config.rssMaxBytes = 33 * 1024 * 1024;
    await assert.rejects(fetchRss(source), /rssMaxBytes/);
  } finally {
    config.allowPrivateNetworkFetch = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
