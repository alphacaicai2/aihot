import { Badge } from "../../components/ui/Badge";
import { IconChevronDown, IconDownload, IconExternal } from "../../components/icons";

// A deliberately bounded public example, transcribed from the linked announcements.
const rounds = [
  {
    date: "2025-09-02", round: "F 轮", amount: 130, valuation: 1830,
    lead: "ICONIQ、Fidelity Management & Research Company、Lightspeed Venture Partners",
    quote: "Along with ICONIQ, the round was co-led by Fidelity Management & Research Company and Lightspeed Venture Partners.",
    source: "https://www.anthropic.com/news/anthropic-raises-series-f-at-usd183b-post-money-valuation",
  },
  {
    date: "2025-03-03", round: "E 轮", amount: 35, valuation: 615,
    lead: "Lightspeed Venture Partners",
    quote: "The round was led by Lightspeed Venture Partners",
    source: "https://www.anthropic.com/news/anthropic-raises-series-e-at-usd61-5b-post-money-valuation",
  },
];

const columns = [
  ["公司", "公告日期", "轮次", "本轮金额（亿美元）", "投后估值（亿美元）", "领投及共同领投方", "公告原文", "出处"],
  ...rounds.map(r => ["Anthropic", r.date, r.round, r.amount, r.valuation, r.lead, r.quote, r.source]),
];
const csv = columns.map(row => row.map(value => '"' + String(value).replaceAll('"', '""') + '"').join(",")).join("\r\n");
const download = "data:text/csv;charset=utf-8," + encodeURIComponent("\uFEFF" + csv + "\r\n");

function Source({ round }: { round: typeof rounds[number] }) {
  return <div className="mt-2 border-l-2 border-accent/35 pl-3 text-[13px] leading-relaxed text-ink-3">
    <blockquote lang="en">{round.quote}</blockquote>
    <a href={round.source} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-accent hover:underline">Anthropic 官方公告 <IconExternal size={12} /></a>
  </div>;
}

export function FinancingSample() {
  const latest = rounds[0]!;
  return <section id="financing-sample" className="card min-w-0 p-5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-[17px] font-bold text-ink">Anthropic 融资记录</h3>
      <Badge tone="neutral">公开样例 · 2 笔</Badge>
    </div>
    <p className="mt-1.5 text-[13px] text-ink-3">从公司 2025 年的两份公告查看融资历史，核对原文或下载表格。</p>
    <div className="mt-4 border-y border-line py-4">
      <span className="mono text-xs text-ink-3">{latest.date} · {latest.round}</span>
      <div className="mt-2 text-[22px] font-bold text-ink">{latest.amount} 亿美元<span className="ml-2 text-xs font-normal text-ink-3">本轮融资</span></div>
      <p className="mt-1 text-[13px] text-ink-3">投后估值 {latest.valuation.toLocaleString("en-US")} 亿美元</p>
      <details className="disclosure group mt-3">
        <summary className="flex cursor-pointer items-center gap-1.5 py-1 text-sm font-medium text-accent">核对公告引文 <IconChevronDown size={13} className="group-open:rotate-180" /></summary>
        <Source round={latest} />
      </details>
    </div>
    <details className="disclosure group py-2">
      <summary className="flex cursor-pointer items-center justify-between gap-2 py-2 text-sm font-semibold text-accent">查看 Anthropic 融资历史（样例）<IconChevronDown size={14} className="group-open:rotate-180" /></summary>
      <ol className="divide-y divide-line-soft">
        {rounds.map(r => <li key={r.date} className="py-3">
          <p className="num text-xs text-ink-3">{r.date}</p>
          <p className="mt-1 text-sm font-semibold">{r.round} · {r.amount} 亿美元</p>
          <p className="mt-1 text-[13px] text-ink-3">领投及共同领投方 · {r.lead}</p>
          <Source round={r} />
        </li>)}
      </ol>
    </details>
    <a href={download} download="Anthropic-2025-融资样例.csv" className="inline-flex min-h-9 items-center gap-2 text-sm font-medium text-accent hover:underline"><IconDownload size={15} />下载样例 CSV（2 笔）</a>
  </section>;
}
