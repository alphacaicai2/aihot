import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { FeedItemSummary, TimelineResponse } from "@aihot/contracts/site";
import { Button } from "./ui/Controls";

export function PublicAgentPreview() {
  const [state, setState] = useState<"idle" | "loading" | "ready" | "empty" | "error">("idle");
  const [item, setItem] = useState<FeedItemSummary | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);

  async function read() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    setState("loading");
    try {
      const response = await fetch("/api/site/timeline?limit=1", { signal: controller.signal, credentials: "omit" });
      if (!response.ok) throw new Error();
      const data: TimelineResponse = await response.json();
      if (!Array.isArray(data.cards)) throw new Error();
      const latest = data.cards[0]?.item;
      if (data.cards.length && (!latest?.id || !latest.title || !latest.source?.name)) throw new Error();
      if (request.current === controller) {
        setItem(latest ?? null);
        setState(latest ? "ready" : "empty");
      }
    } catch {
      if (request.current === controller) setState("error");
    } finally {
      window.clearTimeout(timeout);
      if (request.current === controller) request.current = null;
    }
  }

  return <div className="mt-4 rounded-control border border-line-soft p-3.5">
    <p className="text-[13px] leading-relaxed text-ink-3">这里预览本站公开精选。开通会员后，可在 Agent 接入页验证个人令牌并读取接口结果。</p>
    <Button size="sm" className="mt-2" disabled={state === "loading"} onClick={() => void read()}>
      {state === "loading" ? "正在读取…" : state === "idle" ? "试读一条公开精选" : "重新读取"}
    </Button>
    <div role="status" aria-live="polite">
      {state === "error" && <p className="mt-2 text-sm text-hot">暂时无法读取公开精选，请重试。</p>}
      {state === "empty" && <p className="mt-2 text-sm text-ink-3">当前还没有公开精选。</p>}
      {state === "ready" && item && <div className="mt-3 border-t border-line-soft pt-3">
        <p className="text-xs text-ink-3">{item.source.name}</p>
        <Link to={`/items/${encodeURIComponent(item.id)}`} className="mt-1 block text-sm font-semibold text-accent hover:underline">{item.title}</Link>
        {item.summary && <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{item.summary}</p>}
      </div>}
    </div>
  </div>;
}
