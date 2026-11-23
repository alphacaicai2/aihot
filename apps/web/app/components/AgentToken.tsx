import { useEffect, useState } from "react";
import { CopyButton } from "./CodeBlock";
import { Button } from "./ui/Controls";

export function AgentToken({ issued }: { issued: boolean }) {
  const [hasToken, setHasToken] = useState(issued);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const clear = () => setToken("");
    window.addEventListener("pagehide", clear);
    return () => window.removeEventListener("pagehide", clear);
  }, []);

  async function update(method: "POST" | "DELETE") {
    if (busy) return;
    const revoke = method === "DELETE";
    if (hasToken && !window.confirm(revoke ? "撤销后，使用此令牌的 Agent 将失去访问权限。继续吗？" : "重新生成后，原令牌将立即失效。继续吗？")) return;
    setBusy(true);
    setError("");
    try {
      const result = await fetch("/api/reader/membership/token", { method, credentials: "same-origin", cache: "no-store" });
      if (!result.ok) throw new Error(result.status === 401 || result.status === 403 ? "请重新登录并确认会员权限。" : "暂时无法更新令牌，请重试。");
      const fresh: string = revoke ? "" : (await result.json()).token;
      if (!revoke && !fresh) throw new Error("未收到新令牌，请重新生成。");
      setToken(fresh);
      setHasToken(!revoke);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "网络错误，请重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="agent-token" className="card mt-5 p-4 sm:p-5">
      <h2 id="agent-token" className="font-semibold">个人访问令牌</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-3">{hasToken ? "令牌已启用，MCP、RSS 和 REST API 共用此令牌。" : "生成令牌后，将它填入客户端的 Authorization 请求头。"}</p>
      {token && <div className="mt-3 rounded-control bg-bg-sunk p-3">
        <p role="status" className="text-xs font-medium text-ink-3">请保存这枚令牌，离开页面后无法再次查看。</p>
        <div className="mt-2 flex items-center gap-2"><code className="min-w-0 flex-1 break-all font-mono text-sm">{token}</code><CopyButton text={token} label="复制令牌" /></div>
      </div>}
      {error && <p role="alert" className="mt-3 text-sm text-hot">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant={hasToken ? "secondary" : "primary"} disabled={busy} onClick={() => void update("POST")}>{hasToken ? "重新生成令牌" : "生成访问令牌"}</Button>
        {hasToken && <Button variant="ghost" disabled={busy} onClick={() => void update("DELETE")}>撤销令牌</Button>}
      </div>
    </section>
  );
}
