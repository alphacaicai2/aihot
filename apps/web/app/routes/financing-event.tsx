import { Link, data } from "react-router";
import type { FinancingResponse } from "@aihot/contracts/financing";
import type { Route } from "./+types/financing-event";
import { FinancingEvent } from "../features/research/FinancingEvent";
import { ApiError } from "../lib/api.server";
import { memberGet, offerMembership, privateHeaders } from "../lib/membership.server";
import { financingEventPath } from "../lib/financing-navigation";
import { pageMeta } from "../lib/seo";

export async function loader({ request }: Route.LoaderArgs) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  try {
    return await memberGet<FinancingResponse["events"][number]>(request, "/api/site/financing/event?" + new URLSearchParams({ id }));
  } catch (error) {
    if (request.signal.aborted) throw error;
    const status = error instanceof ApiError ? error.status : 503;
    if (status === 401 || status === 403) throw offerMembership(request, "financing");
    throw data({message: status === 404 ? "融资事件不存在" : "融资事件暂时无法打开"}, {status: status === 404 || status === 400 ? status : 503, headers: privateHeaders});
  }
}
export const headers = () => privateHeaders;
export const meta: Route.MetaFunction = ({ loaderData }) => pageMeta({
  title: loaderData ? loaderData.reports[0]?.claim.company + " · 融资事件" : "融资事件",
  path: financingEventPath(loaderData?.shareId ?? ""), noindex:true,
});
export default function Event({ loaderData }: Route.ComponentProps) {
  return <main className="mx-auto max-w-3xl pb-6">
    <Link to="/financing" className="inline-flex min-h-10 items-center text-sm text-ink-3 hover:text-accent">返回融资数据库</Link>
    <h1 className="mb-3 text-xl font-bold">融资事件</h1>
    <FinancingEvent event={loaderData} expanded />
  </main>;
}
