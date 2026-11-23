import { SITE } from "@aihot/industry/site";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { Button } from "../coss/button";
import { Wordmark } from "../Logo";
import { useChangelogSeen } from "../../lib/local-state";
import { SIDEBAR, tabIsActive, type NavItem } from "./nav";
import { ThemeSwitch } from "./ThemeSwitch";

/** True while the changelog has an entry newer than the one this reader last opened. */
export function useChangelogDot(latestVersion: string | null): boolean {
  const seen = useChangelogSeen();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || !latestVersion) return false;
  return !seen || seen < latestVersion;
}

function SideLink({ item, dot }: { item: NavItem; dot: boolean }) {
  const { pathname } = useLocation();
  // Weekly and monthly reports belong to the daily report entry, as the phone tab bar has it.
  const isActive = tabIsActive(item, pathname);
  const Icon = item.icon;
  return (
    <Button
      render={<Link to={item.to} prefetch="intent" />}
      variant={isActive ? "outline" : "ghost"}
      aria-current={isActive ? "page" : undefined}
      className={`h-9 w-full justify-start gap-3 px-3 text-[13.5px] sm:h-9 ${isActive ? "font-semibold text-ink" : "text-ink-3 hover:bg-bg-sunk hover:text-ink"}`}
    >
      <span className={`grid w-5 shrink-0 place-items-center ${isActive ? "text-accent" : ""}`}>
        <Icon size={17} />
      </span>
      <span className="min-w-0 truncate">{item.label}</span>
      {dot && item.changelog && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-hot" aria-label="有新的更新" />}
    </Button>
  );
}

export function Sidebar({ changelogVersion }: { changelogVersion: string | null }) {
  const dot = useChangelogDot(changelogVersion);
  return (
    <aside className="sticky top-0 hidden h-dvh w-[var(--sidebar-width)] shrink-0 flex-col border-r border-line bg-sidebar px-3 pb-4 pt-5 lg:flex">
      <Link to="/" className="mb-2 flex h-12 shrink-0 items-center px-2 text-ink" aria-label={`${SITE.name} 首页`}>
        <Wordmark size={21} />
      </Link>
      <nav className="-mx-1 flex-1 overflow-y-auto px-1" aria-label="主导航">
        {SIDEBAR.map((section) => (
          <div key={section.title} className="mt-3 border-t border-line-soft pt-3 first:mt-0 first:border-t-0">
            <div className="px-3 pb-2 text-[11px] font-semibold tracking-wide text-ink-4">{section.title}</div>
            <div className="flex flex-col gap-0.5">
              {section.items.map((item) => (
                <SideLink key={item.to} item={item} dot={dot} />
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="mt-3 space-y-2.5 border-t border-line pt-3">
        <ThemeSwitch />
        {SITE.icp && (
          <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" className="block px-2 text-[10px] text-ink-4 hover:text-ink-3">
            {SITE.icp}
          </a>
        )}
      </div>
    </aside>
  );
}
