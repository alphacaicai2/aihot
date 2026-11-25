import { ShareEventPanel } from "../hot/ShareEventPanel";

export function ServerSharePanel({ open, title, heading, path, src, filename }: {
  open: boolean; title: string; heading: string; path: string; src: string; filename: string;
}) {
  async function createFile(signal: AbortSignal, retry: boolean) {
    const response = await fetch(src, { signal, cache: retry ? "reload" : "default" });
    if (!response.ok || !response.headers.get("content-type")?.startsWith("image/png")) throw new Error("share image unavailable");
    return new File([await response.blob()], filename, { type: "image/png" });
  }
  return <ShareEventPanel key={src} open={open} title={title} heading={heading} path={path} createFile={createFile} />;
}
