import type { StoryDetail, StoryFactView, StoryReportView } from "@aihot/contracts/site";
import { Link } from "react-router";
import { IconChevronDown } from "../../components/icons";
import { monthDayTime, shortSourceName } from "../../lib/format";

function Evidence({ report }: { report: StoryReportView }) {
  return (
    <div className="min-w-0 border-l-2 border-line pl-3">
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-ink-3">
        <span className="font-medium">{shortSourceName(report.source.name)}</span>
        <time dateTime={report.publishedAt}>{monthDayTime(report.publishedAt)}</time>
      </div>
      <Link className="mt-1 block font-medium leading-relaxed text-ink hover:text-accent" to={`/items/${report.id}`}>{report.title}</Link>
      {report.summary && <p className="mt-1 text-[13px] leading-relaxed text-ink-3">{report.summary}</p>}
      {/^https?:\/\//i.test(report.originalUrl) && <a href={report.originalUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center text-[13px] font-medium text-accent hover:underline">查看来源原文 ↗</a>}
    </div>
  );
}

export function FactSources({ fact, timeline }: { fact: StoryFactView; timeline: StoryReportView[] }) {
  const reports = [fact.representative, ...timeline.filter(r => r.factId === fact.factId && r.id !== fact.representative.id)];
  return (
    <details className="group/evidence">
      <summary className="inline-flex min-h-10 cursor-pointer list-none items-center gap-1 text-[13px] font-medium text-accent">
        {reports.length > 1 ? `对照 ${reports.length} 篇报道` : `查看报道 · ${shortSourceName(reports[0]!.source.name)}`}
        <IconChevronDown size={14} className="shrink-0 transition-transform group-open/evidence:rotate-180" />
      </summary>
      <ul className="space-y-4 pb-3 text-sm">{reports.map(r => <li key={r.id}><Evidence report={r} /></li>)}</ul>
    </details>
  );
}

export function StoryOverview({ story }: { story: StoryDetail }) {
  const lead = story.developments.reduce<StoryFactView | undefined>((best, f) => !best || f.reportCount > best.reportCount ? f : best, undefined);
  const newest = story.timeline[0];
  const digest = story.digest || story.summary;
  const comparison = lead && story.timeline.find(r =>
    r.factId === lead.factId && r.source.id !== lead.representative.source.id && r.summary && r.summary !== lead.representative.summary
  );
  return (
    <div className="divide-y divide-line-soft">
      {lead && <div>
        <h3 className="text-xs font-semibold text-ink-3">主要进展</h3>
        <p className="mt-1.5 text-[17px] font-semibold leading-relaxed">{lead.title}</p>
        {comparison && lead.representative.summary && <div className="mt-3 rounded-control bg-bg-sunk px-3.5 py-3">
          <h4 className="text-xs font-semibold text-ink-3">同一进展的不同来源</h4>
          <ul className="mt-1 divide-y divide-line-soft">
            {[lead.representative, comparison].map(r => <li key={r.id} className="py-2 last:pb-0">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[13px] font-semibold">{shortSourceName(r.source.name)}</span>
                {/^https?:\/\//i.test(r.originalUrl) ?
                  <a href={r.originalUrl} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline">原文 ↗</a> :
                  <Link to={`/items/${r.id}`} className="text-xs text-accent hover:underline">查看报道</Link>}
              </div>
              <p className="mt-0.5 text-sm leading-relaxed text-ink-2">{r.summary}</p>
            </li>)}
          </ul>
        </div>}
        <FactSources fact={lead} timeline={story.timeline} />
      </div>}
      {newest && (!lead || newest.id !== lead.representative.id) && <div className="py-3">
        <h3 className="mb-2 text-xs font-semibold text-ink-3">最新报道</h3>
        <Evidence report={newest} />
      </div>}
      {digest ? (
        <details open={lead ? undefined : true} className="group/digest">
          <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-sm font-medium">
            {story.digest ? "完整 AI 综述" : "事件说明"} <IconChevronDown size={14} className="transition-transform group-open/digest:rotate-180" />
          </summary>
          {story.digest && story.digestUpdatedAt && <p className="mb-1 text-xs text-ink-3">根据报道整理 · {monthDayTime(story.digestUpdatedAt)} 更新</p>}
          <p className="whitespace-pre-line text-[15px] leading-[1.85] text-ink-2">{digest}</p>
        </details>
      ) : null}
      {!story.digest && story.excerpt && <div className="py-3">
        <h3 className="text-xs font-semibold text-ink-3">报道摘要 · {shortSourceName(story.excerpt.sourceName)}</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{story.excerpt.text}</p>
      </div>}
      {!digest && !story.excerpt && !lead && !newest && <p className="text-sm text-ink-3">暂无综述，可查看下方报道时间线。</p>}
    </div>
  );
}
