import { Link } from "react-router";
import type { FinancingResponse } from "@aihot/contracts/financing";
import type { Route } from "./+types/financing-investor";
import { FinancingEvent } from "../features/research/FinancingEvent";
import { financingData, privateHeaders } from "../lib/membership.server";
import { financingInvestorPath, financingListSearch } from "../lib/financing-navigation";
import { listPath, pageMeta } from "../lib/seo";
import { buttonClass } from "../components/ui/Controls";

export async function loader({ request }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const name = params.get("name")?.trim() ?? "";
  const history = await financingData<FinancingResponse>(request, listPath("/api/site/financing/investor", {name, cursor:params.get("cursor")}));
  return {name, history, list:financingListSearch(params)};
}
export const headers = () => privateHeaders;
export const meta: Route.MetaFunction = ({ loaderData }) => pageMeta({
  title: loaderData ? loaderData.name + " · 历史投资公司" : "机构投资历史",
  path: financingInvestorPath(loaderData?.name ?? ""), noindex:true,
});
export default function Investor({ loaderData }: Route.ComponentProps) {
  const {name, history, list} = loaderData;
  return <div className="mx-auto max-w-3xl pb-6">
    <Link to={{pathname:"/financing",search:list}} className="inline-flex min-h-10 items-center text-sm text-ink-3 hover:text-accent">返回融资数据库</Link>
    <header className="card mb-5 p-5 sm:p-6"><h1 className="break-words text-[26px] font-bold">{name}</h1>
      <p className="mt-2 text-sm text-ink-3">已收录 {history.historySummary?.records ?? 0} 条公司投资记录</p></header>
    <h2 className="mb-3 text-lg font-bold">历史投资公司</h2>
    {history.events.length ? <div className="grid gap-2.5">{history.events.map(event => <FinancingEvent key={event.id} event={event} />)}</div> :
      <p className="card p-4 text-sm text-ink-3">暂无已收录的公司投资记录。</p>}
    {history.nextCursor && <div className="mt-5 text-center"><Link to={financingInvestorPath(name,list,history.nextCursor)} className={buttonClass("secondary","lg")}>更早记录</Link></div>}
  </div>;
}
