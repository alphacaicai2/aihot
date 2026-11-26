import { useEffect, useRef, useState } from "react";
import { probeAgent, type AgentProtocol } from "../lib/agent-probe";
import { Button, Select } from "./ui/Controls";

const names = { mcp: "MCP 工具列表", api: "REST API 最新精选", rss: "RSS 精选订阅" } as const;

export function AgentProbe({ freshToken }: { freshToken: string }) {
  const [protocol, setProtocol] = useState<AgentProtocol>("mcp");
  const [pasted, setPasted] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const clear = () => { request.current?.abort(); request.current = null; setPasted(""); setResult(null); setBusy(false); };
    window.addEventListener("pagehide", clear);
    return () => { request.current?.abort(); request.current = null; window.removeEventListener("pagehide", clear); };
  }, []);

  async function verify() {
    const token = freshToken || pasted.trim();
    if (!token || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setResult(null);
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const text = await probeAgent(protocol, token, controller.signal);
      if (!controller.signal.aborted) setResult({ ok: true, text });
    } catch (error) {
      if (request.current === controller) {
        const text = controller.signal.aborted ? "验证超时，请稍后重试。"
          : error instanceof Error && error.name === "Error" ? error.message : "未收到验证结果，请检查网络后重试。";
        setResult({ ok: false, text });
      }
    } finally {
      window.clearTimeout(timeout);
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  }

  return <div id="agent-test" className="mt-4 scroll-mt-20 border-t border-line-soft pt-3.5">
    <h3 className="text-sm font-semibold">验证令牌并读取示例</h3>
    {!freshToken && <label className="mt-2 block text-xs text-ink-3">已保存的个人令牌
      <input type="password" autoComplete="off" spellCheck={false} value={pasted} disabled={busy}
        onChange={e => { setPasted(e.target.value); setResult(null); }} placeholder="仅用于本页验证"
        className="mt-1 block h-9 w-full rounded-control border border-line bg-surface px-3 font-mono text-sm text-ink" />
    </label>}
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Select value={protocol} disabled={busy} aria-label="要验证的只读接口" onChange={e => { setProtocol(e.target.value as AgentProtocol); setResult(null); }}>
        {Object.entries(names).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </Select>
      <Button disabled={busy || !(freshToken || pasted.trim())} onClick={() => void verify()}>{busy ? "正在验证…" : "验证令牌"}</Button>
    </div>
    <div aria-live="polite" aria-atomic="true">
      {result && <p className={`mt-2 break-words text-sm ${result.ok ? "text-ink-2" : "text-hot"}`}>{result.ok && <strong>{names[protocol]}已验证 · </strong>}{result.text}</p>}
    </div>
  </div>;
}
