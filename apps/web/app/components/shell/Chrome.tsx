import { useEffect, useState } from "react";
import { Presence } from "../ui/Presence";
import { Button } from "../coss/button";
import { IconArrowUp } from "../icons";

/** A thin accent line while a navigation is in flight (shown only if it takes a moment). */
export function NavigationProgress({ active }: { active: boolean }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), 150);
    return () => clearTimeout(timer);
  }, [active]);
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-[2px] overflow-hidden" aria-hidden="true">
      <Presence show={visible} kind="fade">
        <div className="h-full"><div className="nav-progress" /></div>
      </Presence>
    </div>
  );
}

/** Round "back to top" button once the reader has scrolled a screen or so. */
export function BackToTop() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const onScroll = () => setShown(window.scrollY > window.innerHeight * 1.2);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <Button
      variant="outline"
      size="icon-lg"
      tabIndex={shown ? 0 : -1}
      aria-hidden={!shown}
      aria-label="回到顶部"
      onClick={() => {
        document.getElementById("main")?.focus({ preventScroll: true });
        window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      }}
      className={`fixed bottom-[calc(70px+env(safe-area-inset-bottom))] right-4 z-30 size-11 bg-surface text-ink-2 shadow-[var(--shadow-soft)] transition-[opacity,translate] duration-(--motion-standard) ease-out-quart hover:text-ink lg:bottom-6 lg:right-6 ${
        shown ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0"
      }`}
    >
      <IconArrowUp size={18} />
    </Button>
  );
}
