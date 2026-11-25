import { Autocomplete } from "@base-ui/react/autocomplete";
import { useEffect, useId, useMemo, useState } from "react";
import { investorSearchKey, type InvestorOption } from "@aihot/contracts/financing";
import { IconChevronDown } from "../../components/icons";

export function InvestorPicker({ initial, initialExact }: { initial: string; initialExact: boolean }) {
  const id = useId();
  const [value, setValue] = useState(initial);
  const [exact, setExact] = useState(initialExact);
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<InvestorOption[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open || options) return;
    const controller = new AbortController();
    setFailed(false);
    fetch("/api/site/financing/investors", { signal: controller.signal }).then(async response => {
      if (!response.ok) throw Error("Investor directory unavailable");
      const result: InvestorOption[] = await response.json();
      if (!controller.signal.aborted) setOptions(result);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [open, options]);

  const matches = useMemo(() => {
    const key = exact ? "" : investorSearchKey(value);
    if (!key) return options?.slice(0, 12) ?? [];
    const ranked = (options ?? []).map(option => {
      const terms = [option.name, ...option.aliases].map(investorSearchKey);
      const rank = terms.includes(key) ? 0 : terms.some(t => t.startsWith(key)) ? 1 : terms.some(t => t.includes(key)) ? 2 : 3;
      return { option, rank };
    });
    return ranked.filter(r => r.rank < 3).sort((a,b) => a.rank - b.rank).slice(0,12).map(r => r.option);
  }, [value, exact, options]);

  return <div className="min-w-0">
    <label htmlFor={id} className="text-[13px] font-semibold text-ink-2">投资机构</label>
    <Autocomplete.Root items={matches} filter={null} value={value} openOnInputClick open={open}
      itemToStringValue={item => item.name}
      onValueChange={(next, details) => { setValue(next); setExact(details.reason === "item-press"); }}
      onOpenChange={(next, details) => { setOpen(next); if (details.reason === "item-press") setExact(true); }}>
      <Autocomplete.InputGroup className="mt-1.5 flex min-h-11 items-center rounded-lg border border-input bg-background shadow-xs/5 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/24">
        <Autocomplete.Input id={id} name="investor" maxLength={160} placeholder="搜索机构名称或简称"
          className="min-w-0 flex-1 bg-transparent py-2 pl-3 text-base text-ink outline-none placeholder:text-ink-4 sm:text-sm" />
        <Autocomplete.Trigger aria-label="展开或收起投资机构" className="grid size-11 shrink-0 place-items-center rounded-lg text-ink-3 hover:text-accent">
          <IconChevronDown size={16} />
        </Autocomplete.Trigger>
      </Autocomplete.InputGroup>
      <Autocomplete.Portal>
        <Autocomplete.Positioner align="start" sideOffset={5} className="z-50 w-(--anchor-width) max-w-(--available-width)">
          <Autocomplete.Popup data-slot="investor-popup" className="max-h-[min(19rem,var(--available-height))] overflow-y-auto overscroll-contain rounded-lg border border-line bg-surface p-1 text-ink shadow-lg">
            <Autocomplete.List>
              {(item: InvestorOption) => <Autocomplete.Item key={item.name} value={item}
                className="flex min-h-12 cursor-pointer flex-col justify-center gap-0.5 rounded-md px-3 py-2 text-sm data-highlighted:bg-accent-soft data-highlighted:text-accent">
                <span className="font-semibold break-words">{item.name}</span>
                {item.aliases.length > 0 && <span className="text-xs break-words text-ink-3">{item.aliases.slice(0,3).join(" · ")}</span>}
              </Autocomplete.Item>}
            </Autocomplete.List>
            {!matches.length && <div role="status" className="px-3 py-3 text-sm text-ink-3">
              {failed ? "机构列表加载失败，仍可输入名称筛选。" : !options ? "正在加载机构…" : "没有匹配的机构，试试其他名称。"}
            </div>}
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
    {exact && value && <input type="hidden" name="investorMode" value="exact" />}
  </div>;
}
