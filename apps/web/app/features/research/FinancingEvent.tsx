import { memberPathname } from "@aihot/contracts/member-destination";
import { Fragment } from "react";
import { useFinancingTrail } from "./FinancingReturn";
import { ShareFinancingEvent } from "./ShareFinancingEvent";
import { Link, useLocation } from "react-router";
import type { FinancingClaim, FinancingReport, FinancingResponse } from "@aihot/contracts/financing";
import { beijingDate } from "@aihot/contracts/time";
import { Badge } from "../../components/ui/Badge";
import { IconChevronDown, IconExternal } from "../../components/icons";
import { financingCompanyPath, financingInvestorPath, financingListSearch } from "../../lib/financing-navigation";

import { amount, basisLabel, statusLabel } from "./financing-share-image";

function Recipient({ claim }: { claim: FinancingClaim }) {
  const location = useLocation();
  const pathname = memberPathname(location.pathname);
  const search = location.search;
  const trail = useFinancingTrail();
  if (pathname === "/financing/company") return <>{claim.company}</>;
  if (claim.kind !== "company_round") return <>{claim.company}</>;
  const params = new URLSearchParams(search);
  const via = pathname === "/financing/investor" ? {name:params.get("name") ?? "",cursor:params.get("cursor")} : undefined;
  return <Link state={trail} to={financingCompanyPath(claim.company, pathname === "/financing" ? search : financingListSearch(params), null, via)}
    className="text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-current"
    aria-label={`查看${claim.company}的融资历史`}>{claim.company}</Link>;
}

function InvestorLinks({ names }: { names: string[] }) {
  const location = useLocation();
  const pathname = memberPathname(location.pathname);
  const search = location.search;
  const trail = useFinancingTrail();
  const list = pathname === "/financing" ? search : financingListSearch(new URLSearchParams(search));
  return names.length ? <>{names.map((name, i) => <Fragment key={i}>{i > 0 && "、"}<Link
    state={trail} to={financingInvestorPath(name, list)} aria-label={`查看${name}的投资记录`}
    className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-current">{name}</Link></Fragment>)}</> : <>未披露</>;
}

function ClaimDetails({ claim: c }: { claim: FinancingClaim }) {
  const fields = [
    [basisLabel[c.amountBasis], c.amountText ? amount(c) : "金额未披露"],
    ["轮次", c.round ?? "未披露"], ["交易状态", statusLabel[c.status]],
    ...(c.valuationText ? [["估值", c.valuationText]] : []),
  ];
  return <>
      <dl className="my-2 grid grid-cols-2 gap-x-3 gap-y-2 rounded-control bg-surface p-3 sm:grid-cols-3">
        <div><dt className="text-xs text-ink-4">{c.kind === "fund_raise" ? "基金" : "公司"}</dt><dd className="mt-0.5 text-[13px] font-medium text-ink-2"><Recipient claim={c} /></dd></div>
        <div><dt className="text-xs text-ink-4">投资机构</dt><dd className="mt-0.5 text-[13px] font-medium text-ink-2"><InvestorLinks names={c.investors} /></dd></div>
        {fields.map(([name, value]) => <div key={name}><dt className="text-xs text-ink-4">{name}</dt><dd className="mt-0.5 text-[13px] font-medium text-ink-2">{value}</dd></div>)}
      </dl>
      <blockquote className="border-l-2 border-accent/50 pl-3 text-[13px] leading-relaxed text-ink-3">{c.evidence}</blockquote>
  </>;
}

function Report({ report }: { report: FinancingReport }) {
  return (
    <li className="min-w-0 py-3.5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-ink-3">
        <span className="font-semibold">{report.sourceName}</span>
        {report.publishedAt && <time className="num" dateTime={report.publishedAt}>{beijingDate(report.publishedAt)}</time>}
      </div>
      <Link to={`/items/${report.id}`} className="mt-1 block w-fit text-[15px] font-semibold leading-relaxed text-ink hover:text-accent hover:underline">{report.title}</Link>
      {[report.claim,...report.additionalClaims ?? []].map((claim,i) => <ClaimDetails key={i} claim={claim} />)}
      <a className="mt-1 inline-flex min-h-10 items-center gap-1 text-[13px] font-medium text-accent hover:underline" href={report.url} target="_blank" rel="noreferrer">查看原文 <IconExternal size={13} /></a>
    </li>
  );
}

export function FinancingEvent({ event, history = false, expanded = false }: { event: FinancingResponse["events"][number]; history?: boolean; expanded?: boolean }) {
  const source = event.reports[0];
  if (!source?.claim) return null;
  const claim = source.claim;
  const date = beijingDate(event.latestAt);
  return (
    <article className="card min-w-0 [overflow-wrap:anywhere] lg:grid lg:grid-cols-[minmax(0,1fr)_5rem] lg:items-start">
      <details className="group/event min-w-0" open={expanded || undefined}>
        <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1.5 rounded-card px-4 py-3 hover:bg-accent-softer xl:grid-cols-[4.6rem_minmax(0,1.3fr)_minmax(0,.95fr)_minmax(0,1fr)_1rem] xl:items-start">
          <time dateTime={event.latestAt} title={history ? "报道日期" : "站内日期"} className="num col-span-2 text-xs text-ink-4 xl:col-span-1 xl:pt-0.5">{date}</time>
          <span className="min-w-0 text-[16px] font-bold leading-snug text-ink">
            {history ? claim.round || "轮次未披露" : <Recipient claim={claim} />}
            {!history && <span className="mt-0.5 block text-xs font-normal text-ink-3">{claim.round ?? "轮次未披露"}</span>}
          </span>
          <span className={`min-w-0 max-w-40 text-right text-[14px] xl:text-left ${claim.amountText ? "font-semibold text-ink" : "font-normal text-ink-4"}`}>
            {amount(claim) || "金额未披露"}
            {claim.amountText && <span className="block text-xs font-normal text-ink-4">{basisLabel[claim.amountBasis]}</span>}
          </span>
          <span className="min-w-0 text-xs leading-relaxed text-ink-3"><span className="mr-1">投资方</span><InvestorLinks names={claim.investors} /></span>
          <IconChevronDown size={15} className="justify-self-end text-ink-4 transition-transform group-open/event:rotate-180" />
          <span className="col-span-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-4 xl:col-span-4 xl:col-start-2">
            {statusLabel[claim.status]} · {event.reportCount} 篇报道
            {claim.recordType === "aggregate_disclosure" && <Badge tone="amber">合计披露</Badge>}
            {claim.recordType === "unresolved" && <Badge tone="amber">交易归属待核实</Badge>}
            {event.differingClaims && <Badge tone="amber">来源口径有差异 · 以上据{source.sourceName}</Badge>}
          </span>
        </summary>
        <div className="border-t border-line-soft bg-accent-softer p-3.5 sm:px-5">
          {event.reportCount > event.reports.length && <p className="mb-3 text-xs text-ink-3">本页及导出仅展示最新 {event.reports.length} 篇，共 {event.reportCount} 篇报道。</p>}
          <ul className="divide-y divide-line">{event.reports.map(report => <Report key={report.id} report={report} />)}</ul>
        </div>
      </details>
      <ShareFinancingEvent event={event} />
    </article>
  );
}
