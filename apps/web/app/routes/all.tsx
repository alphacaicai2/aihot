import { SITE, withSubject } from "@aihot/industry/site";
import { data as routeData, Link, useLocation, useLoaderData, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/all";
import type { PoolResponse } from "@aihot/contracts/site";
import { CHANNEL_LABELS, isCategoryKey, isChannelKey } from "@aihot/contracts/taxonomy";
import { loadOr404, queryString } from "../lib/api.server";
import { listPath, pageMeta } from "../lib/seo";
import { CategoryTabs, hrefWith } from "../features/feed/Filters";
import { PillTabs } from "../components/ui/Tabs";
import { DayList, Pagination } from "../features/feed/DayList";
import { EmptyState } from "../components/ui/Page";
import { PoolSearch } from "../features/feed/PoolSearch";
import { IconClose, IconList } from "../components/icons";
import { dateProblem } from "../lib/date-range";
import { RingMark } from "../components/Logo";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const channelParam = url.searchParams.get("channel") ?? "all";
  const categoryParam = url.searchParams.get("category");
  const channel = isChannelKey(channelParam) ? channelParam : "all";
  const category = categoryParam && isCategoryKey(categoryParam) ? categoryParam : null;
  const tag = url.searchParams.get("tag")?.trim() || null;
  const q = url.searchParams.get("q")?.trim().slice(0, 200) || null;
  const tab = q && url.searchParams.get("tab") === "relevance" ? "relevance" : "time";
  // Legacy deep-paging parameters (deep, anchorAt) still open a normal page.
  const page = Math.min(Math.max(Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1, 1), 50);
  const from = url.searchParams.get("from") || null;
  const to = url.searchParams.get("to") || null;
  const company = url.searchParams.get("company")?.trim() || null;
  const investor = url.searchParams.get("investor")?.trim() || null;
  const filters: PoolResponse["filters"] = { channel, category, tag, q, tab, from, to, company, investor };
  const problem = dateProblem(from ?? "", to ?? "");
  if (problem) return routeData({ data: null, filters, problem }, { status: 400 });
  const data = await loadOr404<PoolResponse>(
    `/api/site/pool${queryString({ channel: channel === "all" ? null : channel, category, tag, q, tab: tab === "time" ? null : tab, from, to, company, investor, page: page > 1 ? page : null })}`,
    { signal: request.signal, busyRedirect: "/all/search-busy" },
  );
  return { data, filters: data.filters, problem: null };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const f = loaderData?.filters;
  const q = f?.q;
  const page = loaderData?.data?.page ?? 1;
  return pageMeta({
    title: q ? `搜索：${q}` : `全部${withSubject("动态")}`,
    description: `${SITE.name} 收录的全部${withSubject("动态")}，可按类别与标签筛选，支持中英文搜索。`,
    path: listPath("/all", { channel: f && f.channel !== "all" ? f.channel : null, category: f?.category, tag: f?.tag, q, tab: f?.tab === "relevance" ? "relevance" : null, page: page > 1 ? page : null }),
    noindex: !!(q || f?.from || f?.company || f?.investor),
  });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=30" };
}

function pageHref(params: URLSearchParams, page: number) {
  const sp = new URLSearchParams(params);
  sp.delete("deep");
  sp.delete("anchorAt");
  sp.delete("search");
  if (page <= 1) sp.delete("page");
  else sp.set("page", String(page));
  const s = sp.toString();
  return s ? `/all?${s}` : "/all";
}

