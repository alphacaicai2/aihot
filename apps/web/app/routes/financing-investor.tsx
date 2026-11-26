import type { FinancingResponse } from "@aihot/contracts/financing";
import type { Route } from "./+types/financing-investor";
import { FinancingEvent } from "../features/research/FinancingEvent";
import { financingData, privateHeaders } from "../lib/membership.server";
import { financingInvestorPath, financingListPath, financingListSearch } from "../lib/financing-navigation";
import { listPath, pageMeta } from "../lib/seo";
import { FinancingPager } from "../features/research/FinancingPager";
import { FinancingReturn } from "../features/research/FinancingReturn";

export async function loader({ request }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const name = params.get("name")?.trim() ?? "";
  const history = await financingData<FinancingResponse>(request, listPath("/api/site/financing/investor", {name, cursor:params.get("cursor")}));
  return {name, history, list:financingListSearch(params)};
}
export const headers = () => privateHeaders;
export const meta: Route.MetaFunction = ({ loaderData }) => pageMeta({
  title: loaderData ? loaderData.name + " · 参与的融资记录" : "机构投资历史",
  path: financingInvestorPath(loaderData?.name ?? ""), noindex:true,
});
export default function Investor({ loaderData }: Route.ComponentProps) {
  const {name, history, list} = loaderData;
  return <div className="mx-auto max-w-3xl pb-6">
    <FinancingReturn to={financingListPath(list)} />
    <header className="card mb-5 p-5 sm:p-6"><h1 className="break-words text-[26px] font-bold">{name}</h1>
      <p className="mt-2 text-sm text-ink-3">已收录 {history.historySummary?.records ?? 0} 条融资记录{history.historySummary?.companies !== undefined && `，涉及 ${history.historySummary.companies} 家公司`}</p></header>
    <h2 className="mb-3 text-lg font-bold">参与的融资记录</h2>
    {history.events.length ? <div className="grid gap-2.5">{history.events.map(event => <FinancingEvent key={event.id} event={event} />)}</div> :
      !history.pageReset && <p className="card p-4 text-sm text-ink-3">暂无已收录的融资记录。</p>}
    <FinancingPager results={history} href={cursor => financingInvestorPath(name,list,cursor)} />
  </div>;
}
