import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSupportedConfig, UnsupportedConfig } from "@aihot/backend/sources/config-keys";

const json = { selector: "script[type='application/json']", path: "post.content", format: "html" };
const markdown = { urlTemplate: "https://example.org{path}.md" };
const linked = { selector: "script[src]", attribute: "src", allowedOrigins: ["https://example.org"] };

test("body readers reject empty and non-object configurations", () => {
  for (const key of ["bodyExtractionJson", "bodyExtractionMarkdown", "bodyExtractionLinkedHtml"]) {
    for (const value of [{}, null, [], "reader", true, 1]) {
      assert.throws(() => assertSupportedConfig("rss", { [key]: value }), UnsupportedConfig, `${key}: ${JSON.stringify(value)}`);
    }
  }
});

test("Markdown readers require a usable article URL template", () => {
  for (const urlTemplate of [undefined, "", " ", 1, "https://example.org/static.md", "https://example.org/{unknown}",
    "https://example.org/{slug}/{unknown}", "https://example.org/{slug}{", "https://example.org/{slug}}",
    "ftp://example.org/{slug}", "https://user:pass@example.org/{slug}"]) {
    assert.throws(() => assertSupportedConfig("web_list", { bodyExtractionMarkdown: { urlTemplate } }), UnsupportedConfig);
  }
});

test("JSON readers require one entry point, a body path and supported format and options", () => {
  for (const patch of [{ selector: undefined }, { selector: " " }, { selector: 1 }, { path: undefined }, { path: "" },
    { path: 1 }, { path: "post..content" }, { format: undefined }, { format: "text" }, { adapter: "unknown" }, { adapter: ["sanity_article"] },
    { adapter: "sanity_article", format: "markdown" }, { bodySelector: 1 }, { bodySelector: "" },
    { bodySelector: "article", format: "markdown" }, { urlTemplate: "https://example.org/{slug}" },
    { selector: undefined, urlTemplate: "https://example.org/static" }]) {
    assert.throws(() => assertSupportedConfig("rss", { bodyExtractionJson: { ...json, ...patch } }), UnsupportedConfig, JSON.stringify(patch));
  }
});

test("linked readers require a selector, supported attribute and exact HTTP origins", () => {
  for (const patch of [{ selector: undefined }, { selector: " " }, { selector: 1 }, { attribute: undefined }, { attribute: "data-src" },
    { allowedOrigins: undefined }, { allowedOrigins: [] }, { allowedOrigins: "https://example.org" },
    { allowedOrigins: [1] }, { allowedOrigins: ["https://example.org/path"] }, { allowedOrigins: ["ftp://example.org"] },
    { stripPathSuffix: 1 }, { bodySelector: false }, { format: ["html"] }]) {
    assert.throws(() => assertSupportedConfig("rss", { bodyExtractionLinkedHtml: { ...linked, ...patch } }), UnsupportedConfig, JSON.stringify(patch));
  }
});

test("explicit readers reject conflicting extraction rules", () => {
  const readers = [{ bodyExtractionJson: json }, { bodyExtractionMarkdown: markdown }, { bodyExtractionLinkedHtml: linked }, { bodyExtractionPdf: true }];
  for (let i = 0; i < readers.length; i++) {
    for (const other of [...readers.slice(i + 1), { bodySelector: "article" }, { bodyJsonLdType: "Article" }]) {
      assert.throws(() => assertSupportedConfig("rss", { ...readers[i], ...other }), UnsupportedConfig);
    }
  }
});

test("complete body readers and ordinary source configurations remain supported", () => {
  for (const config of [{}, { feedUrl: "https://example.org/feed" }, { bodySelector: "article" }, { bodyExtractionPdf: false },
    { bodyExtractionJson: json }, { bodyExtractionJson: { ...json, format: "markdown" } },
    { bodyExtractionJson: { urlTemplate: "https://example.org/{slug}", path: "0.content", format: "html" } },
    { bodyExtractionJson: { urlTemplate: "https://example.org/read", method: "POST", bodyJson: { id: "{slug}" }, path: "content", format: "html" } },
    ...["magnolia_article", "sanity_article"].map(adapter => ({ bodyExtractionJson: { ...json, adapter } })),
    { bodyExtractionMarkdown: markdown }, { bodyExtractionMarkdown: { urlTemplate: "https://example.org/{slug}.md" } },
    { bodyExtractionLinkedHtml: linked }, { bodyExtractionLinkedHtml: { ...linked, format: "adobe_pdf", pdfOrigins: ["https://example.org"] } },
    { bodyExtractionPdf: true }]) {
    assert.doesNotThrow(() => assertSupportedConfig("rss", config));
  }
});
