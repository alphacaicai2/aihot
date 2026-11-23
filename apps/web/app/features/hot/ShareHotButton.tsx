import { Dialog, DialogTrigger, DialogHeader, DialogTitle, DialogDescription, DialogPopup, DialogPanel } from "../../components/coss/dialog";
import { useEffect, useRef, useState } from "react";
import type { HotResponse } from "@aihot/contracts/site";
import { SITE } from "@aihot/industry/site";
import { Button, buttonClass } from "../../components/ui/Controls";
import { createHotShareImage } from "./share-image";
import { canShareImage, shareImage } from "./share-file";

export function ShareHotButton({ hot }: { hot: HotResponse }) {
  const generation = useRef(0);
  const [image, setImage] = useState<{ url: string; file: File; canShare: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => () => { generation.current += 1; }, []);
  useEffect(() => () => { if (image) URL.revokeObjectURL(image.url); }, [image]);

  async function generate() {
    if (busy || sharing) return;
    const current = ++generation.current;
    setBusy(true);
    setError(false);
    setNotice(null);
    setImage(null);
    try {
      const blob = await createHotShareImage(hot, `${window.location.origin}/hot`);
      if (current === generation.current) {
        const file = new File([blob], `${SITE.name}-热点榜.png`, { type: "image/png" });
        setImage({ url: URL.createObjectURL(file), file, canShare: canShareImage(file, navigator) });
      }
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  async function share() {
    if (!image || sharing) return;
    setSharing(true);
    setNotice(null);
    const result = await shareImage(image.file, navigator);
    if (result === "shared") setNotice("图片已交给系统分享，请在微信中确认发送。");
    if (result === "unsupported") setNotice("当前浏览器不支持直接分享图片，请保存图片后在微信中发送。");
    if (result === "failed") setNotice("未能打开图片分享，请重试，或保存图片后在微信中发送。");
    setSharing(false);
  }

  return (
    <Dialog>
      <DialogTrigger render={<Button />} onClick={generate} disabled={busy || sharing || !hot.entries.length}>
        {busy ? "正在生成…" : "分享榜单"}
      </DialogTrigger>
      <DialogPopup closeProps={{ "aria-label": "关闭" }}>
        <DialogHeader>
          <DialogTitle>分享热点榜</DialogTitle>
          <DialogDescription>将当前榜单生成图片，分享给微信好友或保存到相册。</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div aria-live="polite" className="mt-4">
            {busy && <p className="py-10 text-center text-ink-3">正在生成榜单图片…</p>}
            {error && <div role="alert" className="py-6 text-center"><p className="mb-3">图片生成失败，请重试。</p><Button onClick={generate}>重新生成</Button></div>}
            {image && <>
              <div className="flex flex-wrap gap-2">
                {image.canShare && <Button variant="primary" onClick={share} disabled={sharing} className="flex-1">{sharing ? "正在分享…" : "分享图片"}</Button>}
                <a href={image.url} download={image.file.name} className={`${buttonClass(image.canShare ? "secondary" : "primary")} flex-1`}>保存图片</a>
              </div>
              <p className="mb-4 mt-3 text-sm text-ink-3">
                {image.canShare ? "点击「分享图片」，在系统菜单中选择微信；若没有微信，可先保存图片再发送。" : "当前浏览器不支持直接分享图片。请保存后在微信中发送；微信内可长按下方图片，选择发送给朋友或保存图片。"}
              </p>
              {notice && <p role="status" className="mb-4 text-sm text-ink-2">{notice}</p>}
              <img src={image.url} alt={`${SITE.name}热点榜分享图片，包含当前全部 ${hot.entries.length} 个事件`} className="w-full rounded-panel" />
            </>}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
