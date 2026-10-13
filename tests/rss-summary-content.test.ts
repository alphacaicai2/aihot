import "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { config } from "@aihot/backend/config";
import { fetchRss } from "@aihot/backend/sources/rss";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";
import type { SourceRow } from "@aihot/backend/sources/types";

test("publisher content fields that only contain summaries do not bypass article extraction", async () => {
  const content = "This publisher puts a long introduction in its content field. ".repeat(30);
  const rss = `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item>
    <title>Article</title><link>https://example.com/article</link><content:encoded><![CDATA[<p>${content}</p>]]></content:encoded>
    </item></channel></rss>`;
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Article</title>
    <link href="https://example.com/article"/><content type="html">&lt;p&gt;${content}&lt;/p&gt;</content></entry></feed>`;
  const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/xml" }); res.end(req.url === "/rss" ? rss : atom); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const previous = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  try {
    for (const kind of ["rss", "atom"]) {
      const source: SourceRow = { id: "summary-content", name: "Summary content", kind: "rss", config: { feedUrl: `http://127.0.0.1:${port}/${kind}` },
        tier: "T2", participation_mode: "editorial", first_party: false, interval_minutes: 60, enabled: true, cursor: null, fail_count: 0 };
      const original = (await fetchRss(source)).candidates[0]!;
      assert.equal(original.bodyStatus, "ok");
      assert.match(original.bodyText!, /long introduction/);
      source.config.feedContentIsSummary = true;
      assertSupportedConfig("rss", source.config);
      const summary = (await fetchRss(source)).candidates[0]!;
      assert.equal(summary.bodyStatus, "pending");
      assert.equal(summary.bodyText, null);
      assert.equal(summary.bodyHtml, null);
      assert.match(summary.excerpt!, /long introduction/);
      assert.equal(summary.url, original.url);
      assert.equal(summary.title, original.title);
    }
  } finally {
    config.allowPrivateNetworkFetch = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
