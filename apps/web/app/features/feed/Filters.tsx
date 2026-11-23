// Feed filters: the channel and category row, and search.
import { useEffect, useId, useRef, useState } from "react";
import { Form, Link, useNavigation, useSearchParams } from "react-router";
import { CATEGORY_KEYS, CATEGORY_LABELS, CHANNEL_LABELS, type CategoryKey, type ChannelKey } from "@aihot/contracts/taxonomy";
import { IconClose, IconSearch } from "../../components/icons";
import { Button } from "../../components/coss/button";
import { Input } from "../../components/coss/input";
import { PillTabs } from "../../components/ui/Tabs";

/** Same page with some query parameters changed (paging state dropped). */
export function hrefWith(base: string, params: URLSearchParams, patch: Record<string, string | null>) {
  const sp = new URLSearchParams(params);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === "") sp.delete(k);
    else sp.set(k, v);
  }
  sp.delete("page");
  sp.delete("cursor");
  const s = sp.toString();
  return s ? `${base}?${s}` : base;
}

/**
 * The feed's one filter row (精选 and 全部动态 alike): 全部, 一手, then the categories. One choice at a
 * time: picking 一手 clears the category and picking a category clears 一手. Older 资讯 / X links
 * still filter; the row then shows 全部.
 */
export function CategoryTabs({ base, category, channel = "all", layoutId, size = "md", className = "" }: { base: string; category: CategoryKey | null; channel?: ChannelKey; layoutId: string; size?: "md" | "sm"; className?: string }) {
  const [params] = useSearchParams();
  const items = [
    { key: "all", label: "全部", to: hrefWith(base, params, { category: null, channel: null }) },
    { key: "firstParty", label: CHANNEL_LABELS.firstParty, to: hrefWith(base, params, { category: null, channel: "firstParty" }) },
    ...CATEGORY_KEYS.map((k) => ({ key: k, label: CATEGORY_LABELS[k], to: hrefWith(base, params, { category: k, channel: null }) })),
  ];
  const active = channel === "firstParty" ? "firstParty" : (category ?? "all");
  return <PillTabs items={items} active={active} layoutId={layoutId} label="筛选" size={size} className={className} />;
}

export function useSlashFocus(ref: React.RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement)?.isContentEditable)) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ref]);
}

/**
 * Search field (GET /all?q=…). Desktop ("track"): at the end of the filter row as the same grey track,
 * at the height of md tabs, with a "/" hint. Phones ("bar"): full width with a separate 搜索 button.
 */
export function SearchField({ action = "/all", defaultValue = "", keep = {}, variant = "track", autoFocus = false }: { action?: string; defaultValue?: string; keep?: Record<string, string | null>; variant?: "track" | "bar"; autoFocus?: boolean }) {
  const [value, setValue] = useState(defaultValue);
  const navigation = useNavigation();
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  useEffect(() => setValue(defaultValue), [defaultValue]);
  useSlashFocus(inputRef);
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);
  const searching = navigation.state === "loading" && navigation.location?.pathname === action && !!new URLSearchParams(navigation.location.search).get("q");
  const hidden = Object.entries(keep).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null));

  const bar = variant === "bar";
  return (
    <Form method="get" action={action} role="search" aria-busy={searching} className={bar ? "flex gap-2" : "w-full shrink-0 lg:w-60"}>
      {hidden}
      <div className="relative min-w-0 flex-1">
        <label htmlFor={inputId} className="sr-only">搜索标题、摘要与正文</label>
        <IconSearch size={17} className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={inputId}
          ref={inputRef}
          size="lg"
          type="search"
          name="q"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="搜索标题、摘要…"
          maxLength={200}
          autoComplete="off"
          enterKeyHint="search"
          className="[&_input]:h-10 [&_input]:pr-10 [&_input]:pl-9 sm:[&_input]:h-9"
        />
        {value ? (
          <Button type="button" variant="ghost" size="icon-xs" aria-label="清空"
            onClick={() => { setValue(""); inputRef.current?.focus(); }}
            className="absolute right-1.5 top-1/2 -translate-y-1/2">
            <IconClose size={14} />
          </Button>
        ) : !bar && (
          <kbd className="mono pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-input px-1.5 text-xs text-muted-foreground lg:block">/</kbd>
        )}
      </div>
      {bar && <Button type="submit" size="xl">搜索</Button>}
    </Form>
  );
}

/** Mobile home: the search icon at the end of the category row opens search on 全部动态. */
export function SearchIconLink() {
  return (
    <Button variant="ghost" size="icon" aria-label="搜索" render={<Link to="/all?search=1" />}>
      <IconSearch size={19} />
    </Button>
  );
}
