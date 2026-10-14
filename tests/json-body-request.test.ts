import { tag } from "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { bodyJsonRequest } from "@aihot/backend/content/json-request";
import { extractFromUrl, readable } from "@aihot/backend/content/extract";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";
import { config } from "@aihot/backend/config";

const requests: Array<{ path: string; method: string; body: unknown; auth?: string }> = [];
let mode = "normal";
const html = `<h2>Original industry research</h2><p>${"Inference demand changes deployment economics. ".repeat(12)}</p><h2>Closing remarks</h2><p>END OF COMPLETE RESEARCH</p>`;
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push({ path: req.url!, method: req.method!, body: body ? JSON.parse(body) : null, auth: req.headers.authorization });
  if (mode === "redirect") { res.writeHead(307, { location: "/must-not-follow" }); res.end(); }
  else if (mode === "html") { res.setHeader("content-type", "text/html"); res.end("<p>Only an introduction</p>"); }
  else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify([{ content: { html } }])); }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
const rule = { urlTemplate: `${base}/posts/detail`, method: "POST" as const, bodyJson: { id: "{slug}" }, path: "0.content.html", format: "html" as const };

test("an explicit anonymous POST read retrieves the complete JSON article using its actual reader ID", async () => {
  assertSupportedConfig("json_list", { url: `${base}/posts`, bodyExtractionJson: rule });
  const got = await extractFromUrl(`${base}/post/public-cms-id`, { allowJina: false, subject: tag(), bodyExtractionJson: rule });
  assert.equal(got?.via, "json-api");
  assert.ok(got?.text.endsWith("END OF COMPLETE RESEARCH"));
  assert.deepEqual(requests.at(-1), { path: "/posts/detail", method: "POST", body: { id: "public-cms-id" }, auth: undefined });
  mode = "redirect";
  assert.equal(await extractFromUrl(`${base}/post/id`, { allowJina: false, subject: tag(), bodyExtractionJson: rule }), null);
  assert.ok(!requests.some(r => r.path === "/must-not-follow"), "a POST request must not be replayed to a redirect target");
  mode = "html";
  assert.equal(await extractFromUrl(`${base}/post/id`, { allowJina: false, subject: tag(), bodyExtractionJson: rule }), null);
  mode = "normal";
});

test("JSON values interpolate structurally; unsupported, unmapped, excessive or cyclic request data fails", () => {
  const request = bodyJsonRequest("https://publisher.example/post/actual-id", { ...rule, bodyJson: { nested: ["{slug}", "quote\"\\\n"], path: "{path}" } });
  assert.deepEqual(JSON.parse(request!.body!), { nested: ["actual-id", "quote\"\\\n"], path: "/post/actual-id" });
  const cycle: Record<string, unknown> = { id: "{slug}" }; cycle.self = cycle;
  for (const patch of [{ method: "DELETE" }, { method: "GET" }, { bodyJson: {} }, { bodyJson: cycle },
    { bodyJson: { id: "{missing}" } }, { bodyJson: { id: "{slug}", large: "x".repeat(70_000) } },
    { bodyJson: JSON.parse('{"id":"{slug}","__proto__":{"bad":true}}') }, { urlTemplate: "https://user:pass@api.example/read" }]) {
    assert.equal(bodyJsonRequest("https://publisher.example/post/id", { ...rule, ...patch } as any), null);
    assert.throws(() => assertSupportedConfig("rss", { feedUrl: "https://publisher.example/feed", bodyExtractionJson: { ...rule, ...patch } }), /bodyExtractionJson.request/);
  }
  assert.equal(readable(`<script type="application/json">${JSON.stringify([{ content: { html } }])}</script>`, base,
    null, null, { ...rule, urlTemplate: undefined, selector: "script" }), null);
  assert.deepEqual(bodyJsonRequest("https://publisher.example/post/actual-id", { urlTemplate: "https://api.example/read/{slug}" }),
    { url: "https://api.example/read/actual-id", method: "GET" });
});
