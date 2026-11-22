import { ShareStoryButton } from "../features/story/ShareStoryButton";
import { SITE, withSubject } from "@aihot/industry/site";
import { Link, useLoaderData } from "react-router";
import type { HotEntryView, HotResponse } from "@aihot/contracts/site";
import { loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { monthDayTime, shortSourceName } from "../lib/format";
import { Badge } from "../components/ui/Badge";
import { buttonClass } from "../components/ui/Controls";
import { EmptyState } from "../components/ui/Page";
import { IconArrowRight, IconChevronDown, IconFlame, IconInfo } from "../components/icons";
import { Sparkline } from "../features/hot/Sparkline";
import { Faces } from "../features/hot/Faces";
import { ShareHotButton } from "../features/hot/ShareHotButton";
import { Delta } from "../features/hot/Delta";

export async function loader({ request }: { request: Request }) {
  return { hot: await loadOr404<HotResponse>("/api/site/hot", { signal: request.signal }) };
}

export function meta() {
  return pageMeta({
    title: withSubject("热点榜"),
    description: `${SITE.name} 的 48 小时热点榜，按讨论热度查看事件、趋势和公开报道来源。`,
    path: "/hot",
    image: "/og/pages/hot.png",
  });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=120, stale-while-revalidate=60" };
}

const BADGES: Record<HotEntryView["badges"][number], { label: string; tone: "hot" | "accent" | "amber"; hint: string }> = {
  surge: { label: "爆", tone: "hot", hint: "讨论快速增加" },
  new: { label: "新", tone: "accent", hint: "首报 6 小时内" },
  rising: { label: "发酵中", tone: "amber", hint: "讨论仍在增加" },
};

const RANK_COLOR = ["text-rank-1", "text-rank-2", "text-rank-3"];
const rankColor = (rank: number) => RANK_COLOR[rank - 1] ?? "text-rank-rest";
const pad = (rank: number) => String(rank).padStart(2, "0");

/** "TechCrunch、The Verge 等 4 个来源 · 7 位参与者". */
function Voices({ e }: { e: HotEntryView }) {
  const names = e.sourceNames.slice(0, 2).map(shortSourceName);
  return (
    <span className="min-w-0 text-[12.5px] leading-snug text-ink-4">
      <span className="[overflow-wrap:anywhere]">
        {names.length > 0 && <span className="text-ink-3">{names.join("、")}</span>}
        {e.sourceCount > names.length ? ` 等 ${e.sourceCount} 个来源` : names.length ? " 报道" : `${e.sourceCount} 个来源`}
      </span>
      <span className="mx-1.5 text-line-strong">·</span>
      <span className="whitespace-nowrap">
        <span className="num">{e.participantCount}</span> 位参与者
      </span>
    </span>
  );
}

function Badges({ e }: { e: HotEntryView }) {
  return e.badges.map((b) => (
    <Badge key={b} tone={BADGES[b].tone} title={BADGES[b].hint}>
      {BADGES[b].label}
    </Badge>
  ));
}

/** The whole card opens the event; the title carries the link and stretches over the card. */
function StoryLink({ e, className }: { e: HotEntryView; className: string }) {
  return (
    <Link to={`/story/${e.story.publicId}`} prefetch="intent" className={`transition-colors after:absolute after:inset-0 after:content-[''] ${className}`}>
      {e.story.title}
    </Link>
  );
}

/**
 * The lead card's picture slot when the story has no picture of its own: its day of heat, drawn large
 * on a faint wash, with where it peaked. Without enough comparable hours the text takes the width.
 */
function HeatPanel({ e }: { e: HotEntryView }) {
  const seen = e.spark.filter((v): v is number => v !== null);
  const peak = Math.max(...seen);
  const peakAt = e.spark.findIndex((v) => v === peak);
  return (
    <div className="flex h-24 min-w-0 flex-col rounded-panel bg-surface/80 p-3 ring-1 ring-inset ring-line-soft lg:h-36 lg:p-4">
      <div className="flex items-baseline justify-between text-[11.5px] text-ink-4">
        <span className="font-semibold text-ink-3">24 小时热度</span>
        <span>
          峰值 <span className="mono text-ink-2">{Math.round(peak)}</span>
          {peakAt >= 0 && <span> · {peakAt === e.spark.length - 1 ? "当前" : `${e.spark.length - 1 - peakAt} 小时前`}</span>}
        </span>
      </div>
      <Sparkline values={e.spark} area stretch className="mt-2 min-h-0 w-full flex-1 text-accent" />
      <div className="mt-2 flex justify-between text-[11px] text-ink-4">
        <span>24 小时前</span>
        <span>现在</span>
      </div>
    </div>
  );
}

function Lead({ e }: { e: HotEntryView }) {
  const panel = !e.cover && e.spark.filter(v => v !== null).length >= 3;
  return (
    <article className="group relative rounded-sheet border border-line bg-surface bg-[linear-gradient(115deg,var(--hot-soft),transparent_60%)] px-4 py-4 sm:p-5 lg:p-6">
      <div className={`grid items-center gap-3 lg:gap-7 ${e.cover || panel ? "lg:grid-cols-[minmax(0,1fr)_minmax(220px,32%)]" : ""}`}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className="rounded-control bg-hot-soft px-2 py-1 font-bold text-hot">热度第 {e.rank} 位</span>
            <Badges e={e} />
          </div>
          <h2 className="mt-2 text-[21px] font-bold leading-snug tracking-tight text-ink [overflow-wrap:anywhere] lg:text-[27px]">
            <StoryLink e={e} className="group-hover:text-accent" />
          </h2>
          {e.summary && <p className="mt-2 line-clamp-2 text-[14px] leading-relaxed text-ink-3 lg:line-clamp-3">{e.summary}</p>}
          {e.latest && <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-ink-2"><strong className="mr-2 text-accent">最新进展</strong>{e.latest}</p>}
        </div>
        {e.cover ? <img src={e.cover.url} srcSet={e.cover.srcSet} sizes="(min-width: 961px) 360px, (min-width: 641px) 568px, 90vw" width={e.cover.width ?? undefined} height={e.cover.height ?? undefined} alt="" fetchPriority="high" decoding="async" className="h-28 w-full rounded-panel object-cover lg:h-36" /> : panel && <HeatPanel e={e} />}
      </div>
      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-t border-line pt-2 lg:grid-cols-[auto_minmax(0,1fr)_auto]">
        <div className="flex items-baseline gap-2">
          <span className="mono text-[26px] font-bold text-ink">{Math.round(e.heat)}</span><span className="text-xs text-ink-3">热度</span>
          <Delta trend={e.trend} pct={e.trendPct} />
          {!panel && <Sparkline values={e.spark} className="hidden h-6 w-16 self-center text-accent sm:block" />}
        </div>
        <div className="col-span-2 row-start-2 flex min-w-0 items-center gap-2 lg:col-span-1 lg:col-start-2 lg:row-start-1 lg:justify-end">
          {e.participantCount > 0 && <Faces participants={e.participants} total={e.participantCount} max={3} size={20} />}
          <Voices e={e} />
        </div>
        <div className="col-start-2 row-start-1 lg:col-start-3"><ShareStoryButton compact publicId={e.story.publicId} title={e.story.title} /></div>
      </div>
    </article>
  );
}

function RankedStory({ e }: { e: HotEntryView }) {
  return (
    <li value={e.rank} className="group relative grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-x-2 px-3 py-3 hover:bg-accent-softer sm:grid-cols-[2rem_minmax(0,1fr)_auto] sm:gap-x-4 sm:px-5 lg:grid-cols-[2.5rem_minmax(0,1fr)_100px_auto] lg:items-center lg:py-4">
      <span className={`mono pt-0.5 text-[15px] font-bold ${rankColor(e.rank)}`} aria-label={`第 ${e.rank} 位`}>{pad(e.rank)}</span>
      <div className="min-w-0">
        <h2 className="text-[16px] font-bold leading-snug text-ink [overflow-wrap:anywhere]">
          <StoryLink e={e} className="group-hover:text-accent" />
        </h2>
        {e.summary && <p className="mt-1 line-clamp-1 text-[13px] leading-relaxed text-ink-3">{e.summary}</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
          {e.participantCount > 0 && <Faces participants={e.participants} total={e.participantCount} max={3} size={18} />}
          <span>{e.sourceCount} 个来源 · {e.participantCount} 位参与者</span>
          <Badges e={e} />
        </div>
      </div>
      <Sparkline values={e.spark} className="hidden h-7 w-[100px] text-accent lg:block" />
      <div className="flex flex-col items-end lg:flex-row lg:items-center lg:gap-3">
        <div className="flex flex-col items-end gap-1 text-right lg:min-w-16">
          <span aria-label={`热度 ${Math.round(e.heat)}`} className="mono text-[19px] font-semibold leading-tight text-ink">{Math.round(e.heat)}</span>
          <Delta trend={e.trend} pct={e.trendPct} />
        </div>
        <ShareStoryButton compact publicId={e.story.publicId} title={e.story.title} />
      </div>
    </li>
  );
}

export default function HotPage() {
  const { hot } = useLoaderData<typeof loader>();
  const [lead, ...rest] = hot.entries;
  return (
    <div className="mx-auto max-w-[1200px] pb-10">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line pb-4 pt-5 lg:pt-0">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-card bg-hot-soft text-hot"><IconFlame size={25} /></span>
          <div>
            <h1 className="text-[25px] font-bold leading-tight tracking-tight lg:text-[32px]">{withSubject("热点榜")}</h1>
            <p className="mt-1 flex flex-wrap gap-x-2 text-xs leading-relaxed text-ink-3">
              <span>近 {hot.windowHours} 小时</span>
              {hot.computedAt && <time dateTime={hot.computedAt}>{monthDayTime(hot.computedAt)} 更新</time>}
            </p>
          </div>
        </div>
        {lead && <ShareHotButton hot={hot} />}
      </header>
      {lead ? (
        <>
          <Lead e={lead} />
          {rest.length > 0 && <section aria-label="热点排名" className="mt-4 sm:mt-5">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-[16px] font-bold">热点排名 <span className="mono ml-1 text-xs font-normal text-ink-4">{pad(rest[0]!.rank)}–{pad(rest[rest.length - 1]!.rank)}</span></h2>
              <span className="text-xs text-ink-3">热度 · 较 6 小时前</span>
            </div>
            <ol start={rest[0]!.rank} className="card divide-y divide-line-soft">{rest.map(e => <RankedStory key={e.story.publicId} e={e} />)}</ol>
          </section>}
        </>
      ) : (
        <div className="card"><EmptyState title="暂时没有热点" action={<Link to="/all" className={buttonClass("secondary")}>浏览全部动态 <IconArrowRight size={14} /></Link>}>当前窗口内，共同讨论同一事件的独立来源还不够多。</EmptyState></div>
      )}

      <details className="disclosure group/method mt-8 text-[12px] text-ink-4">
        <summary className="flex items-center gap-1.5 py-1 transition-colors hover:text-ink-2">
          <IconInfo size={15} />
          热度是怎么算的？
          <span className="ml-auto inline-flex items-center gap-0.5">
            <span className="group-open/method:hidden">了解榜单</span>
            <span className="hidden group-open/method:inline">收起</span>
            <IconChevronDown size={13} className="transition-transform duration-200 group-open/method:rotate-180" />
          </span>
        </summary>
        <div className="max-w-[760px] space-y-2 pb-2 pl-[21px] pt-2 leading-[1.75] text-ink-3">
          <p>热度来自参与同一事件的独立账号与机构，重复采集只算一次，并按 24 小时半衰期衰减。它衡量讨论活跃程度，不是报道质量评分。</p>
          <p>榜单统计过去 48 小时。趋势只比较持续覆盖的同一组信源；它反映我们的监测范围，不代表全网人数。缺少可比历史时，不展示趋势线。</p>
          <p>
            信源名单只展示可公开阅读的报道来源；讨论参与者还包括只计入热度的账号与机构。同一机构的多个渠道可能合并计数，因此参与者不一定多于信源数。点击事件可查看各方报道与观点。
          </p>
          <dl className="flex flex-wrap gap-x-5 gap-y-1.5 pt-1">
            {Object.values(BADGES).map((b) => (
              <div key={b.label} className="flex items-center gap-1.5">
                <dt>
                  <Badge tone={b.tone}>{b.label}</Badge>
                </dt>
                <dd>{b.hint}</dd>
              </div>
            ))}
          </dl>
        </div>
      </details>
    </div>
  );
}
