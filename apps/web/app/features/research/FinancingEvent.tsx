import { Link } from "react-router";
import type { FinancingClaim, FinancingReport, FinancingResponse } from "@aihot/contracts/financing";
import { beijingDate } from "@aihot/contracts/time";
import { Badge } from "../../components/ui/Badge";
import { IconChevronDown, IconExternal } from "../../components/icons";

const statusLabel = { planned: "计划中", ongoing: "进行中", announced: "已宣布", closed: "已完成", unknown: "状态未明确" };
const basisLabel = { round: "本轮金额", cumulative: "累计金额", target: "目标金额", unknown: "金额口径未明确" };

function amount(claim: FinancingClaim) {
  return [claim.amountText, claim.currency].filter(Boolean).join(" ");
}

function Report({ report }: { report: FinancingReport }) {
  const c = report.claim;
  const fields = c ? [
    [c.kind === "fund_raise" ? "基金" : "公司", c.company],
    [basisLabel[c.amountBasis], c.amountText ? amount(c) : "金额未披露"],
    ["轮次", c.round ?? "未披露"], ["交易状态", statusLabel[c.status]],
    ["投资机构", c.investors.join("、") || "未披露"], ...(c.valuationText ? [["估值", c.valuationText]] : []),
  ] : [];
  return (
    <li className="min-w-0 py-3.5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-ink-3">
        <span className="font-semibold">{report.sourceName}</span>
        {report.publishedAt && <time className="num" dateTime={report.publishedAt}>{beijingDate(report.publishedAt)}</time>}
      </div>
      <Link to={`/items/${report.id}`} className="mt-1 block w-fit text-[15px] font-semibold leading-relaxed text-ink hover:text-accent hover:underline">{report.title}</Link>
      {c ? (
        <>
          <dl className="my-2 grid grid-cols-2 gap-x-3 gap-y-2 rounded-control bg-surface p-3 sm:grid-cols-3">
            {fields.map(([name, value]) => <div key={name}><dt className="text-xs text-ink-4">{name}</dt><dd className="mt-0.5 text-[13px] font-medium text-ink-2">{value}</dd></div>)}
          </dl>
          <blockquote className="border-l-2 border-accent/50 pl-3 text-[13px] leading-relaxed text-ink-3">{c.evidence}</blockquote>
        </>
      ) : <p className="mt-1 text-xs text-ink-4">此篇仅收录报道，尚无结构化记录。</p>}
      <a className="mt-1 inline-flex min-h-10 items-center gap-1 text-[13px] font-medium text-accent hover:underline" href={report.url} target="_blank" rel="noreferrer">查看原文 <IconExternal size={13} /></a>
    </li>
  );
}

export function FinancingEvent({ event }: { event: FinancingResponse["events"][number] }) {
  const source = event.reports.find(r => r.claim);
  const claim = source?.claim;
  const date = beijingDate(event.latestAt);
  return (
    <article className="card min-w-0 [overflow-wrap:anywhere]">
      <details className="group/event">
        <summary className="flex cursor-pointer list-none items-start gap-2.5 rounded-card px-3.5 py-3.5 hover:bg-accent-softer sm:gap-4 sm:px-5">
          <time dateTime={event.latestAt} title={`站内时间 ${date}`} className="hidden w-16 shrink-0 border-r border-line pr-3 text-ink-3 sm:block">
            <span className="mono block text-[16px] font-bold text-accent">{date.slice(5).replace("-", "/")}</span>
            <span className="mono text-xs">{date.slice(0, 4)}</span>
          </time>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
              <span className="num sm:hidden">{date}</span>
              <span>{event.reportCount} 篇报道</span>
              {event.differingClaims ? <Badge tone="amber">来源口径有差异</Badge> : !claim ? <Badge tone="neutral">仅有报道</Badge> : null}
            </span>
            <span className="mt-1 block text-[17px] font-bold leading-snug text-ink">{claim?.company ?? event.reports[0]?.title}</span>
            {claim && !event.differingClaims ? (
              <span className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px] text-ink-3">
                {claim.amountText && <span className="font-semibold text-accent">{basisLabel[claim.amountBasis]} · {amount(claim)}</span>}
                {claim.round && <span>{claim.round}</span>}
                <span>{statusLabel[claim.status]}</span>
                {claim.investors.length > 0 && <span>投资方 · {claim.investors.slice(0, 2).join("、")}{claim.investors.length > 2 && ` 等 ${claim.investors.length} 家`}</span>}
                <span>据 {source?.sourceName}</span>
              </span>
            ) : <span className="mt-1 block text-[13px] text-ink-3">{event.differingClaims ? `${event.reports[0]?.sourceName} · ${event.reports[0]?.title}` : event.reports[0]?.sourceName}</span>}
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
