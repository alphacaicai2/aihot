import type { ReactNode } from "react";
import { Link } from "react-router";
import { SegmentedControl, SegmentedControlItem } from "../coss/segmented-control";
import { IntentLink } from "./IntentLink";

export interface TabItem {
  key: string;
  label: ReactNode;
  /** Link target; options without one call onSelect. */
  to?: string;
  prefetch?: "intent";
  replace?: boolean;
  count?: number | null;
}

const sizes = { md: "lg", sm: "default", xs: "sm" } as const;

/** Scrollable options shared by route navigation, page sections and single-choice filters. */
export function PillTabs({
  items, active, onSelect, layoutId, size = "md", label, fill = false, className = "",
}: {
  items: TabItem[];
  active: string;
  onSelect?: (key: string) => void;
  layoutId: string;
  size?: keyof typeof sizes;
  label?: string;
  fill?: boolean;
  className?: string;
}) {
  const links = items.some((item) => item.to);
  return (
    <div className={`scrollbar-none max-w-full overflow-x-auto ${fill ? "w-full" : ""} ${className}`}>
      <SegmentedControl
        data-control={layoutId}
        render={links ? <nav /> : undefined}
        role={links ? undefined : "group"}
        aria-label={label}
        size={sizes[size]}
        className={fill ? "grid w-full auto-cols-fr grid-flow-col" : "w-max"}
      >
        {items.map((item) => {
          const selected = item.key === active;
          const TabLink = item.prefetch === "intent" ? IntentLink : Link;
          const render = item.to ? <TabLink to={item.to} replace={item.replace} preventScrollReset /> : undefined;
          return (
            <SegmentedControlItem
              key={item.key}
              render={render}
              aria-current={item.to && selected ? "page" : undefined}
              aria-pressed={item.to ? undefined : selected}
              data-pressed={!item.to && selected ? "" : undefined}
              onClick={item.to ? undefined : () => onSelect?.(item.key)}
            >
              {item.label}
              {item.count != null && <span className="num text-[0.86em] font-normal text-muted-foreground">{item.count}</span>}
            </SegmentedControlItem>
          );
        })}
      </SegmentedControl>
    </div>
  );
}
