import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { fetchRss } from "@aihot/backend/sources/rss";
import { fetchWebList, fetchDetail } from "@aihot/backend/sources/web-list";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { upsertMaterial } from "@aihot/backend/content/materials";
import type { SourceRow } from "@aihot/backend/sources/types";

// Some publishers reject browser-looking headers on server collectors. The source's explicit
// crawler identity must survive RSS revalidation and remain usable for the later extraction job.
test("a source crawler identity reaches listings, redirected RSS retries, details and body jobs", async () => {
  const userAgent = "ResearchBot/1.0 (+https://example.org/about)";
  let newTarget = false;
  const hits: Array<{ path: string; etag: string | undefined }> = [];
  const paragraph = "AI infrastructure research examines the economics of inference and enterprise adoption. ".repeat(30);
  const server = http.createServer((req, res) => {
    if (req.headers["user-agent"] !== userAgent) { res.writeHead(403); res.end(); return; }
    const path = req.url!;
    hits.push({ path, etag: req.headers["if-none-match"] });
    if (path === "/redirect") { res.writeHead(302, { location: newTarget ? "/new.xml" : "/old.xml" }); res.end(); return; }
    if (path.endsWith(".xml")) {
      if (req.headers["if-none-match"] === '"shared"') { res.writeHead(304, { etag: '"shared"' }); res.end(); return; }
      res.writeHead(200, { "content-type": "application/rss+xml", etag: '"shared"' });
      res.end(`<rss><channel><item><title>AI research</title><link>https://example.org${path}</link></item></channel></rss>`); return;
    }
    if (path === "/json") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify([{ title: "AI research", link: "https://example.org/research" }])); return; }
    if (path.startsWith("/body-api/")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ content: `<p>${paragraph}</p><script>unsafe()</script>`, createdAt: "2026-10-13" })); return; }
    if (path.startsWith("/markdown/")) {
      res.writeHead(200, { "content-type": path.endsWith("invalid") ? "text/html" : "text/markdown" });
      res.end(`# Original research\n\nJanuary 14, 2026\n\n${paragraph}`); return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    if (path === "/report") {
      res.end(`<html><head><script type="application/ld+json">${JSON.stringify({ "@type": "CreativeWork", text: paragraph })}</script></head><body>Unrelated viewer navigation</body></html>`); return;
    }
    res.end(path === "/list" ? '<article><a href="/body">AI research</a></article>' : `<html><title>AI research</title><body><article><section id="research"><h1>AI research</h1><p>${paragraph}</p></section><p>${"Unrelated portfolio content. ".repeat(100)}</p></article></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const previous = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  const source: SourceRow = { id: `crawler-${tag()}`, name: "Research", kind: "rss", config: { feedUrl: base + "/redirect", userAgent, bodySelector: "#research" },
    tier: "T2", participation_mode: "editorial", first_party: false, interval_minutes: 60, enabled: true, cursor: null, fail_count: 0 };
  try {
    const first = await fetchRss(source);
    source.cursor = { rss: first.validator };
    newTarget = true;
    assert.equal((await fetchRss(source)).candidates[0]!.url, "https://example.org/new.xml");
    assert.deepEqual(hits.filter(h => h.path === "/new.xml"), [{ path: "/new.xml", etag: '"shared"' }, { path: "/new.xml", etag: undefined }]);
    const web = { ...source, kind: "web_list" as const, config: { url: base + "/list", userAgent, detail: { titleSelector: "h1" } } };
    assert.equal((await fetchWebList(web)).length, 1);
    assert.ok((await fetchDetail(base + "/body", web, { title: true, date: false, summary: false, body: true })).body?.text.includes(paragraph.trim()));
    const json = { ...source, kind: "json_list" as const, config: { url: base + "/json", userAgent, titlePaths: ["title"], urlTemplate: "{raw:link}" } };
    assert.equal((await fetchJsonList(json)).length, 1);
    await sql`INSERT INTO sources (id,name,kind,config) VALUES (${source.id},'Research','rss',${sql.json(source.config)})`;
    const { articleId } = await upsertMaterial({ sourceId: source.id, url: base + "/body", title: "AI research", via: "fetch" });
    assert.equal(await extractArticleBody(articleId, false), "ok");
    const [stored] = await sql`SELECT body_text FROM articles WHERE id=${articleId}`;
    assert.ok(stored.body_text.includes(paragraph.trim()));
    assert.ok(!stored.body_text.includes("Unrelated portfolio"));
    await sql`UPDATE sources SET config = ${sql.json({ feedUrl: base + "/redirect", userAgent, bodyJsonLdType: "CreativeWork" })} WHERE id = ${source.id}`;
    const report = await upsertMaterial({ sourceId: source.id, url: base + "/report", title: "Education report", via: "fetch" });
    assert.equal(await extractArticleBody(report.articleId, false), "ok");
    const [storedReport] = await sql`SELECT body_text, published_at FROM articles WHERE id=${report.articleId}`;
    assert.equal(storedReport.body_text, paragraph.trim());
    assert.equal(storedReport.published_at, null);
    const bodyExtractionJson = { urlTemplate: base + "/body-api/{slug}", path: "content", format: "html" };
    await sql`UPDATE sources SET config = ${sql.json({ feedUrl: base + "/redirect", userAgent, bodyExtractionJson })} WHERE id = ${source.id}`;
    const apiArticle = await upsertMaterial({ sourceId: source.id, url: base + "/articles/insurance", title: "Insurance research", via: "fetch" });
    assert.equal(await extractArticleBody(apiArticle.articleId, false), "ok");
    const [storedApi] = await sql`SELECT body_text,published_at FROM articles WHERE id=${apiArticle.articleId}`;
    assert.equal(storedApi.body_text, paragraph.trim());
    assert.equal(storedApi.published_at, null);
    assert.ok(hits.some(h => h.path === "/body-api/insurance"));
    const bodyExtractionMarkdown = { urlTemplate: base + "/markdown/{slug}" };
    const markdownSource = { ...web, config: { url: base + "/list", userAgent, bodyExtractionMarkdown, detail: { titleRegex: "^# (.+)", publishedAtRegex: "(January \\d{1,2}, \\d{4})", publishedAtAuthoritative: true, publishedAtUtcOffset: "+00:00" } } };
    const nativeDetail = await fetchDetail(base + "/articles/native", markdownSource, { date: true, title: true, summary: false, body: true });
    assert.equal(nativeDetail.title, "Original research");
    assert.equal(nativeDetail.publishedAt?.toISOString(), "2026-01-14T00:00:00.000Z");
    assert.ok(nativeDetail.body?.text.includes(paragraph.trim()));
    const invalid = await fetchDetail(base + "/articles/invalid", markdownSource, { date: true, title: true, summary: false, body: true });
    assert.deepEqual(invalid, { publishedAt: null, title: null, summary: null, body: null });
    await sql`UPDATE sources SET config = ${sql.json({ feedUrl: base + "/redirect", userAgent, bodyExtractionMarkdown })} WHERE id = ${source.id}`;
    const nativeArticle = await upsertMaterial({ sourceId: source.id, url: base + "/articles/native", title: "Native research", via: "fetch" });
    assert.equal(await extractArticleBody(nativeArticle.articleId, false), "ok");
    const [storedNative] = await sql`SELECT body_text,published_at FROM articles WHERE id=${nativeArticle.articleId}`;
    assert.ok(storedNative.body_text.includes(paragraph.trim()));
    assert.equal(storedNative.published_at, null);
    assert.ok(hits.some(h => h.path === "/markdown/native"));
  } finally {
    config.allowPrivateNetworkFetch = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await closeDb();
  }
});
