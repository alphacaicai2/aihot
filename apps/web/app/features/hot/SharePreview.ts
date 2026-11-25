import { useEffect, useRef, useState } from "react";
import { canShareImage, shareImage } from "./share-file";

type Image = { url: string; file: File; canShare: boolean };
type LinkResult = "shared" | "copied" | "cancelled" | "manual";

export const sharePopupClass = "h-[min(76dvh,40rem)]";

export function useSharePreview() {
  const session = useRef<AbortController | null>(null);
  const [image, setImage] = useState<Image | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [sharing, setSharing] = useState<"image" | "link" | null>(null);
  const [notice, setNotice] = useState("");
  const [manualUrl, setManualUrl] = useState("");

  useEffect(() => () => session.current?.abort(), []);
  useEffect(() => () => { if (image) URL.revokeObjectURL(image.url); }, [image]);

  function close() {
    session.current?.abort();
    session.current = null;
  }

  // Keep the content mounted through the popup's exit. A quick reopen starts a new session.
  function afterChange(open: boolean) {
    if (!open && !session.current) setImage(null);
  }

  async function load(createFile: (signal: AbortSignal) => Promise<File>) {
    if (!session.current) setImage(null);
    close();
    const controller = new AbortController();
    session.current = controller;
    setBusy(true);
    setError(false);
    setSharing(null);
    setNotice("");
    setManualUrl("");
    try {
      const file = await createFile(controller.signal);
      if (!controller.signal.aborted) {
        setImage({ url: URL.createObjectURL(file), file, canShare: canShareImage(file, navigator) });
      }
    } catch {
      if (!controller.signal.aborted) {
        setError(true);
        setImage(null);
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function sendImage() {
    const active = session.current;
    if (!active || !image || busy || sharing) return;
    setNotice("");
    setSharing("image");
    const result = await shareImage(image.file, navigator);
    if (active.signal.aborted) return;
    setSharing(null);
    if (result === "shared") setNotice("已打开系统分享");
    if (result === "failed" || result === "unsupported") setNotice("图片分享未完成，可保存后发送");
  }

  async function sendLink(url: string, send: () => Promise<LinkResult>) {
    const active = session.current;
    if (!active || sharing) return;
    setSharing("link");
    setNotice("");
    setManualUrl("");
    const result = await send().catch(() => "manual" as const);
    if (active.signal.aborted) return;
    setSharing(null);
    if (result === "shared") setNotice("已打开系统分享");
    if (result === "copied") setNotice("已复制链接");
    if (result === "manual") {
      setNotice("复制失败，请选中下方链接复制");
      setManualUrl(url);
    }
  }

  return { image, busy, error, sharing, notice, manualUrl, close, afterChange, load, sendImage, sendLink };
}
