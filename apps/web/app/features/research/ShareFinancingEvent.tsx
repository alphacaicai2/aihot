import { useState } from "react";
import type { FinancingResponse } from "@aihot/contracts/financing";
import { Dialog, DialogTrigger } from "../../components/coss/dialog";
import { IconShare } from "../../components/icons";
import { financingEventPath } from "../../lib/financing-navigation";
import { ShareEventPanel } from "../hot/ShareEventPanel";
import { createFinancingShareImage } from "./financing-share-image";

export function ShareFinancingEvent({ event }: { event: FinancingResponse["events"][number] }) {
  const [open, setOpen] = useState(false);
  const claim = event.reports[0]!.claim;
  const title = [claim.company, claim.round].filter(Boolean).join(" ");
  const path = financingEventPath(event.shareId);
  async function createFile(signal: AbortSignal) {
    const blob = await createFinancingShareImage(event, signal);
    return new File([blob], `${title.replace(/[/\\:*?"<>|]/g, "-")}-融资.png`, { type: "image/png" });
  }
  return <div className="flex flex-wrap items-center gap-x-3 border-t border-line-soft px-3.5 text-xs sm:px-5">
    <a href={path} className="inline-flex min-h-9 items-center text-accent hover:underline">事件链接</a>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger aria-label={`分享融资事件：${title}`} className="inline-flex min-h-9 items-center gap-1 text-ink-3 hover:text-accent"><IconShare size={14} />分享</DialogTrigger>
      <ShareEventPanel open={open} heading="分享融资事件" title={title} path={path} createFile={createFile} />
    </Dialog>
  </div>;
}
