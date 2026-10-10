import { useEffect, useRef, useState } from "react";
import type { HotResponse } from "@aihot/contracts/site";
import { SITE } from "@aihot/industry/site";
import { Button, buttonClass } from "../../components/ui/Controls";
import { createHotShareImage } from "./share-image";

export function ShareHotButton({ hot }: { hot: HotResponse }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => () => { generation.current += 1; }, []);
  useEffect(() => () => { if (image) URL.revokeObjectURL(image); }, [image]);

  async function generate() {
    if (busy) return;
    const current = ++generation.current;
    setBusy(true);
    setError(false);
    setImage(null);
    dialog.current?.showModal();
    try {
      const blob = await createHotShareImage(hot, `${window.location.origin}/hot`);
      if (current === generation.current) setImage(URL.createObjectURL(blob));
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  return (
    <>
      <Button onClick={generate} disabled={busy || !hot.entries.length}>
        {busy ? "正在生成…" : "分享榜单"}
      </Button>
      <dialog ref={dialog} aria-labelledby="share-hot-title" className="fixed inset-0 m-auto max-h-[90dvh] w-[min(520px,calc(100vw-24px))] overflow-y-auto rounded-sheet border border-line bg-surface p-5 text-ink shadow-xl backdrop:bg-black/50">
        <div className="flex items-center justify-between gap-3">
          <h2 id="share-hot-title" className="text-lg font-semibold">分享热点榜</h2>
          <Button size="sm" variant="ghost" onClick={() => dialog.current?.close()}>关闭</Button>
        </div>
        <p className="mt-2 text-sm text-ink-3">保存图片后即可分享，手机也可以长按图片保存。</p>
        <div aria-live="polite" className="mt-4">
          {busy && <p className="py-10 text-center text-ink-3">正在生成榜单图片…</p>}
          {error && <div role="alert" className="py-6 text-center"><p className="mb-3">图片生成失败，请重试。</p><Button onClick={generate}>重新生成</Button></div>}
          {image && <><a href={image} download={`${SITE.name}-热点榜.png`} className={`${buttonClass("primary")} mb-4 w-full`}>下载 PNG 图片</a><img src={image} alt={`${SITE.name}热点榜分享图片，包含当前全部 ${hot.entries.length} 个事件`} className="w-full rounded-panel" /></>}
        </div>
      </dialog>
    </>
  );
}
