import { SITE } from "@aihot/industry/site";
import { Dialog } from "../../components/coss/dialog";
import { ServerSharePanel } from "../story/ServerSharePanel";

export default function PosterSheet({ id, title, open, onClose }: { id:string; title:string; open:boolean; onClose:() => void }) {
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
    {open && <ServerSharePanel title={title} heading="分享文章" path={`/items/${id}`}
      src={`/og/posters/${encodeURIComponent(id)}.png`} filename={`${SITE.mcpPrefix}-${id}.png`} />}
  </Dialog>;
}