export default function AllPage() {
  const { data, filters: f, problem } = useLoaderData<typeof loader>();
  const location = useLocation();
  const [params] = useSearchParams();
  const navigation = useNavigation();
  const busy = navigation.state === "loading" && navigation.location?.pathname === "/all";
  const chips: Array<{ value: string | null | undefined; clear: Record<string, null> }> = [
    { value: f.channel !== "all" && f.channel !== "firstParty" ? CHANNEL_LABELS[f.channel] : null, clear: { channel: null } },
    { value: f.tag && `#${f.tag}`, clear: { tag: null } },
    { value: f.company && `公司 · ${f.company}`, clear: { company: null } },
    { value: f.investor && `机构 · ${f.investor}`, clear: { investor: null } },
    { value: (f.from || f.to) && `${f.from || "未填"} 至 ${f.to || "未填"}`, clear: { from: null, to: null } },
  ];
  const searchTabHref = (tab: "time" | "relevance") => {
    const sp = new URLSearchParams(params);
    sp.delete("page");
    if (tab === "relevance") sp.set("tab", "relevance");
    else sp.delete("tab");
    return `/all?${sp}`;
  };
  const filtered = !!(f.q || f.category || f.channel !== "all" || chips.some(c => c.value));
  const updated = data && new Date(data.freshness).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" });
  return (
    <div className="mx-auto max-w-[1200px] pb-6">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4 pt-5 lg:pt-0">
        <div className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-card bg-accent text-accent-contrast"><IconList size={23} /></span>
          <h1 className="text-[25px] font-bold tracking-tight lg:text-[32px]">全部动态</h1>
        </div>
        {!f.q && data && <span className="text-[13px] text-ink-3">今日 <b className="num text-ink">{data.todayCount}</b> 条</span>}
      </header>
      <PoolSearch key={location.key} filters={f} focus={params.get("search") === "1"} initialError={problem} />
      <div className="my-3 flex flex-wrap items-center justify-between gap-2">
        <CategoryTabs base="/all" category={f.category} channel={f.channel} layoutId="all-category" size="sm" className="min-w-0" />
        {filtered && <Link to="/all" className="inline-flex min-h-9 items-center rounded-control px-1 text-[13px] font-medium text-accent hover:underline">清除全部条件</Link>}
      </div>
      {chips.some(c => c.value) && <nav aria-label="已应用筛选" className="mb-3 flex flex-wrap gap-1.5">
        {chips.map(({ value, clear }) => value && <Link key={value} to={hrefWith("/all", params, clear)} aria-label={`移除 ${value}`}
          className="inline-flex min-h-9 max-w-full items-center gap-1 rounded-control bg-accent-soft px-2.5 text-xs font-medium text-accent"><span className="break-all">{value}</span><IconClose size={13} className="shrink-0" /></Link>)}
      </nav>}
      {f.q && data && (
        <div className="mb-3 mt-3 flex flex-wrap items-center justify-between gap-2 lg:mt-0">
          <PillTabs
            size="xs"
            layoutId="all-search-sort"
            label="搜索排序"
            active={f.tab}
            items={(["time", "relevance"] as const).map((t) => ({ key: t, label: t === "time" ? "最新（标题与摘要）" : "全文相关", to: searchTabHref(t) }))}
          />
          <span className="text-[12px] text-ink-4">
            找到 <span className="num">{data.total >= 2000 ? "2000+" : data.total}</span> 条 · 更新于 <span className="num">{updated}</span>
          </span>
        </div>
      )}

      {data && <div aria-busy={busy}>
        {data.items.length === 0 ? (
          <div className="mt-2 lg:card">
            <EmptyState
              title="没有找到相关内容"
              action={
                f.q && f.tab === "time" ? (
                  <Link to={searchTabHref("relevance")} className="text-[13px] font-medium text-accent hover:underline">
                    试试“全文相关”，连正文一起搜
                  </Link>
                ) : undefined
              }
            >
              {f.q ? "换个说法，或者去掉筛选再试。" : "这个筛选下暂时没有内容。"}
            </EmptyState>
          </div>
        ) : (
          <DayList items={data.items} todayCount={f.q ? null : data.todayCount} showTags />
        )}
      </div>}
      {data && <Pagination page={data.page} pageCount={data.pageCount} href={(p) => pageHref(params, p)} />}
      {data && data.page >= 50 && <p className="mt-4 text-center text-[12px] text-ink-4">最多提供 50 页，更早的内容请使用搜索或主题页。</p>}
    </div>
  );
}

export function SearchBusy() {
  return (
    <div className="mx-auto max-w-sm py-24 text-center">
      <RingMark className="mx-auto mb-5 size-10 text-accent" spinning />
      <h1 className="text-[20px] font-bold text-ink">搜索有点忙</h1>
      <p className="mt-2 text-[14px] leading-relaxed text-ink-3">现在搜索的人比较多，请稍等几秒再试。列表浏览不受影响。</p>
      <div className="mt-6 flex justify-center gap-2.5">
        <Link to="/all" className="inline-flex h-9 items-center rounded-full bg-accent px-4 text-[13.5px] font-medium text-accent-contrast hover:bg-accent-ink">浏览全部动态</Link>
        <Link to="/" className="inline-flex h-9 items-center rounded-full border border-line-strong bg-surface px-4 text-[13.5px] text-ink-2 hover:border-ink-4">回到精选</Link>
      </div>
    </div>
  );
}
