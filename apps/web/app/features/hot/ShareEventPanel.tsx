import { useEffectEvent, useLayoutEffect } from "react";
import { DialogHeader, DialogTitle, DialogDescription, DialogPopup, DialogPanel } from "../../components/coss/dialog";
import { Button, buttonClass } from "../../components/ui/Controls";
import { shareLink } from "../../lib/share-link";
import { sharePopupClass, useSharePreview } from "./SharePreview";

interface Props {
  open: boolean;
  heading: string;
  title: string;
  path: string;
  createFile: (signal: AbortSignal, retry: boolean) => Promise<File>;
}

// The portal mounts the body when opened and keeps it through the exit transition.
function ShareBody({ open, title, path, createFile }: Props) {
  const preview = useSharePreview();
  const { image, busy, error, sharing, notice, manualUrl } = preview;
  const generate = (retry: boolean) => preview.load(signal => createFile(signal, retry));
  const onChange = useEffectEvent(() => {
    if (open) void generate(false);
    else preview.close();
  });
  useLayoutEffect(() => { onChange(); }, [open, path]);
  function sendLink() {
    const url = new URL(path, location.origin).href;
    return preview.sendLink(url, () => shareLink(title, url));
  }

  return <DialogPanel>
    <div className="mt-3 flex flex-wrap gap-2">
      <Button onClick={sendLink} disabled={!!sharing}>分享链接</Button>
      {image && !busy && <>
        {image.canShare && <Button variant="primary" onClick={preview.sendImage} disabled={!!sharing}>{sharing === "image" ? "正在分享…" : "分享图片"}</Button>}
        <a href={image.url} download={image.file.name} className={buttonClass(image.canShare ? "secondary" : "primary")}>保存图片</a>
      </>}
    </div>
    {notice && <p role="status" className="mt-3 text-sm text-ink-2">{notice}</p>}
    {manualUrl && <input aria-label="分享链接地址" readOnly value={manualUrl} onFocus={e => e.target.select()} className="mt-2 w-full rounded border border-line bg-surface p-2 text-sm" />}
    <div className="mt-4">
      {error ? <div className="py-6 text-center"><p role="alert" className="mb-3">图片暂时不可用，仍可分享链接。</p><Button onClick={() => generate(true)}>重试</Button></div> :
        busy || !image ? <p role="status" className="py-10 text-center text-ink-3">正在准备分享图…</p> :
        <img src={image.url} alt={title + " · 分享图片"} className="anim-fade-in w-full rounded-panel" />}
    </div>
  </DialogPanel>;
}

export function ShareEventPanel(props: Props) {
  return <DialogPopup className={sharePopupClass} closeProps={{ "aria-label": "关闭" }}>
    <DialogHeader><DialogTitle>{props.heading}</DialogTitle><DialogDescription>{props.title}</DialogDescription></DialogHeader>
    <ShareBody {...props} />
  </DialogPopup>;
}
