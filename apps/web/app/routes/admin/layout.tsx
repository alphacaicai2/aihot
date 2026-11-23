import { FEATURES } from "@aihot/industry/features";
import { SITE } from "@aihot/industry/site";
import { Activity, BookOpenCheck, FileSearch, History, KeyRound, ListChecks, MessagesSquare, Radio, Settings, SlidersHorizontal, type LucideIcon } from "lucide-react";
import { NavLink, Outlet, useNavigation, type ShouldRevalidateFunction } from "react-router";
import type { Route } from "./+types/layout";
import { RingMark } from "../../components/Logo";
import { NavigationProgress } from "../../components/shell/Chrome";
import { Badge } from "../../components/coss/badge";
import { Button } from "../../components/coss/button";
import type { AdminMe } from "../../features/admin/action";
import { Toaster } from "../../features/admin/toast";
import { adminGet } from "../../lib/admin.server";

type Counts = Partial<Record<"feedback" | "sources" | "runs" | "monitor", number>>;

export async function loader({ request }: Route.LoaderArgs) {
  const [me, counts] = await Promise.all([adminGet<AdminMe>(request, "/api/admin/me"), adminGet<Counts>(request, "/api/admin/nav-counts").catch(() => ({}) as Counts)]);
  return { me, counts };
}

// Counts follow every navigation and command; the identity does not change.
export const shouldRevalidate: ShouldRevalidateFunction = () => true;

export const meta: Route.MetaFunction = () => [{ title: `${SITE.name} 后台` }, { name: "robots", content: "noindex, nofollow" }];

export const headers: Route.HeadersFunction = () => ({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });

type Destination = { to: string; label: string; icon: LucideIcon; count?: keyof Counts; tone?: "bad" | "accent" };
const NAV: Array<{ group: string; items: Destination[] }> = [
  {
    group: "内容",
    items: [
      { to: "/admin/content", icon: FileSearch, label: "内容诊断" },
      { to: "/admin/sources", icon: Radio, label: "信源", count: "sources", tone: "bad" },
      ...(FEATURES.codexResetMonitor ? [{ to: "/admin/monitor", icon: Activity, label: "Codex 重置", count: "monitor" as const, tone: "accent" as const }] : []),
      { to: "/admin/feedback", icon: MessagesSquare, label: "反馈", count: "feedback", tone: "accent" },
    ],
  },
  {
    group: "系统",
    items: [
      { to: "/admin/runs", icon: History, label: "运行", count: "runs", tone: "bad" },
      { to: "/admin/models", icon: SlidersHorizontal, label: "模型与评测" },
      { to: "/admin/selectbench", icon: BookOpenCheck, label: "SelectBench" },
      { to: "/admin/memberships", icon: KeyRound, label: "会员授权" },
      { to: "/admin/settings", icon: Settings, label: "设置" },
      { to: "/admin/audit", icon: ListChecks, label: "审计记录" },
    ],
  },
];

function NavItem({ item, counts }: { item: Destination; counts: Counts }) {
  const Icon = item.icon;
  const count = item.count ? counts[item.count] : 0;
  return (
    <NavLink
      to={item.to}
      prefetch="intent"
      className={({ isActive }) =>
        `flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${isActive ? "bg-accent-soft font-medium text-accent-ink" : "text-ink-3 hover:bg-bg-sunk hover:text-ink"}`
      }
    >
      <Icon aria-hidden="true" size={16} strokeWidth={1.75} className="hidden lg:block" />
      <span>{item.label}</span>
      {!!count && <Badge variant={item.tone === "bad" ? "error" : "info"} className="num ml-auto">{count}</Badge>}
    </NavLink>
  );
}

export default function AdminLayout({ loaderData }: Route.ComponentProps) {
  const { me, counts } = loaderData;
  const navigation = useNavigation();
  const flat = NAV.flatMap((g) => g.items);
  return (
    <div className="flex min-h-dvh bg-bg">
      <NavigationProgress active={navigation.state === "loading"} />
      <aside className="sticky top-0 hidden h-dvh w-[var(--sidebar-width)] shrink-0 flex-col border-r border-line bg-surface px-3 py-4 lg:flex">
        <a href="/" className="mb-5 flex items-center gap-2 px-2">
          <RingMark className="size-6 text-accent" />
          <span className="text-[15px] font-semibold tracking-tight text-ink">{SITE.name} 后台</span>
        </a>
        <nav aria-label="后台导航" className="flex-1 space-y-4 overflow-y-auto">
          {NAV.map((g) => (
            <div key={g.group}>
              <div className="mb-1 px-3 text-[11.5px] font-medium tracking-wide text-ink-4">{g.group}</div>
              <div className="space-y-0.5">
                {g.items.map((i) => (
                  <NavItem key={i.to} item={i} counts={counts} />
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="mt-3 border-t border-line px-2 pt-3 text-[12.5px] text-ink-3">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate">{me.name}</span>
            {me.dev && <Badge variant="warning">开发</Badge>}
          </div>
          <form method="post" action="/api/auth/logout" className="mt-1.5">
            <Button type="submit" variant="ghost" size="sm">退出登录</Button>
          </form>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur lg:hidden">
          <div className="page-frame flex items-center gap-2 pt-3">
            <RingMark className="size-5 text-accent" />
            <span className="text-[14px] font-semibold text-ink">{SITE.name} 后台</span>
            {me.dev && <Badge variant="warning">开发</Badge>}
          </div>
          <nav aria-label="后台导航" className="page-frame no-scrollbar flex gap-1 overflow-x-auto py-2">
            {flat.map((i) => <NavItem key={i.to} item={i} counts={counts} />)}
          </nav>
        </div>
        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
      <Toaster />
    </div>
  );
}
