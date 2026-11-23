import { Link } from "react-router";
import type { HotStripEntry } from "@aihot/contracts/site";
import { IconArrowRight, IconFlame, IconMinus, IconTrendDown, IconTrendUp } from "../../components/icons";
import { Card } from "../../components/coss/card";
import { Badge } from "../../components/coss/badge";
import { Button } from "../../components/coss/button";
import { Faces } from "../hot/Faces";

const RANK_COLOR = ["text-rank-1", "text-rank-2", "text-rank-3"];

function hrefOf(e: HotStripEntry): string {
  return e.storyPublicId ? `/story/${e.storyPublicId}` : e.itemId ? `/items/${e.itemId}` : "/hot";
}

/** Where the heat is heading, as a small arrow (a "新" mark for a story new to the ranking). */
function TrendMark({ trend }: { trend: HotStripEntry["trend"] }) {
  if (trend === "up") return <IconTrendUp size={14} strokeWidth={2.2} className="text-hot" aria-hidden="false" role="img" aria-label="热度上升" />;
  if (trend === "down") return <IconTrendDown size={14} strokeWidth={2.2} className="text-ink-4" aria-hidden="false" role="img" aria-label="热度回落" />;
  if (trend === "new") return <Badge variant="secondary" size="sm" className="bg-accent-soft text-accent">新</Badge>;
  if (trend === "unknown") return null; // sources behind on collection: no comparison to show
  return <IconMinus size={14} strokeWidth={2.2} className="text-ink-4" aria-hidden="false" role="img" aria-label="热度持平" />;
}

export function HotTopics({ entries }: { entries: HotStripEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <Card render={<section aria-labelledby="hot-topics" />} className="min-w-0 border-line px-4 pb-1">
      <div className="flex items-center justify-between gap-2 border-b border-line py-2">
        <h2 id="hot-topics" className="flex items-center gap-1.5 text-[16px] font-bold text-ink">
          <span className="grid size-7 place-items-center rounded-control bg-hot-soft text-hot"><IconFlame size={16} /></span> 当前热点
        </h2>
        <Button render={<Link to="/hot" />} size="xs" variant="ghost" className="text-ink-3 hover:bg-bg-sunk hover:text-accent">
          完整榜单 <IconArrowRight size={13} />
        </Button>
      </div>
      <ol className="home-ranking">
        {entries.slice(0, 5).map((e, i) => (
          <li key={e.rank}>
            <Link to={hrefOf(e)} className="group grid grid-cols-[1.25rem_minmax(0,1fr)] items-baseline gap-x-2 rounded-control px-1 py-3 hover:bg-bg-sunk">
              <span className={`mono text-[13px] font-bold leading-none ${RANK_COLOR[i] ?? "text-rank-rest"}`}>{String(e.rank).padStart(2, "0")}</span>
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
    </Card>
  );
}
