import { Link } from "react-router";
import type { HotStripEntry } from "@aihot/contracts/site";
import { IconArrowRight, IconFlame, IconMinus, IconTrendDown, IconTrendUp } from "../../components/icons";
import { Faces } from "../hot/Faces";

// As on the original list: the top three in the ranking colours at the heaviest weight.
const RANK_COLOR = ["text-[15px] font-black text-rank-1", "text-[15px] font-black text-rank-2", "text-[15px] font-black text-rank-3"];

function hrefOf(e: HotStripEntry): string {
  return e.storyPublicId ? `/story/${e.storyPublicId}` : e.itemId ? `/items/${e.itemId}` : "/hot";
}

/** Where the heat is heading, as a small arrow (a "新" mark for a story new to the ranking). */
function TrendMark({ trend }: { trend: HotStripEntry["trend"] }) {
  if (trend === "up") return <IconTrendUp size={14} strokeWidth={2.2} className="text-hot" aria-hidden="false" role="img" aria-label="热度上升" />;
  if (trend === "down") return <IconTrendDown size={14} strokeWidth={2.2} className="text-ink-4" aria-hidden="false" role="img" aria-label="热度回落" />;
  if (trend === "new") return <span className="rounded-full bg-accent-soft px-1.5 text-[10.5px] font-semibold leading-4 text-accent">新</span>;
  if (trend === "unknown") return null; // sources behind on collection: no comparison to show
  return <IconMinus size={14} strokeWidth={2.2} className="text-ink-4" aria-hidden="false" role="img" aria-label="热度持平" />;
}

export function HotTopics({ entries }: { entries: HotStripEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <section aria-labelledby="hot-topics" className="card px-4 pb-1">
      <div className="flex items-center justify-between gap-2 border-b border-line py-2">
        <h2 id="hot-topics" className="flex items-center gap-1.5 text-[16px] font-bold text-ink">
          <IconFlame size={18} className="text-hot" /> 当前热点
        </h2>
        <Link to="/hot" className="inline-flex min-h-9 items-center gap-1 text-[12px] text-ink-3 hover:text-accent">
          完整榜单 <IconArrowRight size={13} />
        </Link>
      </div>
      <ol className="home-ranking">
        {entries.slice(0, 5).map((e, i) => (
          <li key={e.rank}>
            <Link to={hrefOf(e)} className="group grid grid-cols-[1.25rem_minmax(0,1fr)] items-baseline gap-x-2 rounded-control py-2.5 hover:bg-bg-sunk">
              <span className={`mono text-center leading-none ${RANK_COLOR[i] ?? "text-[14px] font-bold text-rank-rest"}`}>{e.rank}</span>
              <span className="line-clamp-2 break-words text-[14px] font-semibold leading-snug text-ink group-hover:text-accent">{e.title}</span>
              <span className="col-start-2 mt-1 flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
                <span><span className="num font-medium">{Math.round(e.heat)}</span> 热度</span>
                <TrendMark trend={e.trend} />
                <span className="ml-auto"><Faces interactive={false} participants={e.participants} total={e.participantCount} max={3} size={16} /></span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
