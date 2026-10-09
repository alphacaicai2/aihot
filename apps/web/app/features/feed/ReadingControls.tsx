import { setReadingPreferences, useReadingPreferences } from "../../lib/local-state";

export function ReadingControls() {
  const { unreadOnly, compact } = useReadingPreferences();
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[13px] text-ink-3">
      <label className="flex min-h-10 cursor-pointer items-center gap-2">
        <input type="checkbox" checked={unreadOnly} onChange={(e) => setReadingPreferences({ unreadOnly: e.target.checked })} className="size-4 accent-accent" />
        只看未读
      </label>
      <div role="group" aria-label="阅读密度" className="flex rounded-control border border-line-soft p-0.5">
        {([false, true] as const).map((value) => (
          <button key={String(value)} type="button" aria-pressed={compact === value} onClick={() => setReadingPreferences({ compact: value })}
            className={`min-h-9 rounded-control px-3 ${compact === value ? "bg-accent-soft font-medium text-accent" : "hover:bg-bg-sunk"}`}>
            {value ? "紧凑" : "舒适"}
          </button>
        ))}
      </div>
    </div>
  );
}
