import { Link, useLocation } from "react-router";
import { TABBAR, tabIsActive } from "./nav";
import { useChangelogDot } from "./Sidebar";

/** Bottom tab bar of the mobile shell (up to 960px), as on the original site. */
export function MobileTabBar({ changelogVersion }: { changelogVersion: string | null }) {
  const { pathname } = useLocation();
  const selected = TABBAR.findIndex(item => tabIsActive(item, pathname));
  const dot = useChangelogDot(changelogVersion);
  return (
    <nav aria-label="底部导航" className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
      <div className="relative mx-auto grid h-14 max-w-[640px] grid-cols-5">
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 flex w-1/5 justify-center transition-[transform,opacity] duration-(--motion-standard) ease-out-quart"
          style={{ transform: `translateX(${Math.max(0, selected) * 100}%)`, opacity: selected < 0 ? 0 : 1 }}>
          <span className="mt-[5px] h-[27px] w-12 rounded-lg bg-accent-soft" />
        </span>
        {TABBAR.map((t) => {
          const active = tabIsActive(t, pathname);
          const Icon = t.icon;
          return (
            <Link
              key={t.to}
              to={t.to}
              prefetch="intent"
              aria-current={active ? "page" : undefined}
              className={`relative flex flex-col items-center justify-center gap-0.5 text-[11px] transition-colors ${active ? "font-semibold text-accent" : "text-ink-3 active:text-ink"}`}
            >
              <span className="grid h-[27px] w-12 place-items-center"><Icon size={19} /></span>
              <span>{t.label}</span>
              {dot && t.changelog && <span className="absolute right-[calc(50%-17px)] top-2 size-1.5 rounded-full bg-hot" aria-label="有新的更新" />}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
