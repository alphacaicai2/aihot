import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readable } from "@aihot/backend/content/extract";

const paragraph = "AI infrastructure adoption depends on data security, operational control, and the economics of running inference. ".repeat(12);
const page = (content: string) => `<!doctype html><html><head><title>AI infrastructure</title></head><body>${content}</body></html>`;

test("streamed article segments become one body while ordinary hidden content stays hidden", () => {
  const html = page(`<!--$?--><template id="B:0"></template><p>Loading article</p><!--/$-->
    <div hidden id="S:0"><article><h1>AI infrastructure</h1><template id="P:1"></template></article></div>
    <script>$RC("B:0","S:0")</script>
    <div hidden id="S:1"><p>${paragraph}</p><p>${paragraph}</p><aside hidden>HIDDEN_PROMOTION</aside></div>
    <script>$RS("S:1","P:1")</script><div hidden>HIDDEN_UNRELATED</div>`);
  const body = readable(html, "https://example.org/article");
  assert.ok(body);
  assert.ok(body.text.includes("data security"));
  assert.ok(body.text.length > 2000);
  assert.doesNotMatch(body.text, /Loading article|HIDDEN_PROMOTION|HIDDEN_UNRELATED/);
});

test("nested suspense boundaries resolve without leaving loading placeholders", () => {
  const html = page(`<!--$?--><template id="B:0"></template><p>Outer fallback</p><!--/$-->
    <div hidden id="S:0"><article><h1>AI infrastructure</h1><!--$?--><template id="B:1"></template><p>Inner fallback</p><!--/$--></article></div>
    <script>$RC("B:0","S:0")</script><div hidden id="S:1"><p>${paragraph}</p></div><script>$RC("B:1","S:1")</script>`);
  const body = readable(html, "https://example.org/article");
  assert.ok(body);
  assert.ok(body.text.includes("inference"));
  assert.doesNotMatch(body.text, /Outer fallback|Inner fallback/);
});

test("unmatched streamed fragments stay hidden and never delete visible article content", () => {
  const html = page(`<article><h1>AI infrastructure</h1><p>${paragraph}</p></article>
    <template id="B:0"></template><div hidden id="S:0"><p>UNMATCHED_FRAGMENT</p></div>
    <script>$RC("B:0","S:0"); throw Error("page scripts are not executed")</script>`);
  const body = readable(html, "https://example.org/article");
  assert.ok(body);
  assert.ok(body.text.includes("operational control"));
  assert.doesNotMatch(body.text, /UNMATCHED_FRAGMENT/);
});
