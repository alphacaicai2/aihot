// Let CSS reverse an in-flight transition from the current frame. Keep the last committed
// content until the exit finishes, including when its caller has already cleared the data.
import { cloneElement, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode, type RefObject } from "react";

type Kind = "fade" | "popup" | "notice" | "collapse";
type Child = ReactElement<{
  ref?: RefObject<HTMLElement | null>;
  inert?: boolean;
  "data-presence"?: Kind;
  "data-leaving"?: boolean;
  "data-initial"?: boolean;
}>;

export function Presence({ show, kind, children }: { show: boolean; kind: Kind; children: Child }) {
  const [retained, setRetained] = useState(show);
  const initial = useRef(show);
  const last = useRef(children);
  const ownRef = useRef<HTMLElement>(null);
  const child = show ? children : last.current;
  const ref = child.props.ref ?? ownRef;

  useLayoutEffect(() => {
    if (show) last.current = children;
  }, [show, children]);

  useLayoutEffect(() => {
    if (show) {
      setRetained(true);
      return;
    }
    initial.current = false;
    const node = ref.current;
    if (!node) return;
    const transitions = node.getAnimations?.() ?? [];
    if (!transitions.length || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setRetained(false);
      return;
    }
    let closing = true;
    void Promise.allSettled(transitions.map(t => t.finished)).then(() => {
      if (closing) setRetained(false);
    });
    return () => { closing = false; };
  }, [show, ref]);

  if (!show && !retained) return null;
  return cloneElement(child, {
    ref, "data-presence": kind, "data-leaving": !show || undefined,
    "data-initial": initial.current || undefined, inert: !show || child.props.inert,
  });
}

export function Collapse({ open, children, className = "" }: { open: boolean; children: ReactNode; className?: string }) {
  return (
    <Presence show={open} kind="collapse">
      <div className={`grid ${className}`}>
        <div className="min-h-0 overflow-hidden">{children}</div>
      </div>
    </Presence>
  );
}
