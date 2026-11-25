import { useState } from "react";
import { IconShare } from "../../components/icons";
import { financingEventPath } from "../../lib/financing-navigation";

export function ShareFinancingEvent({ id, title }: { id: string; title: string }) {
  const [notice, setNotice] = useState("");
  const path = financingEventPath(id);
  async function share() {
    const url = new URL(path, window.location.origin).href;
    if (navigator.share) {
      try {
        await navigator.share({title, url});
        return;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setNotice("链接已复制");
    } catch {
      setNotice("请复制事件链接");
    }
  }
  return <div className="flex flex-wrap items-center gap-x-3 border-t border-line-soft px-3.5 text-xs sm:px-5">
    <a href={path} className="inline-flex min-h-9 items-center text-accent hover:underline">事件链接</a>
    <button type="button" onClick={share} aria-label={`分享融资事件：${title}`} className="inline-flex min-h-9 items-center gap-1 text-ink-3 hover:text-accent"><IconShare size={14} />分享</button>
    <span role="status" className="text-ink-3">{notice}</span>
  </div>;
}
