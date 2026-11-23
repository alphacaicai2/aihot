import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { buttonClass } from "./ui/Controls";

interface ReaderStatus {
  enabled: boolean;
  email: string | null;
}

export function ReaderAccount() {
  const { hash } = useLocation();
  const [status, setStatus] = useState<ReaderStatus | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    // Public HTML is shared. Only this private request carries the reader cookie.
    async function refresh() {
      try {
        const response = await fetch("/api/reader/me", { cache: "no-store", signal: controller.signal });
        if (response.ok) setStatus(await response.json() as ReaderStatus);
      } catch {
        // Reading the feed is still available if the account service is offline.
      }
    }
    void refresh();
    const restore = (event: PageTransitionEvent) => { if (event.persisted) void refresh(); };
    window.addEventListener("pageshow", restore);
    return () => {
      controller.abort();
      window.removeEventListener("pageshow", restore);
    };
  }, []);

  const error = hash === "#google-login-failed" ? "Google 登录失败，请重试。"
    : hash === "#google-login-unavailable" ? "Google 登录暂未开放。" : null;
  if (!status?.email && !status?.enabled && !error) return null;
  return (
    <div className="flex min-w-0 flex-col items-end gap-1">
      {status?.email ? (
        <form method="post" action="/api/reader/logout" className="flex min-w-0 max-w-full items-center gap-2">
          <Link to="/membership" className="max-w-[30vw] truncate text-[13px] text-ink-2 hover:text-accent hover:underline" title={status.email}>{status.email}</Link>
          <button type="submit" className={buttonClass("ghost", "sm")}>退出</button>
        </form>
      ) : status?.enabled && <a className={buttonClass("secondary", "sm")} href="/api/reader/google">使用 Google 登录</a>}
      {error && <span role="alert" className="text-[12px] text-hot">{error}</span>}
    </div>
  );
}
