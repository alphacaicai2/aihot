import { useEffect, useRef, useState } from "react";
import { IconCheck, IconCopy, IconInfo } from "./icons";

export function CopyButton({ text, label = "复制", className = "" }: { text: string; label?: string; className?: string }) {
  const [notice, setNotice] = useState<"copied" | "failed" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const attempt = useRef(0);
  useEffect(() => {
    setNotice(null);
    return () => {
      ++attempt.current;
      clearTimeout(timer.current);
    };
  }, [text]);
  const copied = notice === "copied";
  async function copy(button: HTMLButtonElement) {
    const current = ++attempt.current;
    clearTimeout(timer.current);
    const previousFocus = document.activeElement;
    let success = false;
    try {
      await navigator.clipboard.writeText(text);
      success = true;
    } catch {
      if (!button.isConnected || current !== attempt.current) return;
      if (document.activeElement === previousFocus || document.activeElement === button) {
        const field = document.createElement("textarea");
        field.value = text;
        field.readOnly = true;
        field.style.cssText = "position:fixed;left:-9999px;top:0";
        button.parentElement?.appendChild(field);
        try {
          field.select();
          success = document.execCommand("copy");
        } catch {
          // Some browsers also disable the legacy clipboard command.
        } finally {
          const restore = document.activeElement === field;
          field.remove();
          if (restore) button.focus({ preventScroll: true });
        }
      }
    }
    if (current !== attempt.current) return;
    setNotice(success ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice(null), success ? 1800 : 5000);
  }
  return (
    <button
      type="button"
      onClick={e => void copy(e.currentTarget)}
      className={`inline-flex h-7 items-center gap-1 rounded-mark border border-line bg-surface px-2 text-[12px] transition-colors ${copied ? "text-ok" : "text-ink-3 hover:border-line-strong hover:text-ink"} ${className}`}
      aria-label={notice === "failed" ? "复制失败，请手动复制" : copied ? "已复制" : label}
      title={notice === "failed" ? "复制失败，请手动复制" : undefined}
      aria-live="polite"
    >
      <span key={notice ?? "copy"} aria-hidden="true" className={notice ? "anim-swap-in" : ""}>
        {copied ? <IconCheck size={14} /> : notice === "failed" ? <IconInfo size={14} /> : <IconCopy size={14} />}
      </span>
      <span className="inline-grid place-items-center">
        <span aria-hidden="true" className="invisible col-start-1 row-start-1">{label}</span>
        <span aria-hidden="true" className="invisible col-start-1 row-start-1">手动复制</span>
        <span className="col-start-1 row-start-1">{notice === "failed" ? "手动复制" : copied ? "已复制" : label}</span>
      </span>
    </button>
  );
}

/** Code panel on the page's quiet grey, with a copy button; `lang` is only a label. */
export function CodeBlock({ code, lang, title }: { code: string; lang?: string; title?: string }) {
  return (
    <div className="my-4 overflow-hidden rounded-card border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line-soft px-4 py-2">
        <span className="text-[12px] text-ink-4">{title ?? lang ?? ""}</span>
        <CopyButton text={code} />
      </div>
      <pre className="mono overflow-x-auto bg-bg-sunk/60 px-4 py-4 text-[12.5px] leading-[1.75] text-ink-2 dark:bg-bg-muted/40">
        <code>{code}</code>
      </pre>
    </div>
  );
}
