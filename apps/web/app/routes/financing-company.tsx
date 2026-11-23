import { data, Link } from "react-router";
import { beijingDate } from "@aihot/contracts/time";
import type { FinancingResponse } from "@aihot/contracts/financing";
import type { Route } from "./+types/financing-company";
import { IconArrowLeft, IconArrowRight } from "../components/icons";
import { buttonClass } from "../components/ui/Controls";
import { FinancingEvent } from "../features/research/FinancingEvent";
import { ApiError } from "../lib/api.server";
import { memberGet, offerMembership, privateHeaders } from "../lib/membership.server";
import { financingCompanyPath, financingListSearch } from "../lib/financing-navigation";
import { listPath, pageMeta } from "../lib/seo";

const path = "/financing/company";

export async function loader({ request }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const name = params.get("name")?.trim() ?? "";
  const api = listPath("/api/site/financing/company", { name, cursor: params.get("cursor") });
  try {
    const history = await memberGet<FinancingResponse>(request, api);
    return { name, history, listSearch: financingListSearch(params) };
  } catch (error) {
    if (request.signal.aborted) throw error;
    const status = error instanceof ApiError ? error.status : 503;
    if (status === 401 || status === 403) throw offerMembership("financing", name || undefined);
    throw data({ message: status === 404 ? "not_found" : status === 400 ? "bad_request" : "unavailable" }, {
      status: status === 404 || status === 400 ? status : 503, headers: privateHeaders,
    });
  }
}

export const meta: Route.MetaFunction = ({ loaderData }) => pageMeta({
  title: loaderData ? `${loaderData.name} · 融资历史` : "公司融资历史",
  path: listPath(path, { name: loaderData?.name }), noindex: true,
});
export const headers = () => privateHeaders;

export default function FinancingCompany({ loaderData }: Route.ComponentProps) {
  const { name, history, listSearch } = loaderData;
  const summary = history.historySummary;
  return <div className="mx-auto max-w-3xl pb-6">
    <Link to={{ pathname: "/financing", search: listSearch }} className="mb-3 inline-flex min-h-10 items-center gap-1 text-sm text-ink-3 hover:text-accent">
      <IconArrowLeft size={15} /> 返回融资数据库
    </Link>
    <header className="card mb-5 p-5 sm:p-6">
      <h1 className="break-words text-[26px] font-bold leading-tight text-ink sm:text-[32px]">{name}</h1>
      {summary && <p className="mt-2 text-sm text-ink-3">已收录 {summary.records} 条融资记录
        <span className="ml-3 inline-block">最近报道于 <time dateTime={summary.latestAt}>{beijingDate(summary.latestAt)}</time></span>
      </p>}
    </header>
    <section aria-labelledby="company-history">
      <h2 id="company-history" className="text-lg font-bold">融资历史</h2>
      <p className="mb-3 mt-1 text-[13px] text-ink-3">按最近报道时间排列，可展开查看每笔记录的来源。</p>
      <div className="grid gap-2.5">{history.events.map(event => <FinancingEvent key={event.id} event={event} history />)}</div>
      {history.nextCursor && <div className="mt-5 text-center">
        <Link to={financingCompanyPath(name, listSearch, history.nextCursor)} className={buttonClass("secondary", "lg")}>
          更早记录 <IconArrowRight size={15} />
        </Link>
      </div>}
    </section>
  </div>;
}
