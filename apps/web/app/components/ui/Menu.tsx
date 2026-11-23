import { useState, type ReactNode } from "react";
import { Button } from "../coss/button";
import { Menu as CossMenu, MenuItem as CossMenuItem, MenuLinkItem, MenuPopup, MenuTrigger } from "../coss/menu";

export function Menu({ trigger, label, children, align = "right" }: { trigger: ReactNode; label: string; children: (close: () => void) => ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  return (
    <CossMenu open={open} onOpenChange={setOpen}>
      <MenuTrigger aria-label={label} title={label} render={<Button variant="ghost" size="icon" />}>
        {trigger}
      </MenuTrigger>
      <MenuPopup align={align === "right" ? "end" : "start"} className="min-w-44">
        {children(() => setOpen(false))}
      </MenuPopup>
    </CossMenu>
  );
}

export function MenuItem({ icon, children, onSelect, href, download }: { icon?: ReactNode; children: ReactNode; onSelect?: () => void; href?: string; download?: boolean }) {
  const content = <>{icon}{children}</>;
  if (href) return <MenuLinkItem href={href} download={download} onClick={onSelect}>{content}</MenuLinkItem>;
  return <CossMenuItem onClick={onSelect}>{content}</CossMenuItem>;
}
