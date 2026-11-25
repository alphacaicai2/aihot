import { onMediaChange } from "./lib/media-query";
import { titled } from "./lib/seo";
import { SITE } from "@aihot/industry/site";
import {
  isRouteErrorResponse, Link, Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData, useLocation, useNavigation, useNavigationType, useRouteError, useRouteLoaderData,
  type ShouldRevalidateFunction,
} from "react-router";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { Route } from "./+types/root";
import "./app.css";
import { Sidebar } from "./components/shell/Sidebar";
import { MobileTabBar } from "./components/shell/MobileTabBar";
import { BackToTop, NavigationProgress } from "./components/shell/Chrome";
import { RingMark } from "./components/Logo";
import { buttonClass } from "./components/ui/Controls";
import { resolvedTheme, THEME_BOOT_SCRIPT, useThemePreference } from "./lib/local-state";
import { apiGet } from "./lib/api.server";
import { useHydratedFlag } from "./lib/hydration";

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.ico", sizes: "any" },
  { rel: "icon", type: "image/png", href: "/icon.png" },
  { rel: "apple-touch-icon", href: "/apple-icon.png" },
  { rel: "manifest", href: "/manifest.webmanifest" },
  { rel: "alternate", type: "application/rss+xml", title: `${SITE.name} — 精选`, href: "/feed.xml" },
];

interface SiteMeta {
  changelogVersion: string | null;
}

export async function loader({ request }: Route.LoaderArgs) {
  try {
    return await apiGet<SiteMeta>("/api/site/meta", { signal: request.signal });
  } catch {
    return { changelogVersion: null } satisfies SiteMeta;
  }
}

export const shouldRevalidate: ShouldRevalidateFunction = () => false;

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang={SITE.locale} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#faf9f6" />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#13191c" />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration getKey={(location) => location.key} />
        <Scripts />
      </body>
    </html>
  );
}

/** Only a page nobody matched falls back to this; every page names itself. */
export function meta({ error }: Route.MetaArgs) {
  if (!error) return [];
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return [{ title: titled(notFound ? "页面不存在" : "暂时无法加载") }, { name: "robots", content: "noindex" }];
}

/** Sidebar, main column and phone tab bar around a page (or an error). */
function SiteShell({ changelogVersion, children }: { changelogVersion: string | null; children: ReactNode }) {
  const navigation = useNavigation();
  const { pathname } = useLocation();
  const action = useNavigationType();
  const previousPath = useRef(pathname);
  const main = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const heading = main.current?.querySelector("h1");
    if (!heading?.animate || action === "POP" || reduce.matches) return;
    const token = getComputedStyle(heading);
    const entry = heading.animate([{ opacity: .72, translate: "0 2px" }, { opacity: 1, translate: "none" }], {
      duration: parseFloat(token.getPropertyValue("--motion-standard")), easing: token.getPropertyValue("--ease-out-quart").trim(),
    });
    const cancel = () => entry.cancel();
    const stopReduce = onMediaChange(reduce, cancel);
    return () => { cancel(); stopReduce(); };
  }, [pathname, action]);
  return (
    <div className="flex min-h-dvh">
      <NavigationProgress active={navigation.state === "loading"} />
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-control focus:bg-surface focus:px-3 focus:py-2">
        跳到正文
      </a>
      <Sidebar changelogVersion={changelogVersion} />
      {/* Mobile shell (≤ 960px): one centred column, the tab bar below. Desktop: the page fills the main area
          up to the list width (--page-max-wide), centred beyond it. */}
      <main ref={main} id="main" tabIndex={-1} className="outline-none min-w-0 flex-1 pb-[calc(72px+env(safe-area-inset-bottom))] lg:pb-[72px] lg:pt-6">
        <div className="page-frame">{children}</div>
      </main>
      <MobileTabBar changelogVersion={changelogVersion} />
      <BackToTop />
    </div>
  );
}

export default function App() {
  const meta = useLoaderData<typeof loader>();
  useHydratedFlag();
  const preference = useThemePreference();
  useLayoutEffect(() => {
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.setAttribute("data-theme", resolvedTheme());
    apply();
    return onMediaChange(scheme, apply);
  }, [preference]);
  const { pathname } = useLocation();
  // The admin has its own chrome.
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return <Outlet />;
  return (
    <SiteShell changelogVersion={meta.changelogVersion}>
      <Outlet />
    </SiteShell>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const site = useRouteLoaderData<typeof loader>("root");
  const { pathname, search, hash } = useLocation();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const notFound = status === 404;
  const admin = pathname === "/admin" || pathname.startsWith("/admin/");
  const financing = pathname === "/financing" || pathname.startsWith("/financing/");
  const retryable = status >= 500 || status === 429;
  const home = admin ? "/admin" : financing ? "/financing" : "/";
  const homeLabel = admin ? "返回管理后台" : financing ? "返回融资数据库" : "回到精选";
  const body = (
    <div className="flex min-h-[70vh] items-center justify-center px-2 py-16">
      <div className="max-w-sm text-center">
        <RingMark className="mx-auto mb-5 size-10 text-accent" />
        <div className="mono text-[12px] text-ink-4">{status}</div>
        <h1 className="mt-1.5 text-[20px] font-bold text-ink">{notFound ? "这里没有内容" : retryable ? "暂时无法加载" : "无法打开此页面"}</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-3">
          {notFound ? "你访问的页面不存在，或内容已不再公开。" : retryable ? "请稍后重试。" : "请检查链接或返回重新选择。"}
        </p>
        <div className="mt-6 flex justify-center gap-2.5">
          {retryable && <a href={pathname + search + hash} className={buttonClass("primary")}>重新加载</a>}
          <Link to={home} className={buttonClass(retryable ? "secondary" : "primary")}>{homeLabel}</Link>
        </div>
      </div>
    </div>
  );
  // Admin errors stay inside the admin's own chrome.
  if (admin) return body;
  return <SiteShell changelogVersion={site?.changelogVersion ?? null}>{body}</SiteShell>;
}
