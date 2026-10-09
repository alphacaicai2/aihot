import { useId } from "react";

/**
 * The AI score as a small pill, tinted by tier instead of drawn as a bar: strong picks (85+) in a wash of
 * warm red, solid ones (70+) in the accent, the rest as quiet text. The score itself is unchanged.
 */
const TIERS = [
  { min: 85, className: "bg-hot/10 text-hot ring-hot/25" },
  { min: 70, className: "bg-accent-soft text-accent ring-accent/20" },
  { min: 0, className: "text-ink-4 ring-line-soft" },
];

/** The score explanation uses a native popover, including Escape and outside-click dismissal. */
export function ScoreLabel({ score, compact = false }: { score: number | null; compact?: boolean }) {
  const id = useId();
  if (score === null) return null;
  const value = Math.round(score);
  const tier = TIERS.find((t) => value >= t.min)!;
  return (
    <span className="relative z-10 inline-flex">
      <button type="button" popoverTarget={id} aria-label={`AI 评估 ${value} 分，查看评分说明`}
        className={`inline-flex min-h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 ring-1 ring-inset ${tier.className}`}>
        <span className={`${compact ? "text-[11px]" : "text-[12px]"} font-medium`}>AI 评估</span>
        <span className="mono text-[12.5px] font-bold leading-none tabular-nums">{value}</span>
      </button>
      <span id={id} popover="auto" role="dialog" aria-labelledby={`${id}-title`} className="fixed inset-0 m-auto h-fit w-[min(360px,calc(100vw-32px))] rounded-panel border border-line bg-surface p-5 text-left text-[14px] leading-[1.75] text-ink shadow-[var(--shadow-pop)]">
        <span id={`${id}-title`} className="block text-[17px] font-semibold">AI 评估 · {value}/100</span>
        <span className="mt-3 block">分数表示内容值得关注的程度，依据实质份量、信息增量、证据强度、读者相关性和可用性，按内容类型加权。</span>
        <span className="mt-2 block text-ink-3">显示分数为两次独立评分的平均值。AI 判断可能有误，评分不代表事实已被核实，也不同于热点榜的讨论热度。</span>
        <button type="button" popoverTarget={id} popoverTargetAction="hide" className="mt-4 min-h-10 rounded-control bg-accent-soft px-4 font-medium text-accent">知道了</button>
      </span>
    </span>
  );
}
