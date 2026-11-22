import { setReadingPreferences, useReadingPreferences } from "../../lib/local-state";

export function ReadingControls() {
  const { unreadOnly, compact } = useReadingPreferences();
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[13px] text-ink-3">
      <label className="flex min-h-10 cursor-pointer items-center gap-2">
        <input type="checkbox" checked={unreadOnly} onChange={(e) => setReadingPreferences({ unreadOnly: e.target.checked })} className="peer sr-only" />
        <span aria-hidden="true" className="relative h-5 w-8 shrink-0 rounded-full bg-ink-4 transition-colors after:absolute after:top-[3px] after:left-[3px] after:size-3.5 after:rounded-full after:bg-surface after:transition-transform peer-checked:bg-accent peer-checked:after:translate-x-3 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent" />
        只看未读
      </label>
      <div role="group" aria-label="阅读密度" className="flex rounded-full bg-bg-sunk p-[3px] ring-1 ring-inset ring-line-soft">
        {([false, true] as const).map((value) => (
          <button key={String(value)} type="button" aria-pressed={compact === value} onClick={() => setReadingPreferences({ compact: value })}
            className={`min-h-8 rounded-full px-3.5 transition-colors ${compact === value ? "bg-surface font-semibold text-ink shadow-[var(--shadow-thumb)]" : "hover:text-accent"}`}>
            {value ? "紧凑" : "舒适"}
          </button>
        ))}
      </div>
    </div>
  );
}
