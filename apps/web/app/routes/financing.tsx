import { data, Link, useLocation, useSearchParams } from "react-router";
import type { Route } from "./+types/financing";
import type { FinancingResponse } from "@aihot/contracts/financing";
import { loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { IconArrowRight, IconChart, IconDownload } from "../components/icons";
import { buttonClass } from "../components/ui/Controls";
import { EmptyState } from "../components/ui/Page";
import { ResearchHeader } from "../features/research/ResearchHeader";
import { dateProblem } from "../lib/date-range";
import { FinancingFilters } from "../features/research/FinancingFilters";
import { FinancingEvent } from "../features/research/FinancingEvent";

function financingQuery(params: URLSearchParams) {
  const query = new URLSearchParams();
  for (const key of ["company", "investor", "from", "to", "cursor"]) {
    const value = params.get(key)?.trim();
    if (value) query.set(key, value);
  }
  return query;
}

export async function loader({ request }: Route.LoaderArgs) {
  const query = financingQuery(new URL(request.url).searchParams);
  const problem = dateProblem(query.get("from") ?? "", query.get("to") ?? "");
  if (problem) return data({ results: null, problem }, { status: 400 });
  const results = await loadOr404<FinancingResponse>(`/api/v1/financing?${query}`, { signal: request.signal });
  return { results, problem: null };
}
export const meta: Route.MetaFunction = () => pageMeta({ title: "融资数据库", path: "/financing", noindex: true });
export const headers = () => ({ "Cache-Control": "public, max-age=0, s-maxage=60" });

export default function Financing({ loaderData }: Route.ComponentProps) {
  const { results, problem } = loaderData;
  const [params] = useSearchParams();
  const { key } = useLocation();
  const query = financingQuery(params);
  const constraints = [
    query.get("company") && `公司或基金 · ${query.get("company")}`,
    query.get("investor") && `投资机构 · ${query.get("investor")}`,
    query.get("from") && query.get("to") && `${query.get("from")} 至 ${query.get("to")}`,
  ].filter(Boolean);
  const csv = new URLSearchParams(query);
  csv.set("format", "csv");
  const next = new URLSearchParams(query);
  if (results?.nextCursor) next.set("cursor", results.nextCursor);
  return (
    <div className="mx-auto max-w-[1360px] pb-6">
      <ResearchHeader title="融资数据库" icon={<IconChart size={25} />}>按事件归并融资报道。金额、轮次与进展由模型从各篇报道提取，可展开核对原文。</ResearchHeader>
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[250px_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)] xl:gap-7">
        <FinancingFilters key={key} params={params} initialError={problem} />
        <section aria-labelledby="financing-results" className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <h2 id="financing-results" className="text-[18px] font-bold">融资事件</h2>
              {results && <span className="num text-xs text-ink-3">本页 {results.events.length} 起</span>}
            </div>
            {results && <a className={buttonClass("secondary", "md")} href={`/api/v1/financing?${csv}`}><IconDownload size={15} />导出本页 CSV</a>}
          </div>
          {constraints.length > 0 && <ul aria-label="已应用筛选" className="mb-3 flex flex-wrap gap-1.5">{constraints.map(c => <li key={c} className="max-w-full break-all rounded-control bg-accent-soft px-2 py-1 text-xs text-accent">{c}</li>)}</ul>}
          {results?.events.length ? (
            <div className="grid gap-2.5">{results.events.map(event => <FinancingEvent key={event.id} event={event} />)}</div>
          ) : (
            <div className="card">
              <EmptyState title={problem ? "请检查日期范围" : constraints.length ? "没有匹配的融资事件" : "暂时没有融资报道"}
                action={constraints.length || problem ? <Link to="/financing" className={buttonClass("secondary")}>清除筛选</Link> : <Link to="/all" className={buttonClass("secondary")}>浏览全部动态 <IconArrowRight size={14} /></Link>}>
                {problem || (constraints.length ? "试试公司简称、移除机构条件，或扩大日期范围。" : "收录融资报道后，这里会按最近的站内时间排列。")}
              </EmptyState>
            </div>
          )}
          {results?.hasMore && results.nextCursor && <div className="mt-5 text-center"><Link to={`/financing?${next}`} className={buttonClass("secondary", "lg")}>下一页 <IconArrowRight size={15} /></Link></div>}
        </section>
      </div>
    </div>
  );
}
