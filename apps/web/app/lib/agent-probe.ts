import { MCP_TOOLS } from "@aihot/contracts/mcp";

export type AgentProtocol = "mcp" | "rss" | "api";
export const agentItemsPath = "/api/v1/items?mode=selected&window=24h&limit=1";
const protocolVersion = "2026-07-28";
const requestId = 1;

export async function probeAgent(protocol: AgentProtocol, token: string, signal: AbortSignal): Promise<string> {
  const headers = new Headers({ Authorization: "Bearer " + token });
  const options: RequestInit = { signal, headers, credentials: "omit", cache: "no-store", mode: "same-origin", redirect: "error", referrerPolicy: "no-referrer" };
  const path = protocol === "mcp" ? "/api/mcp" : protocol === "rss" ? "/feed.xml" : agentItemsPath;
  if (protocol === "mcp") {
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json, text/event-stream");
    headers.set("MCP-Protocol-Version", protocolVersion);
    headers.set("MCP-Method", "tools/list");
    options.method = "POST";
    options.body = JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/list", params: { _meta: {
      "io.modelcontextprotocol/protocolVersion": protocolVersion, "io.modelcontextprotocol/clientCapabilities": {},
    } } });
  }
  const res = await fetch(path, options);
  if (res.status === 401) throw new Error("令牌无效或已撤销，请重新粘贴当前令牌。");
  if (res.status === 403) throw new Error("请求未获授权，请检查会员权限和访问地址。");
  if (res.status === 429) throw new Error("验证太频繁，请稍后重试。");
  if (!res.ok) throw new Error(`接口返回 HTTP ${res.status}，请稍后重试。`);
  if (protocol === "rss") {
    const document = new DOMParser().parseFromString(await res.text(), "application/xml");
    const channel = document.querySelector("rss > channel");
    if (!channel || document.querySelector("parsererror")) throw new Error("接口没有返回可读取的 RSS 订阅。");
    const title = channel.querySelector("item > title")?.textContent;
    return title ? "最新条目 · " + title : "订阅读取成功，当前没有条目。";
  }
  const body = await res.json().catch(() => null);
  if (protocol === "mcp") {
    if (body?.jsonrpc !== "2.0" || body.id !== requestId || "error" in body) {
      throw new Error("未读到与本次请求匹配的 MCP 工具列表，请稍后重试。");
    }
    const tools: unknown = body.result?.tools;
    if (!Array.isArray(tools) || !tools.every(t => typeof t?.name === "string")) throw new Error("未读到 MCP 工具列表，请稍后重试。");
    const names = tools.map(t => t.name);
    if (!MCP_TOOLS.every(tool => names.includes(tool.name))) throw new Error("接口已响应，但工具列表缺少本站的只读工具，请检查服务地址后重试。");
    return `${names.length} 个工具 · ${names.join("、")}`;
  }
  if (body?.schemaVersion !== 1 || !Array.isArray(body.items)) throw new Error("未读到预期的 API v1 结果，请稍后重试。");
  if (!body.items.length) return "过去 24 小时没有新精选。";
  const item = body.items[0];
  if (typeof item?.title !== "string") throw new Error("这条记录缺少标题，请稍后重试。");
  return [item.title, typeof item.source?.name === "string" ? item.source.name : ""].filter(Boolean).join(" · ");
}
