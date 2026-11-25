import { useEffect, useRef, useState } from "react";
import { Form, Link, useNavigation } from "react-router";
import type { PoolResponse } from "@aihot/contracts/site";
import { IconArrowRight, IconChevronDown, IconSearch } from "../../components/icons";
import { Input } from "../../components/coss/input";
import { Button } from "../../components/ui/Controls";
import { dateProblem } from "../../lib/date-range";
import { useSlashFocus } from "./Filters";

export function PoolSearch({ filters, focus, initialError }: { filters: PoolResponse["filters"]; focus: boolean; initialError: string | null }) {
  const navigation = useNavigation();
  const searching = navigation.state !== "idle" && navigation.location?.pathname === "/all";
  const [error, setError] = useState(initialError);
  const search = useRef<HTMLInputElement>(null);
  const advanced = useRef<HTMLDetailsElement>(null);
  useSlashFocus(search);
  useEffect(() => { if (focus) search.current?.focus(); }, [focus]);
  const { q, channel, category, tag, tab, company, investor, from, to } = filters;
  return (
    <Form method="get" role="search" aria-busy={searching} aria-label="搜索动态" className="card px-3 pt-3 sm:px-5 sm:pt-4"
      onSubmit={event => {
        const form = event.currentTarget;
        const values = new FormData(form);
        const start = String(values.get("from") || "");
        const problem = dateProblem(start, String(values.get("to") || ""));
        if (problem) {
          event.preventDefault();
          setError(problem);
          if (advanced.current) advanced.current.open = true;
          form.querySelector<HTMLInputElement>(start ? '[name="to"]' : '[name="from"]')?.focus();
        }
      }}>
      {Object.entries({ channel: channel === "all" ? null : channel, category, tag, tab: tab === "relevance" ? tab : null }).map(([name, value]) =>
        value && <input type="hidden" key={name} name={name} value={value} />)}
      <div className="flex gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">搜索关键词</span>
          <IconSearch size={18} className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-muted-foreground" />
          <Input size="lg" ref={search} type="search" name="q" defaultValue={q ?? ""} maxLength={200} enterKeyHint="search"
            placeholder={tab === "relevance" ? "搜索标题、摘要与正文" : "搜索标题、摘要…"}
            className="[&_input]:h-10.5 [&_input]:pl-10 sm:[&_input]:h-9.5" />
        </label>
        <Button type="submit" variant="primary" size="lg" disabled={searching}>{searching ? "正在搜索…" : "搜索"}</Button>
      </div>
      <details ref={advanced} open={Boolean(initialError)} className="disclosure group">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-control text-[13px] font-semibold text-ink-2">
          高级筛选 <span className="text-xs font-normal text-ink-4">日期、公司、投资机构</span>
          <IconChevronDown size={15} className="ml-auto text-ink-3 transition-transform group-open:rotate-180" />
        </summary>
        <div className="border-t border-line-soft py-3">
          <div className="grid grid-cols-2 gap-x-2.5 gap-y-3 lg:grid-cols-4">
            {([["company", "公司", company], ["investor", "投资机构", investor], ["from", "开始日期", from], ["to", "结束日期", to]] as const).map(([name, label, value]) => (
              <label key={name} className="min-w-0 text-[13px] font-semibold text-ink-2">{label}
                <Input size="lg" className="mt-1.5 font-normal" name={name} type={name === "from" || name === "to" ? "date" : "text"} defaultValue={value ?? ""} maxLength={120} onChange={() => setError(null)} />
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-3">日期按北京时间，起止日需同时填写。机构筛选仅覆盖已提取投资方的报道。</p>
          {error && <p className="mt-2 text-[13px] font-semibold text-hot" role="alert">{error}</p>}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <Link to="/financing" className="inline-flex min-h-10 items-center gap-1 rounded-control text-[13px] text-accent">融资数据库 <IconArrowRight size={14} /></Link>
          </div>
        </div>
      </details>
    </Form>
  );
}
