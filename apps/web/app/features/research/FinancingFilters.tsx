import { useEffect, useRef, useState } from "react";
import { Form, Link } from "react-router";
import { addDays, beijingDate } from "@aihot/contracts/time";
import { dateProblem } from "../../lib/date-range";
import { IconChevronDown, IconSearch } from "../../components/icons";
import { Button } from "../../components/ui/Controls";

const field = "mt-1.5 block h-11 w-full min-w-0 rounded-control border border-line-strong bg-surface px-2.5 text-base font-normal text-ink placeholder:text-ink-4 focus:border-accent lg:text-sm";
const label = "min-w-0 text-[13px] font-semibold text-ink-2";

export function FinancingFilters({ params, initialError }: { params: URLSearchParams; initialError: string | null }) {
  const [from, setFrom] = useState(params.get("from") ?? "");
  const [to, setTo] = useState(params.get("to") ?? "");
  const [error, setError] = useState(initialError);
  const applied = ["company", "investor", "from", "to"].some(name => params.get(name)?.trim());
  const panel = useRef<HTMLDetailsElement>(null);
  // Keep the desktop filter rail ready for the next query. Phones land on the results.
  useEffect(() => {
    if (panel.current && window.matchMedia("(min-width: 961px)").matches) panel.current.open = true;
  }, []);
  const setRange = (start: string, end: string) => {
    setFrom(start);
    setTo(end);
    setError(null);
  };

  return (
    <Form method="get" aria-label="融资筛选" className="card min-w-0 self-start px-4 lg:px-5"
      onSubmit={(e) => {
        const problem = dateProblem(from, to);
        if (problem) {
          e.preventDefault();
          setError(problem);
          const datePanel = e.currentTarget.querySelector<HTMLDetailsElement>("[data-dates]");
          if (datePanel) datePanel.open = true;
          e.currentTarget.querySelector<HTMLInputElement>(!from ? '[name="from"]' : '[name="to"]')?.focus();
        }
      }}>
      <details ref={panel} className="group/filters" open={!applied || Boolean(initialError)}>
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 rounded-control text-[16px] font-bold">
          筛选条件 <IconChevronDown size={16} className="text-ink-3 transition-transform group-open/filters:rotate-180" />
        </summary>
        <div className="pb-4 lg:pb-5">
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-1 lg:gap-4">
            <label className={label}>公司或基金
              <input className={field} name="company" maxLength={120} defaultValue={params.get("company") ?? ""} placeholder="公司或基金名称" />
            </label>
            <label className={label}>投资机构
              <input className={field} name="investor" maxLength={120} defaultValue={params.get("investor") ?? ""} placeholder="机构名称" aria-describedby="investor-help" />
            </label>
          </div>
          <p id="investor-help" className="mt-2 text-xs leading-relaxed text-ink-4">机构筛选仅覆盖已提取投资方的报道。</p>
          <details data-dates className="group mt-3 border-y border-line-soft" open={Boolean(params.get("from") || params.get("to"))}>
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-control text-[13px] font-semibold">
              日期范围
              <span className="flex items-center gap-1 text-xs font-normal text-ink-3">
                {from || to ? "自定义" : "不限"} <IconChevronDown size={14} className="transition-transform group-open:rotate-180" />
              </span>
            </summary>
            <div className="pb-3">
              <div className="mb-2 flex flex-wrap gap-1">
                {[7, 30].map(days => <button key={days} type="button" className="min-h-9 rounded-full bg-accent-soft px-3 text-xs font-medium text-accent hover:underline"
                  onClick={() => { const today = beijingDate(Date.now()); setRange(addDays(today, 1 - days), today); }}>近 {days} 天</button>)}
                {(from || to) && <button type="button" className="min-h-9 rounded-full px-2 text-xs text-ink-3 hover:text-accent" onClick={() => setRange("", "")}>不限日期</button>}
              </div>
              <div className="grid grid-cols-2 gap-2 min-[961px]:grid-cols-1">
                <label className={label}>开始日期<input type="date" className={field} name="from" value={from} aria-describedby="fin-dates" onChange={e => setRange(e.target.value, to)} /></label>
                <label className={label}>结束日期<input type="date" className={field} name="to" value={to} aria-describedby="fin-dates" onChange={e => setRange(from, e.target.value)} /></label>
              </div>
              <p id="fin-dates" className="mt-2 text-xs leading-relaxed text-ink-4">按北京时间检索，包含首尾两天。</p>
            </div>
          </details>
          {error && <p role="alert" className="mt-2 text-[13px] font-medium text-hot">{error}</p>}
          <div className="mt-3 flex items-center gap-2">
            <Button type="submit" variant="primary" size="lg" className="flex-1"><IconSearch size={16} />应用筛选</Button>
            <Link to="/financing" className="inline-flex min-h-11 items-center rounded-control px-3 text-[13px] text-ink-3 hover:text-accent">重置</Link>
          </div>
        </div>
      </details>
    </Form>
  );
}
