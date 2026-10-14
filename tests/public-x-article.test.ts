import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publicXArticle } from "@aihot/backend/content/x-article";
import { extractFromUrl } from "@aihot/backend/content/extract";
import { collectSource } from "@aihot/backend/sources/collect";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";

const T = tag(), original = "Published research compares operating costs, deployment constraints and the reliability of production AI systems. ".repeat(8);
const postId = `${Date.now()}${Math.floor(Math.random() * 1e9).toString().padStart(9, "0")}`;
const url = `https://x.com/testpublisher/status/${postId}`;
const block = (type: string, text: string, extra = {}) => ({ type, text, entityRanges: [], inlineStyleRanges: [], ...extra });
const tweet = () => ({ id: postId, url, author: { screen_name: "testpublisher", protected: false }, article: {
  title: "Original industry analysis", created_at: "2026-09-04T12:34:56.000Z", modified_at: "2026-10-10T13:00:00.000Z", preview_text: "Preview is not the body.",
  content: { entityMap: [{ key: "0", value: { type: "MEDIA", data: { mediaItems: [{ mediaId: "555" }], caption: "A chart caption <without invented OCR>." } } }], blocks: [
    block("header-two", "The research"), block("unstyled", original, { inlineStyleRanges: [{ offset: 0, length: 9, style: "Bold" }, { offset: 5, length: 12, style: "Italic" }] }),
    block("ordered-list-item", "First observation"), block("unordered-list-item", "Nested observation", { depth: 1 }), block("ordered-list-item", "Second observation"),
    block("atomic", " ", { entityRanges: [{ key: 0, offset: 0, length: 1 }] }), block("unstyled", "Literal <model> & <script> text remains writing."),
  ] }, media_entities: [{ media_id: "555", media_info: { __typename: "ApiImage", original_img_url: "https://pbs.twimg.com/media/original.png" } }],
} });

test("public Draft.js writing retains paragraphs, overlapping styles, nested lists and mapped image captions", () => {
  const result = publicXArticle(tweet(), url)!;
  assert.ok(result);
  assert.equal(result.title, "Original industry analysis");
  assert.equal(result.publishedAt?.toISOString(), "2026-09-04T12:34:56.000Z");
  assert.match(result.html, /<ol><li>First observation\s*<ul><li>Nested observation\s*<\/li><\/ul>\s*<\/li><li>Second observation/);
  assert.match(result.html, /<strong>/); assert.match(result.html, /<em>/);
  assert.match(result.html, /<figure><img src="https:\/\/pbs.twimg.com\/media\/original.png"/);
  assert.match(result.html, /caption &lt;without invented OCR&gt;/);
  assert.match(result.html, /Literal &lt;model&gt; &amp; &lt;script&gt;/);
  assert.ok(!result.html.includes("Preview is not the body"));
});

test("restricted or mismatched identities and incomplete block/entity data never confirm a partial body", () => {
  for (const mutate of [
    (t: any) => { t.author.protected = true; }, (t: any) => { delete t.author.protected; },
    (t: any) => { t.id = "999"; }, (t: any) => { t.author.screen_name = "someoneelse"; }, (t: any) => { t.url = "https://x.com/other/status/1234567890"; },
    (t: any) => { t.article.content.blocks.push(block("unsupported-embed", original)); },
    (t: any) => { t.article.content.entityMap = {}; }, (t: any) => { t.article.content.entityMap.push(t.article.content.entityMap[0]); },
    (t: any) => { t.article.media_entities = []; }, (t: any) => { t.article.media_entities[0].media_info.__typename = "ApiVideo"; },
    (t: any) => { t.article.content.blocks[1].inlineStyleRanges[0].length = 99999; },
  ]) { const t = tweet(); mutate(t); assert.equal(publicXArticle(t, url), null); }
  assert.equal(publicXArticle(tweet(), "https://x.com/i/article/1234567890"), null);
  const unknown = tweet(); delete (unknown.article as any).created_at;
  assert.equal(publicXArticle(unknown, url)?.publishedAt, null, "no date from modified_at or tweet time");
});

let endpoint = "";
let bad = false;
const server = createServer((req, res) => {
  if (req.url === "/listing") {
    res.setHeader("content-type", "text/html"); res.end(`<article><a href="${url}">Wrong duplicate card title</a><time>2025-12-30</time></article><article><a href="${url}">Another card</a><time>2025-11-20</time></article>`);
  } else {
    res.setHeader("content-type", "application/json"); const t = tweet();
    if (bad) t.author.protected = true;
    res.end(JSON.stringify({ tweet: t }));
  }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await stopBoss(); await closeDb(); });
const rule = { urlTemplate: `${endpoint}/status/{slug}`, path: "tweet", format: "html" as const, adapter: "x_article" as const };

test("explicit JSON extraction preserves literal writing and media, and refuses preview fallback", async () => {
  const result = await extractFromUrl(url, { allowJina: false, subject: "test", bodyExtractionJson: rule });
  assert.ok(result); assert.ok(result.text.includes(original.trim()));
  assert.ok(result.text.includes("Literal <model> & <script> text remains writing."));
  assert.deepEqual(result.images.map(i => i.url), ["https://pbs.twimg.com/media/original.png"]);
  assert.equal(await extractFromUrl(url, { allowJina: false, subject: "test", bodyExtractionJson: { ...rule, bodySelector: "p" } }), null);
  bad = true;
  assert.equal(await extractFromUrl(url, { allowJina: false, subject: "test", bodyExtractionJson: rule }), null);
  bad = false;
  assertSupportedConfig("web_list", { bodyExtractionJson: rule });
  for (const extra of [{ format: "markdown" }, { path: "tweet.article.preview_text" }, { bodySelector: "p" }, { selector: "script" }])
    assert.throws(() => assertSupportedConfig("web_list", { bodyExtractionJson: { ...rule, ...extra } }), /complete tweet/);
});

test("official-list collection uses original article metadata and keeps the imported body stable on repeat", async () => {
  const id = `public-x-article-${T}`;
  const c = { url: `${endpoint}/listing`, itemSelector: "article", linkSelector: "a", titleSelector: "a", publishedAtSelector: "time", bodyExtractionJson: rule,
    detail: { maxFetches: 3, titleSelector: "h1", titleAuthoritative: true, publishedAtAuthoritative: true }, _aihot: { initialBackfillLimit: 3, initialBackfillMonths: 12, skipInitialRemainder: true } };
  await sql`INSERT INTO sources(id,name,kind,config,tier,participation_mode,next_fetch_at) VALUES(${id},'Public original writing','web_list',${sql.json(c)},'T2','editorial','2100-01-01')`;
  const first = await collectSource(id); assert.deepEqual([first.status, first.created], ["ok", 1]);
  const [row] = await sql`SELECT title,published_at,body_text,body_status,revision FROM articles WHERE source_id=${id}`;
  assert.equal(row.title, "Original industry analysis"); assert.equal(new Date(row.published_at).toISOString(), "2026-09-04T12:34:56.000Z");
  assert.equal(row.body_status, "ok"); assert.ok(row.body_text.includes(original.trim())); assert.equal(row.revision, 1);
  const repeat = await collectSource(id); assert.deepEqual([repeat.status, repeat.created, repeat.revised], ["ok", 0, 0]);
});
