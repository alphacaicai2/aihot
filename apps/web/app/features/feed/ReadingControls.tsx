import { useId } from "react";
import { SegmentedControl, SegmentedControlItem } from "../../components/coss/segmented-control";
import { Switch } from "../../components/coss/switch";
import { setReadingPreferences, useReadingPreferences } from "../../lib/local-state";

export function ReadingControls() {
  const { unreadOnly, compact } = useReadingPreferences();
  const switchId = useId();
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[13px] text-ink-3">
      <div className="flex items-center gap-2">
        <Switch id={switchId} checked={unreadOnly} onCheckedChange={(value) => setReadingPreferences({ unreadOnly: value })} />
        <label htmlFor={switchId} className="flex min-h-10 cursor-pointer items-center">只看未读</label>
      </div>
      <SegmentedControl size="sm" role="group" aria-label="阅读密度">
        {([false, true] as const).map((value) => (
          <SegmentedControlItem key={String(value)} aria-pressed={compact === value} data-pressed={compact === value ? "" : undefined} onClick={() => setReadingPreferences({ compact: value })}>
            {value ? "紧凑" : "舒适"}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
    </div>
  );
}
