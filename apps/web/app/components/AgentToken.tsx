import { useEffect, useRef, useState } from "react";
import { CopyButton } from "./CodeBlock";
import { Button } from "./ui/Controls";

export function AgentToken({ issued }: { issued: boolean }) {
  const [hasToken, setHasToken] = useState(issued);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  type Operation = "POST" | "DELETE";
  const [confirm, setConfirm] = useState<Operation | null>(null);
  const [busy, setBusy] = useState<Operation | null>(null);
  const [revoked, setRevoked] = useState(false);
  const inFlight = useRef(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const mainButton = useRef<HTMLButtonElement>(null);
  const copyArea = useRef<HTMLDivElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirm) cancelButton.current?.focus(); }, [confirm]);
  function cancel() {
    if (inFlight.current) return;
    setConfirm(null);
    trigger.current?.focus();
  }
  function request(method: Operation, button: HTMLButtonElement) {
    if (inFlight.current) return;
    setError("");
    if (!hasToken) { void update(method); return; }
    trigger.current = button;
    setConfirm(method);
  }
  useEffect(() => {
    const clear = () => setToken("");
    window.addEventListener("pagehide", clear);
    return () => window.removeEventListener("pagehide", clear);
  }, []);

  async function update(method: "POST" | "DELETE") {
    if (inFlight.current) return;
    inFlight.current = true;
    const revoke = method === "DELETE";
    let succeeded = false;
    setRevoked(false);
    setConfirm(null);
    setBusy(method);
    setError("");
    try {
      const result = await fetch("/api/reader/membership/token", { method, credentials: "same-origin", cache: "no-store" });
      if (!result.ok) throw new Error(result.status === 401 || result.status === 403 ? "请重新登录并确认会员权限。" : "暂时无法更新令牌，请重试。");
      const fresh: string = revoke ? "" : (await result.json()).token;
      if (!revoke && !fresh) throw new Error("未收到新令牌，请重新生成。");
      setToken(fresh);
      setHasToken(!revoke);
      setRevoked(revoke);
      succeeded = true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "网络错误，请重试。");
    } finally {
      inFlight.current = false;
      setBusy(null);
      requestAnimationFrame(() => {
        if (document.activeElement !== document.body) return;
        const next = succeeded && !revoke ? copyArea.current?.querySelector("button") : null;
        (next ?? (trigger.current?.isConnected ? trigger.current : mainButton.current))?.focus({ preventScroll:true });
      });
    }
  }

  return (
    <section aria-labelledby="agent-token" className="card mt-5 p-4 sm:p-5">
      <h2 id="agent-token" className="font-semibold">个人访问令牌</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-3">{hasToken ? "令牌已启用，MCP、RSS 和 REST API 共用此令牌。" : "生成令牌后，将它填入客户端的 Authorization 请求头。"}</p>
      {token && <div className="mt-3 rounded-control bg-bg-sunk p-3">
        <p role="status" className="text-xs font-medium text-ink-3">请保存这枚令牌，离开页面后无法再次查看。</p>
        <div ref={copyArea} className="mt-2 flex items-center gap-2"><code className="min-w-0 flex-1 break-all font-mono text-sm">{token}</code><CopyButton text={token} label="复制令牌" /></div>
      </div>}
      {revoked && <p role="status" className="mt-3 text-sm text-ink-2">令牌已撤销。</p>}
      {error && <p role="alert" className="mt-3 text-sm text-hot">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button ref={mainButton} variant={hasToken ? "secondary" : "primary"} disabled={!!busy} onClick={e => confirm === "POST" ? cancel() : request("POST", e.currentTarget)}>{busy === "POST" ? "正在生成…" : hasToken ? "重新生成令牌" : "生成访问令牌"}</Button>
        {hasToken && <Button variant="ghost" disabled={!!busy} onClick={e => confirm === "DELETE" ? cancel() : request("DELETE", e.currentTarget)}>{busy === "DELETE" ? "正在撤销…" : "撤销令牌"}</Button>}
      </div>
      {confirm && <div role="group" aria-labelledby="token-confirm" className="mt-3 rounded-control border border-line p-3" onKeyDown={e => { if (e.key === "Escape") cancel(); }}>
        <p id="token-confirm" className="text-sm">{confirm === "DELETE" ? "撤销后，正在使用这枚令牌的客户端将无法访问。" : "生成新令牌后，旧令牌立即失效，需要在客户端中替换。"}</p>
        <div className="mt-2 flex gap-2">
          <Button ref={cancelButton} onClick={cancel}>取消</Button>
          <Button variant="danger" onClick={() => void update(confirm)}>{confirm === "DELETE" ? "确认撤销" : "确认重新生成"}</Button>
        </div>
      </div>}
    </section>
  );
}
