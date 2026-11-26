import { Link } from "react-router";
import { IconArrowRight, IconChart } from "./icons";

export function MembershipCallout() {
  return (
    <div className="flex min-h-14 items-center gap-2 rounded-control border border-line bg-surface px-3.5 py-1">
      <Link to="/financing" prefetch="intent" className="flex min-h-11 min-w-0 flex-1 items-center gap-3 py-1 hover:text-accent">
        <IconChart size={18} className="shrink-0 text-accent" />
        <span className="min-w-0">
          <span className="inline-flex items-center gap-1 text-[14px] font-semibold">融资数据库 <IconArrowRight size={13} /></span>
          <span className="block text-[12px] text-ink-3">按公司查历次融资、投资方和披露来源</span>
        </span>
      </Link>
      <Link to="/membership#samples" prefetch="intent" className="inline-flex min-h-11 shrink-0 items-center text-[13px] font-medium text-accent hover:underline">先看样例</Link>
    </div>
  );
}
