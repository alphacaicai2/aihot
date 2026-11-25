import { useState } from "react";
import { SITE } from "@aihot/industry/site";
import { Dialog, DialogTrigger } from "../../components/coss/dialog";
import { Button } from "../../components/ui/Controls";
import { IconShare } from "../../components/icons";
import { ServerSharePanel } from "./ServerSharePanel";

export function ShareStoryButton({ publicId, title, compact = false }: { publicId: string; title: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger aria-label={compact ? `分享事件：${title}` : undefined} title={compact ? "分享事件" : undefined}
      render={<Button variant={compact ? "ghost" : "secondary"} className={compact ? "relative z-10 size-10 p-0" : "relative z-10 shrink-0"} />}>
      <IconShare size={16} />{compact ? null : "分享事件"}
    </DialogTrigger>
    <ServerSharePanel open={open} title={title} heading="分享事件" path={`/story/${publicId}`}
      src={`/og/stories/${encodeURIComponent(publicId)}.png`} filename={`${SITE.mcpPrefix}-story-${publicId}.png`} />
  </Dialog>;
}
