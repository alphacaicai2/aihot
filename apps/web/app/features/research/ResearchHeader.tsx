import type { ReactNode } from "react";

export function ResearchHeader({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <header className="mb-5 flex items-start gap-3 border-b border-line pb-5 pt-5 sm:gap-4 lg:pt-0">
      <span className="grid size-11 shrink-0 place-items-center rounded-card bg-accent text-accent-contrast lg:size-14">{icon}</span>
      <div className="min-w-0">
        <h1 className="text-[25px] font-bold leading-tight tracking-tight text-ink lg:text-[32px]">{title}</h1>
        <p className="mt-1.5 max-w-[62ch] text-[13px] leading-relaxed text-ink-3 lg:text-sm">{children}</p>
      </div>
    </header>
  );
}
