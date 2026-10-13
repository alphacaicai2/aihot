import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";
import { readable } from "@aihot/backend/content/extract";

const prose = "Original investment research examines deployment economics and the infrastructure supporting real customers. ".repeat(30);
const rule = { selector: 'script#__NEXT_DATA__[type="application/json"]', path: "props.pageProps.post.content", format: "markdown" as const };
const page = (value: unknown, extra = "") => `<html><head><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(value).replace(/</g, "\\u003c")}</script>${extra}</head><body><article><p>${"Unrelated navigation and related articles. ".repeat(80)}</p></article></body></html>`;
const data = { props: { pageProps: { post: { content: `## Original research\n\n${prose}\n\n[Primary source](https://example.org/report)`, createdAt: "2026-10-13", postedAt: "2025-10-21" } } } };

test("an opted-in JSON script preserves the complete Markdown article without evaluating scripts", () => {
  const body = readable(page(data), "https://example.org/article", null, null, rule);
  assert.equal(body?.via, "embedded-json");
  assert.ok(body?.text.includes(prose.trim()));
  assert.ok(body?.html.includes('<h3>Original research</h3>'));
  assert.ok(body?.html.includes('href="https://example.org/report"'));
  assert.ok(!body?.text.includes("Unrelated navigation"));
  assert.ok(!body?.text.includes("2026-10-13"));
});

test("missing, short, nonstring and ambiguous embedded bodies cannot fall back to surrounding page content", () => {
  for (const value of [{ props: { pageProps: { post: { description: prose } } } }, { props: { pageProps: { post: { content: "Short preview" } } } }, { props: { pageProps: { post: { content: { text: prose } } } } }]) {
    assert.equal(readable(page(value), "https://example.org/article", null, null, rule), null);
  }
  assert.equal(readable(page(data, '<script id="__NEXT_DATA__" type="application/json">{}</script>'), "https://example.org/article", null, null, rule), null);
  assert.equal(readable(page(data), "https://example.org/article", ".article", null, rule), null);
  assert.equal(readable(page(data), "https://example.org/article", null, "CreativeWork", rule), null);
  assert.equal(readable(page(data), "https://example.org/article")?.via, "readability");
});

test("structured HTML is sanitized and a script with an executable type is refused", () => {
  const htmlRule = { ...rule, format: "html" as const };
  const value = { props: { pageProps: { post: { content: `<p>${prose}</p><script>unsafe()</script>` } } } };
  const body = readable(page(value), "https://example.org/article", null, null, htmlRule);
  assert.equal(body?.text, prose.trim());
  assert.ok(!body?.html.includes("unsafe"));
  assert.equal(readable(page(data).replace('type="application/json"', 'type="text/javascript"'), "https://example.org/article", null, null, { ...rule, selector: "script#__NEXT_DATA__" }), null);
});

test("ordered CMS article components retain all writing and FAQ entries without related-article content", () => {
  const rich = (text: string) => ({ "mgnl:template": "site-lm:components/richText", richText: `<p>${text}</p>` });
  const main = { "@nodes": ["second", "first", "faq", "related"], first: rich("FIRST " + prose), second: rich("SECOND " + prose),
    faq: { "mgnl:template": "site-lm:components/unorderedList", unorderedListItems: { "@nodes": ["one"], one: { itemTitle: "A real question", itemText: `<p>FAQ ${prose}</p>` } } },
    related: { "mgnl:template": "site-lm:components/insightsRelated", richText: "Unrelated material. ".repeat(100) } };
  const cmsRule = { ...rule, path: "main", format: "html" as const, adapter: "magnolia_article" as const };
  const body = readable(page({ main, footer: rich("Footer. ".repeat(100)) }), "https://example.org/article", null, null, cmsRule);
  assert.ok(body?.text.startsWith("SECOND"));
  assert.ok(body?.text.includes("FIRST"));
  assert.ok(body?.text.includes("A real question"));
  assert.ok(body?.text.includes("FAQ"));
  assert.ok(!body?.text.includes("Unrelated"));
  assert.ok(!body?.text.includes("Footer"));
  assert.equal(readable(page({ main: { ...main, unexpected: rich(prose), "@nodes": [...main["@nodes"], "unexpected-type"], "unexpected-type": { "mgnl:template": "site-lm:components/unknown", text: prose } } }), "https://example.org/article", null, null, cmsRule), null);
});


test("JSON HTML scoping excludes related stories and refuses missing or ambiguous containers", () => {
  const scoped = { ...rule, format: "html" as const, bodySelector: ".copy-body" };
  const bodyPage = (html: string) => page({ props: { pageProps: { post: { content: html } } } });
  const article = `<div class="copy-body"><p>${prose}</p></div>`;
  const body = readable(bodyPage(`${article}<aside>${"RELATED ".repeat(300)}</aside>`), "https://example.org/article", null, null, scoped);
  assert.equal(body?.text, prose.trim());
  assert.equal(readable(bodyPage(`<aside>${prose}</aside>`), "https://example.org/article", null, null, scoped), null);
  assert.equal(readable(bodyPage(article + article), "https://example.org/article", null, null, scoped), null);
});

test("article JSON extraction does not claim the existing JSON request-body option", () => {
  assert.deepEqual(unsupportedConfig("json_list", { url: "https://example.org/api", method: "POST", bodyJson: { query: "query { posts { title } }", variables: { limit: 10 } }, bodyExtractionJson: { urlTemplate: "https://example.org/posts/{slug}", path: "content", format: "html", bodySelector: ".copy-body" } }), []);
  assert.deepEqual(unsupportedConfig("rss", { bodyExtractionJson: { typo: true } }), ["bodyExtractionJson.typo"]);
});
