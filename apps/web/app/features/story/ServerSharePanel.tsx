import { useEffect, useState } from "react";
import { DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../../components/coss/dialog";
import { Button, buttonClass } from "../../components/ui/Controls";
import { shareLink } from "../../lib/share-link";
import { canShareImage, shareImage } from "../hot/share-file";

export function ServerSharePanel({ title, heading, path, src, filename }: {
  title:string; heading:string; path:string; src:string; filename:string;
}) {
  const [attempt, setAttempt] = useState(0);
  const [image, setImage] = useState<{url:string; file:File; canShare:boolean} | null>(null);
  const [failed, setFailed] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let url: string | undefined;
    const controller = new AbortController();
    setFailed(false);
    setImage(null);
    async function load() {
      try {
        const response = await fetch(src, { signal:controller.signal, cache:attempt ? "reload" : "default" });
        if (!response.ok || !response.headers.get("content-type")?.startsWith("image/png")) throw Error("image");
        const file = new File([await response.blob()], filename, {type:"image/png"});
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(file);
        setImage({url,file,canShare:canShareImage(file,navigator)});
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    }
    void load();
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [src, filename, attempt]);

  async function sharePicture() {
    if (!image || sharing) return;
    setSharing(true);
    setNotice("");
    const result = await shareImage(image.file, navigator);
    if (result === "shared") setNotice("图片已交给系统分享。");
    if (result === "failed" || result === "unsupported") setNotice("图片未能分享，可以保存后发送。");
    setSharing(false);
  }
  async function shareUrl() {
    const url = new URL(path, window.location.origin).href;
    const result = await shareLink(title, url);
    if (result === "manual") setNotice("请选中并复制链接：" + url);
    if (result === "copied") setNotice("链接已复制");
    if (result === "shared") setNotice("已打开系统分享");
  }
  return <DialogPopup closeProps={{"aria-label":"关闭"}}>
    <DialogHeader><DialogTitle>{heading}</DialogTitle><DialogDescription>{title}</DialogDescription></DialogHeader>
    <DialogPanel>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={shareUrl}>分享链接</Button>
        {image?.canShare && <Button onClick={sharePicture} disabled={sharing}>{sharing ? "正在分享…" : "分享图片"}</Button>}
        {image && <a href={image.url} download={filename} className={buttonClass(image.canShare ? "secondary" : "primary")}>保存图片</a>}
      </div>
      {notice && <p role="status" className="mt-3 select-text break-all text-sm text-ink-2">{notice}</p>}
      <div aria-live="polite" className="mt-4">
        {failed ? <div role="alert" className="py-5 text-center"><p className="mb-2">图片加载失败，仍可分享链接。</p><Button onClick={() => setAttempt(n => n + 1)}>重新加载</Button></div> :
          image ? <img src={image.url} alt={title + " · 分享图片"} className="w-full rounded-panel" /> :
          <p className="py-10 text-center text-ink-3">正在加载分享图…</p>}
      </div>
    </DialogPanel>
  </DialogPopup>;
}
