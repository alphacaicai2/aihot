import type { ReactNode } from "react";
import { Badge as CossBadge } from "../coss/badge";

const variants = {
  selected: "warning",
  accent: "info",
  amber: "warning",
  hot: "error",
  ok: "success",
  neutral: "secondary",
} as const;

export function Badge({ tone = "neutral", dot = false, children, className, title }: { tone?: keyof typeof variants; dot?: boolean; children: ReactNode; className?: string; title?: string }) {
  return (
    <CossBadge variant={variants[tone]} title={title} className={className}>
      {dot && <span className="size-[5px] rounded-full bg-current" aria-hidden="true" />}
      {children}
    </CossBadge>
  );
}

export function SelectedBadge() {
  return <Badge tone="selected" dot>精选</Badge>;
}
