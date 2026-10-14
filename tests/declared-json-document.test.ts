import "./setup.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import { htmlJsonDocument, javascriptArray, textBlocks } from "@aihot/backend/sources/javascript-array";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";
import { extractFromUrl } from "@aihot/backend/content/extract";

let base = "", edition = 1;
const requests: Array<{ path: string; authorization?: string }> = [];
const script = (url: string) => `<script>globalThis.publisherCodeMustNotRun = true; var U=${JSON.stringify(url)}; fetch(U);</script>`;
const server = createServer((req, res) => {
  requests.push({ path: req.url!, authorization: req.headers.authorization });
  if (req.url === "/listing") {
    res.setHeader("content-type", "text/html"); res.end(script(`${base}/edition-${edition}.json`));
  } else if (req.url?.startsWith("/edition-")) {
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify([{ id: String(edition), title: `Research edition ${edition}`, date: "2026-09-04" }]));
  } else if (req.url === "/redirect.json") {
    res.statusCode = 302; res.setHeader("location", `${base}/never-follow.json`); res.end();
  } else if (req.url === "/plain-json") {
    res.setHeader("content-type", "text/plain; charset=utf-8"); res.end(JSON.stringify({ post: { contentMarkdown: `## Published research\n\n${"Industry analysis with complete original discussion. ".repeat(20)}` } }));
  } else if (req.url === "/plain-html") {
    res.setHeader("content-type", "text/plain"); res.end("<html><body>Not a JSON document.</body></html>");
  } else if (req.url === "/string-blocks") {
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify([{ id: "original", title: "Industry research", content: ["## Published section", "Literal <model> text and original analysis."] }]));
  } else { res.setHeader("content-type", "text/html"); res.end("Unrelated page"); }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
const rule = { selector: "script", variable: "U", allowedOrigins: [base] };

test("collection follows the publisher's current declared JSON URI and does not forward listing credentials", async () => {
  const source = { id: "declared-json", kind: "json_list", config: { url: `${base}/listing`, mode: "html_json_document", jsonDocument: rule,
    headers: { authorization: "local-listing-only" }, titlePaths: ["title"], publishedAtPath: "date", urlTemplate: "https://example.org/research/{id}" } } as never;
  assertSupportedConfig("json_list", (source as any).config);
  assert.equal((await fetchJsonList(source))[0]?.title, "Research edition 1");
  edition = 2;
  assert.equal((await fetchJsonList(source))[0]?.title, "Research edition 2", "the immutable old asset is no longer the subscription entry");
  assert.equal(requests.filter(r => r.path === "/listing").every(r => r.authorization === "local-listing-only"), true);
  assert.equal(requests.filter(r => r.path.startsWith("/edition-")).every(r => r.authorization === undefined), true);
  assert.equal((globalThis as any).publisherCodeMustNotRun, undefined);
});

test("dynamic, ambiguous, off-origin, redirecting and non-JSON documents fail without a fallback", async () => {
  await assert.rejects(htmlJsonDocument(`<script>var U = buildUrl(); fetch(U);</script>`, base, { jsonDocument: rule }), /not a static literal/);
  await assert.rejects(htmlJsonDocument(script(`${base}/edition-1.json`) + script(`${base}/edition-2.json`), base, { jsonDocument: rule }), /ambiguous/);
  await assert.rejects(htmlJsonDocument(script("https://unrelated.example/private.json"), base, { jsonDocument: rule }), /declared public origin/);
  await assert.rejects(htmlJsonDocument(script(`${base}/redirect.json`), base, { jsonDocument: rule }), /redirects/);
  await assert.rejects(htmlJsonDocument(script(`${base}/not-json.json`), base, { jsonDocument: rule }), /non-JSON/);
  await assert.rejects(htmlJsonDocument(`<script>var U=${JSON.stringify(`${base}/edition-1.json`)};</script>`, base, { jsonDocument: rule }), /missing/);
  await assert.rejects(htmlJsonDocument(`<script>var U=${JSON.stringify(`${base}/edition-1.json`)};U=other;fetch(U);</script>`, base, { jsonDocument: rule }), /reassigned/);
  assert.ok(!requests.some(r => r.path === "/never-follow.json"));
  assert.throws(() => assertSupportedConfig("json_list", { mode: "html_json_document", jsonDocument: { ...rule, allowedOrigins: ["https://example.org/path"] } }), /exact HTTP origins/);
  assert.throws(() => assertSupportedConfig("json_list", { jsonDocument: rule }), /requires html_json_document/);
});

test("text/plain JSON bodies require an explicit opt-in and remain strict JSON with the declared body path", async () => {
  const sourceUrl = "https://example.org/plain-json";
  const bodyRule = { urlTemplate: `${base}/{slug}`, path: "post.contentMarkdown", format: "markdown" as const };
  assert.equal(await extractFromUrl(sourceUrl, { allowJina: false, subject: "test", bodyExtractionJson: bodyRule }), null);
  const target = sourceUrl;
  const explicit = { ...bodyRule, urlTemplate: `${base}/{slug}`, allowPlainTextJson: true };
  assert.ok((await extractFromUrl(target, { allowJina: false, subject: "test", bodyExtractionJson: explicit }))?.text.includes("Industry analysis"));
  assert.equal(await extractFromUrl("https://example.org/plain-html", { allowJina: false, subject: "test", bodyExtractionJson: explicit }), null);
  assert.equal(await extractFromUrl(target, { allowJina: false, subject: "test", bodyExtractionJson: { ...explicit, path: "post.missing" } }), null);
  assert.throws(() => assertSupportedConfig("rss", { bodyExtractionJson: { ...explicit, allowPlainTextJson: "true" } }), /boolean required/);
});

test("published Markdown string blocks require an explicit format and preserve every original paragraph", async () => {
  const source = { id: "string-blocks", kind: "json_list", config: { url: `${base}/string-blocks`, titlePaths: ["title"], urlTemplate: "https://example.org/{id}", summaryBlocksPath: "content", summaryIsBody: true } } as any;
  await assert.rejects(fetchJsonList(source), /unsupported summary block/);
  source.config.summaryBlocksFormat = "markdown_strings";
  const [article] = await fetchJsonList(source);
  assert.equal(article?.bodyText, "## Published section\n\nLiteral <model> text and original analysis.");
  assert.equal(article?.bodyStatus, "ok");
  assert.throws(() => textBlocks(["First paragraph", { text: "Unknown shape" }], "markdown_strings"), /unsupported Markdown string/);
  assert.throws(() => assertSupportedConfig("json_list", { summaryBlocksFormat: "markdown_strings" }), /block path required/);
  assertSupportedConfig("json_list", source.config);
});

test("an opted-in literal Markdown paragraph join remains static and rejects arbitrary calls", async () => {
  const source = 'const posts=[{id:"original",title:"Research",content:["## Original section","Literal <model> prose."].join("\\n\\n")}];';
  await assert.rejects(javascriptArray(source, ["id", "title"]), /non-static call/);
  const [article] = await javascriptArray(source, ["id", "title"], undefined, undefined, "array", true) as any[];
  assert.equal(textBlocks(article.content, "markdown_strings"), "## Original section\n\nLiteral <model> prose.");
  for (const text of [source.replace('.join("\\n\\n")', '.map(runCode)'), source.replace('.join("\\n\\n")', '.join(separator)'), source.replace('.join("\\n\\n")', '.join(" ")'), source.replace('"Literal <model> prose."', 'readHiddenContent()')])
    await assert.rejects(javascriptArray(text, ["id", "title"], undefined, undefined, "array", true), /non-static|unsupported/);
});
