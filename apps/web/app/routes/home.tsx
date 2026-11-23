import { data as withHeaders, Link, redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/home";
import type { TimelineResponse } from "@aihot/contracts/site";
import { isCategoryKey, isChannelKey } from "@aihot/contracts/taxonomy";
import { loadOr404, queryString, releaseBoundCache } from "../lib/api.server";
import { listPath, organizationLd, pageMeta } from "../lib/seo";
import { IconArrowRight, IconChart, IconClock, IconDoc, IconList, IconPlug } from "../components/icons";
import { Card } from "../components/coss/card";
import { Badge } from "../components/ui/Badge";
import { Wordmark } from "../components/Logo";
import { MembershipCallout } from "../components/MembershipCallout";
import { ReaderAccount } from "../components/ReaderAccount";
import { Timeline } from "../features/feed/Timeline";
import { HotTopics } from "../features/feed/HotTopics";
import { CategoryTabs, SearchField, SearchIconLink } from "../features/feed/Filters";
import { beijingDate, beijingWeekday, monthDayTime } from "../lib/format";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q");
  // Search lives on /all; keep the parameters so old links still land on results.
  if (q && q.trim()) throw redirect(`/all${url.search}`);
  const channelParam = url.searchParams.get("channel") ?? "all";
  const categoryParam = url.searchParams.get("category");
  const channel = isChannelKey(channelParam) ? channelParam : "all";
  const category = categoryParam && isCategoryKey(categoryParam) ? categoryParam : null;
  const tag = url.searchParams.get("tag")?.trim() || null;
  const upstream = new Headers();
  const data = await loadOr404<TimelineResponse>(`/api/site/timeline${queryString({ channel: channel === "all" ? null : channel, category, tag })}`, { responseHeaders: upstream, signal: request.signal });
  return withHeaders({ data, filters: { channel, category, tag, topic: null } }, { headers: releaseBoundCache(data.refreshAt, 60, Date.now(), upstream) });
}

export function meta({ loaderData }: Route.MetaArgs) {
  const f = loaderData?.filters;
  const path = listPath("/", { channel: f && f.channel !== "all" ? f.channel : null, category: f?.category, tag: f?.tag });
  return pageMeta({ path, jsonLd: path === "/" ? organizationLd() : undefined });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

const sections = [
  { to: "/all", label: "最新动态", detail: "按时间浏览全部报道", icon: IconList, member: false },
  { to: "/discoveries", label: "一手发现", detail: "近七天仅见单一信源的精选", icon: IconDoc, member: false },
  { to: "/financing", label: "融资数据库", detail: "按公司、机构和日期查融资", icon: IconChart, member: true },
  { to: "/agent", label: "Agent 接入", detail: "MCP、REST API 与会员 RSS", icon: IconPlug, member: true },
];

function SectionIndex() {
  return (
    <Card render={<nav aria-label="内容索引" />} className="home-index border-line">
      <h2 className="hidden text-[17px] font-bold min-[1180px]:block">内容索引</h2>
      <ul className="grid grid-cols-2 min-[1180px]:mt-3 min-[1180px]:grid-cols-1">
        {sections.map(({ to, label, detail, icon: Icon, member }) => (
          <li key={to}>
            <Link to={to} className="group flex min-h-11 items-center justify-center gap-1.5 rounded-control px-2 text-[13px] font-semibold transition-colors hover:bg-accent-soft hover:text-accent min-[1180px]:justify-start min-[1180px]:gap-3 min-[1180px]:px-2 min-[1180px]:py-3">
              <span className="home-index-icon"><Icon size={17} /></span>
              <span className="min-w-0">
                <span className="inline-flex items-center gap-1.5">
                  <span>{label}</span>
                  {member && <Badge tone="accent" className="h-[18px] px-1.5 text-[10.5px]">会员</Badge>}
                </span>
                <span className="mt-0.5 hidden text-[12px] leading-relaxed font-normal text-ink-3 min-[1180px]:block">{detail}</span>
              </span>
              <IconArrowRight size={15} className="ml-auto hidden text-ink-4 group-hover:text-accent min-[1180px]:block" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function Home() {
  const { data, filters } = useLoaderData<typeof loader>();
  const day = beijingDate(data.generatedAt);
  const [year, month, date] = day.split("-");
  const count = data.dayCounts[day] ?? 0;
  const latest = data.cards[0]?.anchorAt;
  const scoped = !!(filters.category || filters.tag || filters.channel !== "all");
  return (
    <div className="reader-home pb-6">
      <div className="flex min-h-12 items-center justify-between gap-2 lg:hidden">
        <Wordmark size={19} className="shrink-0 text-ink" />
        <div className="flex min-w-0 items-center gap-1.5">
          <Link to="/membership" prefetch="intent" className="inline-flex min-h-9 shrink-0 items-center rounded-control px-2 text-[12.5px] font-medium text-accent hover:bg-accent-soft">
            读者会员
          </Link>
          <ReaderAccount />
          <SearchIconLink />
        </div>
      </div>

      <div className="mb-2.5 hidden items-center justify-end gap-3 lg:flex">
        <Link to="/membership" prefetch="intent" className="inline-flex min-h-8 items-center rounded-control px-2 text-[13px] font-medium text-ink-2 transition-colors hover:bg-accent-soft hover:text-accent">
          读者会员
        </Link>
        <ReaderAccount />
      </div>

      <header className="home-masthead">
        <div className="home-dateline">
          <time dateTime={day} className="home-calendar" aria-label={day}>
            <span className="home-calendar-label">{year} / {month}</span>
            <strong>{date}</strong>
            <span className="home-calendar-weekday">{beijingWeekday(day)}</span>
          </time>
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="break-words text-[28px] font-bold leading-tight tracking-tight lg:text-[38px]">{filters.tag ? `#${filters.tag}` : "最新精选"}</h1>
          <p className="home-update">
            <span>{scoped ? "当前筛选 · " : ""}{count ? `今日精选 ${count} 条` : "今日暂无新精选"}</span>
            {latest && <span className="inline-flex items-center gap-1.5"><IconClock size={13} />最近更新 <time dateTime={latest}>{monthDayTime(latest)}</time></span>}
          </p>
        </div>
        <div className="relative hidden lg:block"><SearchField variant="track" keep={{ category: filters.category }} /></div>
      </header>

      <MembershipCallout />

      <div className="home-columns">
        <aside aria-label="热点与栏目" className="home-aside">
          {data.hot && <HotTopics entries={data.hot} />}
          <SectionIndex />
        </aside>
        <div className="min-w-0">
          <CategoryTabs base="/" category={filters.category} channel={filters.channel} layoutId="home-category" className="mb-3" />
          <Timeline initial={data} filters={data.filters} />
        </div>
      </div>
    </div>
  );
}
