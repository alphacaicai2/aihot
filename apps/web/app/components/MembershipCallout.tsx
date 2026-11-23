import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { Membership } from "../lib/membership.server";
import { IconArrowRight, IconSparkles } from "./icons";
import { buttonClass } from "./ui/Controls";

/**
 * Editorial membership prompt shown on the public homepage.
 * Renders in SSR with zero layout shift for visitors, then quietly hides after hydration
 * if the reader already holds membership access.
 */
export function MembershipCallout() {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/reader/membership", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const current = (await response.json()) as Partial<Membership>;
        if (current.access) setHidden(true);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  if (hidden) return null;

  return (
    <section
      aria-label="读者会员权益"
      className="mt-3.5 flex flex-col gap-3 rounded-card border border-line bg-surface px-4 py-3.5 shadow-[var(--shadow-card)] sm:flex-row sm:items-center sm:justify-between sm:gap-5 sm:px-5"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-0.5 text-[11.5px] font-semibold text-accent">
            <IconSparkles size={12} />
            读者会员 · US$5 / 月
          </span>
          <span className="text-[12px] text-ink-4">普通资讯继续免费，可随时取消续订</span>
        </div>
        <h2 className="mt-1.5 text-[15.5px] font-bold leading-snug text-ink sm:text-[16.5px]">
          从每天看 AI 动态，到持续追踪融资与接入 Agent
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-3">
          解锁单笔交易融资库、公司历次融资档案与 CSV 导出，并用个人令牌接入 MCP、REST API 和 RSS。
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Link to="/membership" prefetch="intent" className={buttonClass("primary", "md")}>
          查看会员权益 <IconArrowRight size={14} />
        </Link>
        <Link to="/membership#samples" prefetch="intent" className={buttonClass("secondary", "md")}>
          先看样例
        </Link>
      </div>
    </section>
  );
}
