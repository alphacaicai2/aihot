// Check a member's MCP connection with the official SDK. Set MEMBERSHIP_AGENT_TOKEN before running:
// node scripts/mcp-check.ts [url]
import assert from "node:assert/strict";
import { MCP_TOOL_NAMES as T } from "@aihot/contracts/mcp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const url = new URL(process.argv[2] ?? "http://127.0.0.1:3001/api/mcp");
const token = process.env.MEMBERSHIP_AGENT_TOKEN;
if (!token) throw new Error("Set MEMBERSHIP_AGENT_TOKEN to a member's Agent key");
const client = new Client({ name: "membership-mcp-check", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { authorization: "Bearer " + token } },
}));

try {
  console.log("server:", JSON.stringify(client.getServerVersion()));
  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name);
  for (const name of Object.values(T)) assert(names.includes(name), "Missing MCP tool: " + name);
  console.log("tools:", names.join(", "));

  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    const payload = result.structuredContent as { error?: { code?: string }; items?: Array<{ links?: { story?: string } }> } | undefined;
    if (name === T.daily && result.isError && payload?.error?.code === "not_found") {
      console.log(name, "no published daily yet");
      return;
    }
    assert(!result.isError, name + " failed: " + (payload?.error?.code ?? "unexpected error"));
    console.log(name, "ok");
    return payload;
  }

  await call(T.latest, { limit: 2 });
  await call(T.search, { q: "OpenAI", limit: 2 });
  const hot = await call(T.hot, { limit: 3 });
  const storyId = hot?.items?.[0]?.links?.story?.split("/").pop();
  if (storyId) await call(T.story, { public_id: storyId, report_limit: 3 });
  await call(T.daily, {});
  const invalid = await client.callTool({ name: T.latest, arguments: { limit: 99 } });
  assert(invalid.isError, "MCP accepted an invalid limit");
  console.log(T.latest, "invalid limit rejected");
} finally {
  await client.close();
}
