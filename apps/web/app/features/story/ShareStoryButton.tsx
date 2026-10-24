import { useEffect, useRef, useState } from "react";
import { SITE } from "@aihot/industry/site";
import { Button, buttonClass } from "../../components/ui/Controls";
import { IconShare } from "../../components/icons";
import { canShareImage, shareImage } from "../hot/share-file";

export function ShareStoryButton({ publicId, title }: { publicId: string; title: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);
  const [image, setImage] = useState<{ url: string; file: File; canShare: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => () => { generation.current += 1; }, []);
  useEffect(() => () => { if (image) URL.revokeObjectURL(image.url); }, [image]);

  const storyUrl = () => `${window.location.origin}/story/${publicId}`;

  async function open() {
    const current = ++generation.current;
    setBusy(true);
    setError(false);
    setNotice(null);
    setImage(null);
    if (!dialog.current?.open) dialog.current?.showModal();
    try {
      const res = await fetch(`/og/stories/${encodeURIComponent(publicId)}.png`);
      if (!res.ok || !res.headers.get("content-type")?.startsWith("image/png")) throw new Error("share image unavailable");
      const file = new File([await res.blob()], `${SITE.mcpPrefix}-story-${publicId}.png`, { type: "image/png" });
      if (current === generation.current) setImage({ url: URL.createObjectURL(file), file, canShare: canShareImage(file, navigator) });
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  async function shareLink() {
    try {
      if (navigator.share && window.matchMedia("(pointer: coarse)").matches) {
        try {
          await navigator.share({ title, url: storyUrl() });
          setNotice("链接已交给系统分享，请在目标应用中确认发送。");
          return;
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") return;
        }
      }
      await navigator.clipboard.writeText(storyUrl());
      setNotice("事件链接已复制。");
    } catch {
      setNotice("分享链接失败，请重试。");
    }
  }

  async function sharePicture() {
    if (!image || sharing) return;
    setSharing(true);
    setNotice(null);
    const result = await shareImage(image.file, navigator);
    if (result === "shared") setNotice("图片已交给系统分享，请在目标应用中确认发送。");
    if (result === "unsupported") setNotice("当前浏览器不支持直接分享图片，请先保存图片。");
    if (result === "failed") setNotice("未能打开图片分享，请重试，或先保存图片。");
    setSharing(false);
  }

  return (
    <>
      <Button onClick={open} className="shrink-0"><IconShare size={15} /> 分享事件</Button>
      <dialog ref={dialog} aria-labelledby="share-story-title" className="fixed inset-0 m-auto max-h-[90dvh] w-[min(520px,calc(100vw-24px))] overflow-y-auto rounded-sheet border border-line bg-surface p-5 text-ink shadow-xl backdrop:bg-black/50">
        <div className="flex items-center justify-between gap-3">
          <h2 id="share-story-title" className="text-lg font-semibold">分享事件</h2>
          <Button size="sm" variant="ghost" onClick={() => dialog.current?.close()}>关闭</Button>
        </div>
        <p className="mt-2 text-sm text-ink-3">分享事件链接，或将事件卡片作为图片发送。</p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={shareLink} className="col-span-2">分享链接</Button>
          {image?.canShare && <Button variant="primary" onClick={sharePicture} disabled={sharing}>{sharing ? "正在分享…" : "分享图片"}</Button>}
          {image && <a href={image.url} download={image.file.name} className={`${buttonClass(image.canShare ? "secondary" : "primary")} ${image.canShare ? "" : "col-span-2"}`}>保存图片</a>}
        </div>
        {notice && <p role="status" className="mt-3 text-sm text-ink-2">{notice}</p>}
        <div aria-live="polite" className="mt-4">
          {busy && <p className="py-10 text-center text-ink-3">正在加载事件图片…</p>}
          {error && <div role="alert" className="py-6 text-center"><p className="mb-3">事件图片加载失败，仍可分享链接。</p><Button onClick={open}>重新加载</Button></div>}
          {image && <>
            <p className="mb-3 text-sm text-ink-3">{image.canShare ? "可在系统分享菜单中选择微信等应用；也可以保存图片。" : "当前浏览器不支持直接分享图片，可保存后发送；微信内可长按下方图片。"}</p>
            <img src={image.url} alt={`${title} · 事件分享图片`} className="w-full rounded-panel" />
          </>}
        </div>
      </dialog>
    </>
  );
}
