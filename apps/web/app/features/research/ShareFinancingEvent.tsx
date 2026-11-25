import { useEffect, useRef, useState } from "react";
import type { FinancingResponse } from "@aihot/contracts/financing";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle, DialogTrigger } from "../../components/coss/dialog";
import { Button, buttonClass } from "../../components/ui/Controls";
import { IconShare } from "../../components/icons";
import { financingEventPath } from "../../lib/financing-navigation";
import { canShareImage, shareImage } from "../hot/share-file";
import { createFinancingShareImage } from "./financing-share-image";

export function ShareFinancingEvent({ event }: { event: FinancingResponse["events"][number] }) {
  const claim = event.reports[0]!.claim;
  const title = [claim.company, claim.round].filter(Boolean).join(" ");
  const path = financingEventPath(event.shareId);
  const [notice, setNotice] = useState("");
  const [image, setImage] = useState<{url:string; file:File; shareable:boolean} | null>(null);
  const [error, setError] = useState(false);
  const [sharing, setSharing] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => () => { if (image) URL.revokeObjectURL(image.url); }, [image]);

  async function generate() {
    const current = ++generation.current;
    setImage(null);
    setNotice("");
    setError(false);
    try {
      const blob = await createFinancingShareImage(event);
      if (current !== generation.current) return;
      const file = new File([blob], `${title.replace(/[/\\:*?"<>|]/g, "-")}-融资.png`, { type:"image/png" });
      setImage({url:URL.createObjectURL(file), file, shareable:canShareImage(file, navigator)});
    } catch {
      if (current === generation.current) setError(true);
    }
  }

  async function shareLink() {
    const url = new URL(path, window.location.origin).href;
    if (navigator.share) {
      try {
        await navigator.share({title, url});
        return;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setNotice("链接已复制");
    } catch {
      setNotice("请复制事件链接");
    }
  }
  async function sharePicture() {
    if (!image || sharing) return;
    setSharing(true);
    setNotice("");
    const result = await shareImage(image.file, navigator);
    if (result === "shared") setNotice("图片已交给系统分享。");
    if (result === "failed" || result === "unsupported") setNotice("图片未能分享，可以保存后发送。");
    setSharing(false);
  }

  return <div className="flex flex-wrap items-center gap-x-3 border-t border-line-soft px-3.5 text-xs sm:px-5">
    <a href={path} className="inline-flex min-h-9 items-center text-accent hover:underline">事件链接</a>
    <Dialog onOpenChange={open => {
      if (open) void generate();
      else { generation.current++; setImage(null); }
    }}>
      <DialogTrigger aria-label={`分享融资事件：${title}`} className="inline-flex min-h-9 items-center gap-1 text-ink-3 hover:text-accent"><IconShare size={14} />分享</DialogTrigger>
      <DialogPopup closeProps={{ "aria-label":"关闭" }}>
        <DialogHeader><DialogTitle>分享融资事件</DialogTitle><DialogDescription>{title}</DialogDescription></DialogHeader>
        <DialogPanel>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button onClick={shareLink}>分享链接</Button>
            {image?.shareable && <Button variant="primary" disabled={sharing} onClick={sharePicture}>{sharing ? "正在分享…" : "分享图片"}</Button>}
            {image && <a download={image.file.name} href={image.url} className={buttonClass(image.shareable ? "secondary" : "primary")}>保存图片</a>}
          </div>
          {notice && <p role="status" className="mt-3 text-sm text-ink-2">{notice}</p>}
          <div aria-live="polite" className="mt-4">
            {error ? <div role="alert">图片生成失败。<Button size="sm" onClick={generate}>重新生成</Button></div> :
              image ? <img src={image.url} alt={`${title} · 融资事件分享图`} className="w-full rounded-panel" /> :
              <p className="py-8 text-center text-ink-3">正在生成融资事件图片…</p>}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  </div>;
}
