import assert from "node:assert/strict";
import { test } from "node:test";
import { MCP_TOOLS } from "@aihot/contracts/mcp";
import { agentItemsPath, probeAgent } from "../app/lib/agent-probe.ts";

test("the verification request uses only the provided credential and never follows redirects", async t => {
  const fake = "offline-test-token";
  const fetcher = t.mock.method(globalThis, "fetch", async (path: string, options: RequestInit) => {
    assert.equal(options.credentials, "omit");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    assert.equal(options.mode, "same-origin");
    assert.equal(new Headers(options.headers).get("Authorization"), "Bearer " + fake);
    assert.ok(!path.includes(fake) && !String(options.body).includes(fake));
    if (path === "/api/mcp") {
      assert.equal(options.method, "POST");
      assert.equal(JSON.parse(String(options.body)).method, "tools/list");
      return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: MCP_TOOLS } });
    }
    assert.equal(path, agentItemsPath);
    return Response.json({ schemaVersion: 1, items: [{ title: "实际返回的精选", source: { name: "来源" } }] });
  });
  assert.equal(await probeAgent("api", fake, new AbortController().signal), "实际返回的精选 · 来源");
  assert.equal(await probeAgent("mcp", fake, new AbortController().signal), `${MCP_TOOLS.length} 个工具 · ${MCP_TOOLS.map(tool => tool.name).join("、")}`);
  assert.equal(fetcher.mock.callCount(), 2);
});

test("unauthorized and malformed probe responses never count as a verified credential", async t => {
  const fetcher = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 401 }));
  await assert.rejects(probeAgent("mcp", "invalid", new AbortController().signal), /令牌无效/);
  fetcher.mock.mockImplementation(async () => Response.json({ status: "healthy" }));
  await assert.rejects(probeAgent("api", "unknown", new AbortController().signal), /未读到预期/);
  await assert.rejects(probeAgent("mcp", "unknown", new AbortController().signal), /未读到.*MCP/);
});

test("MCP verification requires a matching JSON-RPC reply and the site's tool set", async t => {
  const reply = { jsonrpc: "2.0", id: 1, result: { tools: MCP_TOOLS } };
  const fetcher = t.mock.method(globalThis, "fetch", async () => Response.json(reply));
  for (const malformed of [
    { result: reply.result }, { id: 1, result: reply.result }, { jsonrpc: "2.0", result: reply.result },
    { ...reply, jsonrpc: "1.0" }, { ...reply, id: 2 }, { ...reply, error: { code: -32603 } },
    { ...reply, result: { tools: [] } }, { ...reply, result: { tools: [{ name: "unrelated" }] } },
  ]) {
    fetcher.mock.mockImplementation(async () => Response.json(malformed));
    await assert.rejects(probeAgent("mcp", "sample", new AbortController().signal), /工具列表/);
  }
});
