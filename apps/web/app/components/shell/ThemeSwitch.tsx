import { useEffect, useId, useState, type ReactNode } from "react";
import { SegmentedControl, SegmentedControlItem } from "../coss/segmented-control";
import { IconMonitor, IconMoon, IconSun } from "../icons";
import { resolvedTheme, setThemePreference, useThemePreference, type ThemePreference } from "../../lib/local-state";

type Choice = "dark" | "system" | "light";

const OPTIONS: Array<{ key: Choice; label: string; icon: ReactNode }> = [
  { key: "dark", label: "深色", icon: <IconMoon size={14} /> },
  { key: "system", label: "跟随系统", icon: <IconMonitor size={14} /> },
  { key: "light", label: "浅色", icon: <IconSun size={14} /> },
];

/** Three-way appearance switch (dark / follow the system / light) with a sliding thumb. */
export function ThemeSwitch({ className = "" }: { className?: string }) {
  const pref = useThemePreference();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const current: Choice = !mounted ? "system" : (pref ?? "system");
  const groupName = useId();

  const choose = (key: Choice) => {
    const nextPref: ThemePreference = key === "system" ? null : key;
    setThemePreference(nextPref);
    const apply = () => document.documentElement.setAttribute("data-theme", resolvedTheme(nextPref));
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (doc.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) doc.startViewTransition(apply);
    else apply();
  };

  return (
    <SegmentedControl role="radiogroup" aria-label="外观" className={`w-full ${className}`}>
      {OPTIONS.map((option) => (
        <SegmentedControlItem
          key={option.key}
          render={<label />}
          title={option.label}
          data-checked={current === option.key ? "" : undefined}
          className="flex-1 has-[:focus-visible]:outline-ring"
        >
          <input
            type="radio"
            className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
            name={groupName}
            checked={current === option.key}
            onChange={() => choose(option.key)}
          />
          {option.icon}
          <span className="sr-only">{option.label}</span>
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
