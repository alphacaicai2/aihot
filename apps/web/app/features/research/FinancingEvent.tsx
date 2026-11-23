import { Link, useLocation } from "react-router";
import type { FinancingClaim, FinancingReport, FinancingResponse } from "@aihot/contracts/financing";
import { beijingDate } from "@aihot/contracts/time";
import { Badge } from "../../components/ui/Badge";
import { IconChevronDown, IconExternal } from "../../components/icons";
import { financingCompanyPath } from "../../lib/financing-navigation";

const statusLabel = { planned: "计划中", ongoing: "进行中", announced: "已宣布", closed: "已完成", unknown: "状态未明确" };
const basisLabel = { round: "本轮金额", cumulative: "累计金额", target: "目标金额", unknown: "金额口径未明确" };

function amount(claim: FinancingClaim) {
  return [claim.amountText, claim.currency].filter(Boolean).join(" ");
}

function Recipient({ claim }: { claim: FinancingClaim }) {
  const { pathname, search } = useLocation();
  if (pathname !== "/financing" && pathname !== "/financing/") return <>{claim.company}</>;
  if (claim.kind !== "company_round") return <>{claim.company}</>;
  return <Link to={financingCompanyPath(claim.company, search)}
    className="text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-current"
    aria-label={`查看${claim.company}的融资历史`}>{claim.company}</Link>;
}

function ClaimDetails({ claim: c }: { claim: FinancingClaim }) {
  const fields = [
    [basisLabel[c.amountBasis], c.amountText ? amount(c) : "金额未披露"],
    ["轮次", c.round ?? "未披露"], ["交易状态", statusLabel[c.status]],
    ["投资机构", c.investors.join("、") || "未披露"], ...(c.valuationText ? [["估值", c.valuationText]] : []),
  ];
  return <>
      <dl className="my-2 grid grid-cols-2 gap-x-3 gap-y-2 rounded-control bg-surface p-3 sm:grid-cols-3">
        <div><dt className="text-xs text-ink-4">{c.kind === "fund_raise" ? "基金" : "公司"}</dt><dd className="mt-0.5 text-[13px] font-medium text-ink-2"><Recipient claim={c} /></dd></div>
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

export function FinancingEvent({ event, history = false }: { event: FinancingResponse["events"][number]; history?: boolean }) {
  const source = event.reports[0];
  if (!source?.claim) return null;
  const claim = source.claim;
  const date = beijingDate(event.latestAt);
  return (
    <article className="card min-w-0 [overflow-wrap:anywhere]">
      <details className="group/event">
        <summary className="flex cursor-pointer list-none items-start gap-2.5 rounded-card px-3.5 py-3.5 hover:bg-accent-softer sm:gap-4 sm:px-5">
          <time dateTime={event.latestAt} title={`${history ? "报道时间" : "站内时间"} ${date}`} className="hidden w-16 shrink-0 border-r border-line pr-3 text-ink-3 sm:block">
            <span className="mono block text-[16px] font-bold text-accent">{date.slice(5).replace("-", "/")}</span>
            <span className="mono text-xs">{date.slice(0, 4)}</span>
          </time>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
              <span className="num sm:hidden">{date}</span>
              <span>{event.reportCount} 篇报道</span>
              {claim.recordType === "aggregate_disclosure" && <Badge tone="amber">合计披露</Badge>}
              {claim.recordType === "unresolved" && <Badge tone="amber">交易归属待核实</Badge>}
              {event.differingClaims && <Badge tone="amber">来源口径有差异</Badge>}
            </span>
            <span className="mt-1 block text-[17px] font-bold leading-snug text-ink">{history ? claim.round || "轮次未披露" : <Recipient claim={claim} />}</span>
            <span className="mt-1 grid gap-x-5 gap-y-1 text-[13px] text-ink-3 sm:grid-cols-2">
              {!history && <span>轮次 · {claim.round ?? "未披露"}</span>}
              <span>{claim.amountText ? basisLabel[claim.amountBasis] : "金额"} · <strong className="font-semibold text-accent">{amount(claim) || "未披露"}</strong></span>
              <span>投资方 · {claim.investors.join("、") || "未披露"}</span>
              <span>交易状态 · {statusLabel[claim.status]}</span>
            </span>
            {event.differingClaims && <span className="mt-1 block text-xs text-ink-3">以上据{source.sourceName}，展开可核对各篇报道。</span>}
          </span>
          <IconChevronDown size={18} className="mt-1 shrink-0 text-ink-4 transition-transform group-open/event:rotate-180" />
        </summary>
        <div className="border-t border-line-soft bg-accent-softer p-3.5 sm:px-5">
          {event.reportCount > event.reports.length && <p className="mb-3 text-xs text-ink-3">本页及导出仅展示最新 {event.reports.length} 篇，共 {event.reportCount} 篇报道。</p>}
          <ul className="divide-y divide-line">{event.reports.map(report => <Report key={report.id} report={report} />)}</ul>
        </div>
      </details>
    </article>
  );
}
