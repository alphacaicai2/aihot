import type { HotResponse } from "@aihot/contracts/site";
import { SITE } from "@aihot/industry/site";
import { Dialog, DialogTrigger, DialogHeader, DialogTitle, DialogDescription, DialogPopup, DialogPanel } from "../../components/coss/dialog";
import { Button, buttonClass } from "../../components/ui/Controls";
import { createHotShareImage } from "./share-image";
import { sharePopupClass, useSharePreview } from "./SharePreview";

export function ShareHotButton({ hot }: { hot: HotResponse }) {
  const preview = useSharePreview();
  const { image, busy, error, sharing, notice } = preview;

  function generate() {
    return preview.load(async signal => {
      const blob = await createHotShareImage(hot, new URL("/hot", location.origin).href, signal);
      return new File([blob], `${SITE.name}-热点榜.png`, { type: "image/png" });
    });
  }

  return (
    <Dialog onOpenChange={open => open ? void generate() : preview.close()} onOpenChangeComplete={preview.afterChange}>
      <DialogTrigger render={<Button />} disabled={!hot.entries.length}>分享榜单</DialogTrigger>
      <DialogPopup className={sharePopupClass} closeProps={{ "aria-label": "关闭" }}>
        <DialogHeader>
          <DialogTitle>分享热点榜</DialogTitle>
          <DialogDescription>生成当前榜单的分享图。</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="mt-4">
            {busy && <p role="status" className="py-10 text-center text-ink-3">正在生成榜单图片…</p>}
            {error && <div className="py-6 text-center"><p role="alert" className="mb-3">图片生成失败。</p><Button onClick={generate}>重新生成</Button></div>}
            {image && !busy && <>
              <div className="mb-3 flex flex-wrap gap-2">
                {image.canShare && <Button variant="primary" onClick={preview.sendImage} disabled={!!sharing} className="flex-1">{sharing ? "正在分享…" : "分享图片"}</Button>}
                <a href={image.url} download={image.file.name} className={`${buttonClass(image.canShare ? "secondary" : "primary")} flex-1`}>保存图片</a>
              </div>
              {notice && <p role="status" className="mb-4 text-sm text-ink-2">{notice}</p>}
              <img src={image.url} alt={`${SITE.name}热点榜分享图片，包含当前全部 ${hot.entries.length} 个事件`} className="anim-fade-in w-full rounded-panel" />
            </>}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
