import { Link, useLocation } from "react-router";
import type { FinancingResponse } from "@aihot/contracts/financing";
import { buttonClass } from "../../components/ui/Controls";

export function FinancingPager({ results, href }: { results: FinancingResponse; href: (cursor: string | null) => string }) {
  const { state } = useLocation();
  if (results.pageReset) return <div className="card mt-3 p-4 text-sm text-ink-3">
    <p>记录已更新，本页已无记录。</p>
    <Link to={href(null)} state={state} className={buttonClass("secondary") + " mt-2"}>返回第一页</Link>
  </div>;
  if (!results.previousCursor && !results.nextCursor) return null;
  return <nav aria-label="融资记录分页" className="mt-4 flex justify-between gap-3">
    {results.previousCursor && <Link to={href(results.previousCursor)} state={state} className={buttonClass("secondary")}>上一页</Link>}
    {results.nextCursor && <Link to={href(results.nextCursor)} state={state} className={buttonClass("secondary") + " ml-auto"}>下一页</Link>}
  </nav>;
}
