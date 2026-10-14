import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { config } from "@aihot/backend/config";
import { linkedHtmlTarget, type LinkedHtmlConfig } from "@aihot/backend/content/linked-html";
import { extractFromUrl } from "@aihot/backend/content/extract";
import { fetchDetail } from "@aihot/backend/sources/web-list";
import type { SourceRow } from "@aihot/backend/sources/types";

test("publisher embed selection is unique, scoped, and never executes JavaScript", () => {
  const rule: LinkedHtmlConfig = { selector: "script[data-publication]", attribute: "src", stripPathSuffix: "/embed.js", allowedOrigins: ["https://research.example"] };
  const page = "https://fund.example/report";
  const embed = '<script data-publication src="https://research.example/essay/embed.js"></script>';
  assert.equal(linkedHtmlTarget(embed, page, rule), "https://research.example/essay");
  assert.equal(linkedHtmlTarget(embed + embed, page, rule), "https://research.example/essay");
  assert.equal(linkedHtmlTarget(embed + '<script data-publication src="https://research.example/other/embed.js"></script>', page, rule), null);
  for (const target of ["javascript:alert(1)", "https://unrelated.example/essay/embed.js", "https://user:pass@research.example/essay/embed.js", "https://research.example/essay/not-an-embed.js"]) {
    assert.equal(linkedHtmlTarget(`<script data-publication src="${target}"></script>`, page, rule), null);
  }
  assert.equal(linkedHtmlTarget('<script data-publication>throw new Error("must not execute")</script>', page, rule), null);
  assert.equal(linkedHtmlTarget(embed, page, { ...rule, allowedOrigins: [] }), null);
  assert.equal(linkedHtmlTarget(embed, page, { ...rule, allowedOrigins: ["https://research.example/path"] }), null);
});

test("body and detail extraction follow one declared HTML publication, preserving canonical metadata", async () => {
  const requests: string[] = [];
  const prose = "Original investment analysis explains the economic constraints and the technology opportunity. ".repeat(12);
  const server = createServer((request, response) => {
    requests.push(request.url!);
    response.setHeader("content-type", "text/html");
    if (request.url === "/wrapper") response.end(`<h1>Canonical publication</h1><time>2026-08-18</time><nav>${"Wrong navigation. ".repeat(80)}</nav><script data-publication src="/essay/embed.js"></script>`);
    else if (request.url === "/essay") response.end(`<article><h1>Original</h1><p>${prose}</p></article><footer>Unrelated material</footer>`);
    else { response.statusCode = 404; response.end("Missing"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const previous = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  try {
    const rule: LinkedHtmlConfig = { selector: "script[data-publication]", attribute: "src", stripPathSuffix: "/embed.js", allowedOrigins: [origin], bodySelector: "article" };
    const body = await extractFromUrl(`${origin}/wrapper`, { allowJina: false, subject: "test", bodyExtractionLinkedHtml: rule });
    assert.ok(body);
    assert(body.text.includes(prose.trim()));
    assert.equal(body.via, "linked-html");
    assert(!body.text.includes("Wrong navigation"));
    assert.deepEqual(requests, ["/wrapper", "/essay"]);
    requests.length = 0;
    const source = { id: "test-linked", kind: "web_list", config: { bodyExtractionLinkedHtml: rule, detail: { titleSelector: "h1", publishedAtSelector: "time" } } } as unknown as SourceRow;
    const detail = await fetchDetail(`${origin}/wrapper`, source, { date: true, title: true, summary: false, body: true });
    assert.equal(detail.title, "Canonical publication");
    assert.equal(detail.publishedAt?.toISOString(), "2026-08-18T00:00:00.000Z");
    assert(detail.body?.text.includes(prose.trim()));
    assert.deepEqual(requests, ["/wrapper", "/essay"]);
    assert.equal(await extractFromUrl(`${origin}/wrapper`, { allowJina: false, subject: "test", bodyExtractionLinkedHtml: rule, bodySelector: "nav" }), null);
    const bad = { ...rule, selector: "script:not([data-publication])" };
    assert.equal(await extractFromUrl(`${origin}/wrapper`, { allowJina: false, subject: "test", bodyExtractionLinkedHtml: bad }), null);
  } finally {
    config.allowPrivateNetworkFetch = previous;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
