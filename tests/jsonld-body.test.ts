import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readable } from "@aihot/backend/content/extract";

const prose = "Education outcomes and AI deployment require measured evidence across the investment portfolio. ".repeat(35);
const page = (nodes: unknown) => `<html><head><script type="application/ld+json">${JSON.stringify(nodes).replace(/</g, "\\u003c")}</script></head><body><article><p>${"Unrelated viewer navigation. ".repeat(50)}</p></article></body></html>`;
const report = { "@type": "CreativeWork", text: `<p>${prose}</p><script>unsafe()</script>`, dateCreated: "2025-10-27", dateModified: "2026-05-22" };

test("an opted-in JSON-LD report preserves its full text and excludes viewer chrome", () => {
  const body = readable(page({ "@graph": [report, { "@type": "WebSite", text: "Unrelated" }] }), "https://example.org/report", null, "CreativeWork");
  assert.ok(body);
  assert.equal(body.via, "jsonld");
  assert.equal(body.text, prose.trim());
  assert.ok(!body.html.includes("unsafe"));
});

test("missing, short or ambiguous report metadata fails closed", () => {
  for (const nodes of [{ "@type": "CreativeWork", description: prose }, { "@type": "CreativeWork", text: "Short summary" }, [report, { "@type": "CreativeWork", text: "Another report. ".repeat(50) }]]) {
    assert.equal(readable(page(nodes), "https://example.org/report", null, "CreativeWork"), null);
  }
});

test("duplicate identical report metadata is accepted once, with no implicit metadata fallback", () => {
  const body = readable(page([report, report]), "https://example.org/report", null, "CreativeWork");
  assert.equal(body?.text, prose.trim());
  assert.equal(readable(page(report), "https://example.org/report", ".missing", "CreativeWork"), null);
  assert.equal(readable(page(report), "https://example.org/report")?.via, "readability");
});
