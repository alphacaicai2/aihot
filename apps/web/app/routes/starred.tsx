import { SITE } from "@aihot/industry/site";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Presence } from "../components/ui/Presence";
import { pageMeta } from "../lib/seo";
import { exportBundle, importBundle, removeStar, restoreStar, updateBookmarks, useStarred, type LocalStarredItem, type ImportReport } from "../lib/local-state";
import { fullDateTime, shortSourceName } from "../lib/format";
import { IconBookmark, IconDownload, IconClose } from "../components/icons";

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

export function meta() {
  return pageMeta({ title: "我的收藏", description: `保存在这台设备上的 ${SITE.name} 收藏。`, path: "/starred", noindex: true });
}

function reportText(r: ImportReport): string {
  const parts = [`新增收藏 ${r.starredAdded} 条`, `已读记录 ${r.readAdded} 条`];
  if (r.starredSkipped || r.readSkipped) parts.push(`超出上限或格式不对而跳过 ${r.starredSkipped + r.readSkipped} 条`);
  if (r.themeApplied) parts.push("已沿用导入的主题");
  if (r.readFailed) parts.push("已读记录没能保存（浏览器存储已满或不可用）");
  return parts.join("，");
}


export default function StarredPage() {
  const starred = useStarred();
  const [removed, setRemoved] = useState<LocalStarredItem[]>([]);
  const [mounted, setMounted] = useState(false);
  const [availability, setAvailability] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => setMounted(true), []);

  const starredIds = starred.map((s) => s.id).join(",");
  useEffect(() => {
    if (!mounted || !starredIds) return;
    const controller = new AbortController();
    fetch(`/api/site/items/availability?ids=${encodeURIComponent(starredIds)}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : {}))
      .then((data) => { if (!controller.signal.aborted) setAvailability(data); })
      .catch(() => {});
    return () => controller.abort();
  }, [mounted, starredIds]);

  const doExport = () => {
    const blob = new Blob([JSON.stringify(exportBundle(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${SITE.mcpPrefix}-local-data-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const doImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      const report = await updateBookmarks(() => importBundle(text));
      setNotice({ kind: report.readFailed ? "error" : "ok", text: `导入完成：${reportText(report)}` });
    } catch (e) {
      setNotice({ kind: "error", text: e instanceof Error ? e.message : "导入失败" });
    }
  };

  const visible = removed.length ? [...starred, ...removed.filter(item => !starred.some(s => s.id === item.id))]
    .sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt)) : starred;
  const action = "text-[12.5px] text-ink-3 transition-colors hover:text-accent";
  return (
    <div className="pb-12">
      <header className="flex flex-col gap-2 pb-4 pt-5 sm:flex-row sm:items-start sm:justify-between lg:pt-0">
        <div>
          <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">收藏</h1>
          <p className="mt-1.5 text-[13px] text-ink-3">本机收藏的 {SITE.name} 内容，适合稍后阅读和回看。</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 sm:pt-1.5">
          <button type="button" onClick={() => fileRef.current?.click()} className={action}>
            导入文件
          </button>
          {mounted && starred.length > 0 && (
            <button type="button" onClick={doExport} className={`${action} inline-flex items-center gap-1`}>
              <IconDownload size={13} /> 导出
            </button>
          )}
          <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" onChange={(e) => doImport(e.target.files?.[0])} />
        </div>
      </header>
      <p className="rounded-tile border border-line bg-surface px-4 py-2.5 text-[12.5px] text-ink-3">收藏只保存在当前浏览器；清除浏览器数据或换设备后不会同步。</p>
      <Presence show={!!notice} enter="anim-notice-in" exit="anim-fade-out" duration={160}>
        <div
          role="status"
          className={`mt-3 flex items-start justify-between gap-3 rounded-tile px-4 py-2.5 text-[13px] ${notice?.kind === "ok" ? "bg-accent-soft text-accent-ink dark:text-accent" : "bg-hot-soft text-hot"}`}
        >
          {notice?.text}
          <button type="button" aria-label="关闭" onClick={() => setNotice(null)} className="shrink-0 opacity-70 hover:opacity-100">
            <IconClose size={14} />
          </button>
        </div>
      </Presence>
      {!mounted ? null : visible.length === 0 ? (
        <div className="mt-3 flex flex-col items-center rounded-card border border-dashed border-line-strong px-6 py-12 text-center">
          <IconBookmark size={20} className="text-ink-4" />
          <p className="mt-3 text-[13px] text-ink-3">还没有收藏内容。点开任意一条内容，在详情页点击收藏即可添加。</p>
          <Link to="/" className="mt-4 text-[12.5px] font-medium text-accent hover:text-accent-ink">
            去看精选 →
          </Link>
        </div>
      ) : (
        <ul className="mt-3 lg:space-y-3">
          {visible.map((s) => {
            if (removed.some(item => item.id === s.id) && !starred.some(item => item.id === s.id)) {
              return <li key={s.id} className="flex items-center justify-between gap-3 border-b border-line-soft px-3 py-3">
                <span role="status" className="text-sm text-ink-3">已取消收藏：{s.title}</span>
                <button type="button" className="min-h-11 shrink-0 px-2 text-sm font-semibold text-accent" onClick={async () => {
                  if (await updateBookmarks(() => restoreStar(s))) setRemoved(items => items.filter(item => item.id !== s.id));
                  else setNotice({ kind:"error", text:"收藏未能恢复，请检查浏览器存储和收藏数量。" });
                }}>撤销</button>
              </li>;
            }
            const status = availability[s.id];
            const unavailable = status === "unavailable";
            return (
              <li key={s.id} className={`relative border-b border-line-soft py-4 lg:card lg:px-[18px] lg:py-[15px] ${unavailable ? "opacity-70" : "lg:card-hover"}`}>
                <div className="flex items-center gap-2 text-[12.5px] text-ink-4">
                  <span className="min-w-0 truncate text-ink-3">{shortSourceName(s.sourceName)}</span>
                  {s.publishedAt && <span className="num shrink-0">· {fullDateTime(s.publishedAt)}</span>}
                  <span className="ml-auto hidden shrink-0 sm:inline">
                    收藏于 <span className="num">{fullDateTime(s.savedAt)}</span>
                  </span>
                  <button type="button" aria-label="取消收藏" title="取消收藏" onClick={async () => {
                    if (await updateBookmarks(() => removeStar(s.id))) setRemoved(items => [...items.filter(item => item.id !== s.id), s]);
                    else setNotice({ kind:"error", text:"未能取消收藏，请检查浏览器存储。" });
                  }} className="relative z-10 -my-1 ml-auto grid size-7 shrink-0 place-items-center rounded-full text-ink-4 transition-colors hover:bg-bg-sunk hover:text-ink sm:ml-0">
                    <IconClose size={14} />
                  </button>
                </div>
                <h2 className="mt-1.5 text-[16px] font-[650] leading-[1.55] text-ink">
                  {unavailable ? (
                    s.title
                  ) : (
                    <Link to={`/items/${s.id}`} className="transition-colors after:absolute after:inset-0 after:content-[''] hover:text-accent">
                      {s.title}
                    </Link>
                  )}
                </h2>
                {s.summary && <p className="mt-1.5 line-clamp-2 text-[14px] leading-[1.75] text-ink-3">{s.summary}</p>}
                {unavailable && <p className="mt-2 text-[12.5px] text-hot">这条内容已不再公开，收藏会保留直到你手动移除。</p>}
                {status === "summary-only" && <p className="mt-2 text-[12.5px] text-amber-ink">应来源方要求，这条内容现在只提供摘要。</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
