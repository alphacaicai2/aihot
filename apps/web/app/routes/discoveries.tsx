import { Link } from "react-router";
import type { Route } from "./+types/discoveries";
import type { FeedItemSummary } from "@aihot/contracts/site";
import { loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { DayList } from "../features/feed/DayList";
import { ResearchHeader } from "../features/research/ResearchHeader";
import { IconArrowRight, IconChevronDown, IconDoc } from "../components/icons";
import { EmptyState } from "../components/ui/Page";
import { buttonClass } from "../components/ui/Controls";

export async function loader({ request }: Route.LoaderArgs) {
  return loadOr404<{ items: FeedItemSummary[] }>("/api/site/discoveries", { signal: request.signal });
}
export const meta: Route.MetaFunction = () => pageMeta({ title: "一手发现", path: "/discoveries" });
export const headers = () => ({ "Cache-Control": "public, max-age=0, s-maxage=60" });

export default function Discoveries({ loaderData: { items } }: Route.ComponentProps) {
  return (
    <div className="mx-auto max-w-[1060px] pb-6">
      <ResearchHeader icon={<IconDoc size={25} />} title="一手发现">过去七天，本站跟踪的公开信源中，仅有一个来源报道的精选事件。</ResearchHeader>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-line pb-2">
        <h2 className="text-[18px] font-bold">近七天的发现 <span className="num ml-1 text-xs font-normal text-ink-3">本页 {items.length} 条</span></h2>
        <details className="group w-fit max-w-full text-[13px] text-ink-3 open:basis-full">
          <summary className="flex min-h-10 w-fit cursor-pointer items-center gap-1 rounded-control font-medium text-accent">收录口径 <IconChevronDown size={13} className="transition-transform group-open:rotate-180" /></summary>
          <p className="max-w-[62ch] pb-2 leading-relaxed">同一来源重复报道时保留最新一条，出现第二个公开来源后移出本页。单一来源仅指本站的观察范围，热点榜沿用原有热度规则。</p>
        </details>
      </div>
      {items.length ? <DayList items={items} /> : (
        <div className="card"><EmptyState title="近七天暂无符合条件的一手发现" action={<Link className={buttonClass("secondary")} to="/">浏览最新精选 <IconArrowRight size={14} /></Link>}>可以先查看同期入选的其他报道。</EmptyState></div>
      )}
    </div>
  );
}
