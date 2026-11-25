import { useId, useCallback, useState } from "react";
import { SegmentedControl, SegmentedControlItem } from "../../components/coss/segmented-control";
import { Switch } from "../../components/coss/switch";
import { markRead, markUnread, setReadingPreferences, useReadingPreferences } from "../../lib/local-state";

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

export function useUnreadUndo() {
  const [removed, setRemoved] = useState<{id:string; title:string} | null>(null);
  const mark = useCallback((item: {id:string; title:string}) => {
    markRead(item.id);
    setRemoved({id:item.id, title:item.title});
  }, []);
  const notice = removed && <div className="fixed inset-x-3 bottom-[calc(72px+env(safe-area-inset-bottom))] z-40 mx-auto flex w-fit max-w-[90vw] items-center gap-3 rounded-tile bg-ink px-3 py-1 text-sm text-bg shadow-lg lg:bottom-6">
    <span role="status" className="line-clamp-2">已标为已读：{removed.title}</span>
    <button type="button" className="min-h-10 shrink-0 px-1 font-semibold underline" onClick={() => {
      markUnread(removed.id);
      setRemoved(null);
    }}>撤销</button>
    <button type="button" className="min-h-10 shrink-0 px-1" aria-label="关闭提示" onClick={() => setRemoved(null)}>×</button>
  </div>;
  return {mark,notice};
}
