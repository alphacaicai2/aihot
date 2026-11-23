// Shared admin building blocks: page frame, cards, stats, badges, tables, buttons, fields and a
// reason dialog (manual changes always carry a reason for the audit log).
import { cloneElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { Badge as CossBadge } from "../../components/coss/badge";
import { Button as CossButton } from "../../components/coss/button";
import { Card as CossCard, CardAction, CardHeader, CardPanel, CardTitle } from "../../components/coss/card";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../../components/coss/dialog";
import { Input as CossInput } from "../../components/coss/input";
import { Textarea as CossTextarea } from "../../components/coss/textarea";
import { ago, bj } from "./format";

export function AdminPage({ title, subtitle, actions, children }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1320px] px-4 pb-24 pt-6 sm:px-6 lg:px-8 lg:pt-8">
      <header className="mb-6 flex flex-col gap-3 border-b border-line pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-[28px]">{title}</h1>
          {subtitle && <p className="mt-1 text-[13.5px] leading-relaxed text-ink-3">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

export function Card({ title, right, children, className = "", pad = true }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <CossCard render={<section />} className={`min-w-0 border-line ${className}`}>
      {(title || right) && (
        <CardHeader className="items-center border-b border-line px-4 py-3">
          {title && <CardTitle render={<h2 />} className="text-sm leading-snug">{title}</CardTitle>}
          {right && <CardAction className="flex-wrap items-center gap-2 text-xs text-ink-3">{right}</CardAction>}
        </CardHeader>
      )}
      <CardPanel className={pad ? "min-w-0 p-4" : "min-w-0 p-0"}>{children}</CardPanel>
    </CossCard>
  );
}

export function Stat({ label, value, hint, tone }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: "ok" | "warn" | "bad" }) {
  const color = tone === "bad" ? "text-hot" : tone === "warn" ? "text-amber" : tone === "ok" ? "text-ok" : "text-ink";
  return (
    <CossCard className="min-w-0 border-line px-4 py-3.5">
      <div className="text-[12.5px] text-ink-3">{label}</div>
      <div className={`num mt-1 text-[22px] font-semibold tracking-tight ${color}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[12px] text-ink-4">{hint}</div>}
    </CossCard>
  );
}

type Tone = "ok" | "warn" | "bad" | "muted" | "accent" | "info";
const BADGE_VARIANT = {
  ok: "success", warn: "warning", bad: "error", muted: "secondary", accent: "info", info: "outline",
} as const;

export function Badge({ tone = "muted", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return <CossBadge variant={BADGE_VARIANT[tone]} title={title}>{children}</CossBadge>;
}

export function Dot({ tone }: { tone: Tone }) {
  const c = tone === "ok" ? "bg-ok" : tone === "warn" ? "bg-amber" : tone === "bad" ? "bg-hot" : tone === "accent" ? "bg-accent" : "bg-ink-4";
  return (
    <span className="relative inline-flex size-2">
      {tone === "bad" && <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-50 ${c}`} />}
      <span className={`relative inline-flex size-2 rounded-full ${c}`} />
    </span>
  );
}

export function healthTone(h: string | null | undefined): Tone {
  return h === "ok" ? "ok" : h === "degraded" ? "warn" : h === "failing" ? "bad" : "muted";
}

export function Time({ at, title }: { at: string | null | undefined; title?: string }) {
  if (!at) return <span className="text-ink-4">—</span>;
  return (
    <time dateTime={String(at)} title={title ?? bj(at, true)} className="num whitespace-nowrap" suppressHydrationWarning>
      {ago(at)}
    </time>
  );
}

export interface Column<T> {
  key: string;
  label: ReactNode;
  render: (row: T) => ReactNode;
  className?: string;
  align?: "right";
}

export function DataTable<T>({ rows, columns, rowKey, empty = "暂无数据", onRowClick, dense }: { rows: T[]; columns: Column<T>[]; rowKey: (r: T) => string | number; empty?: ReactNode; onRowClick?: (r: T) => void; dense?: boolean }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-line text-[12px] text-ink-3">
            {columns.map((c) => (
              <th key={c.key} className={`whitespace-nowrap px-3 py-2 font-medium ${c.align === "right" ? "text-right" : ""} ${c.className ?? ""}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={rowKey(r)}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              className={`border-b border-line/70 last:border-0 ${onRowClick ? "cursor-pointer transition-colors hover:bg-bg-sunk/60" : ""}`}
            >
              {columns.map((c) => (
                <td key={c.key} className={`${dense ? "py-1.5" : "py-2.5"} px-3 align-top text-ink-2 ${c.align === "right" ? "num text-right" : ""} ${c.className ?? ""}`}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-[13px] text-ink-4">{children}</div>;
}

type ButtonTone = "primary" | "secondary" | "danger" | "ghost";
const BUTTON_VARIANT = {
  primary: "default", secondary: "outline", danger: "destructive", ghost: "ghost",
} as const;

export function Button({ tone = "secondary", size = "md", busy, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: ButtonTone; size?: "sm" | "md"; busy?: boolean }) {
  return <CossButton {...props} variant={BUTTON_VARIANT[tone]} size={size === "sm" ? "sm" : "default"} loading={busy} />;
}

export function ButtonLink({ to, children, tone = "secondary", size = "md" }: { to: string; children: ReactNode; tone?: ButtonTone; size?: "sm" | "md" }) {
  return <CossButton render={<Link to={to} />} variant={BUTTON_VARIANT[tone]} size={size === "sm" ? "sm" : "default"}>{children}</CossButton>;
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactElement<{ id?: string; "aria-describedby"?: string }> }) {
  const fieldId = useId();
  const id = children.props.id ?? fieldId;
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block text-[12.5px] font-medium text-ink-2">{label}</label>
      {cloneElement(children, { id, "aria-describedby": [children.props["aria-describedby"], hintId].filter(Boolean).join(" ") || undefined })}
      {hint && <p id={hintId} className="mt-1 text-[12px] text-ink-4">{hint}</p>}
    </div>
  );
}

export function Input(props: React.ComponentProps<"input">) {
  return <CossInput nativeInput {...props} />;
}

export function Textarea(props: React.ComponentProps<"textarea">) {
  return <CossTextarea {...props} />;
}

export function Select({ children, ...props }: React.ComponentProps<"select">) {
  return (
    <select {...props} className={`w-full min-w-0 rounded-lg border border-input bg-background px-3 py-1.5 text-foreground text-base shadow-xs/5 outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/24 sm:text-sm appearance-none bg-[length:12px] bg-[right_10px_center] bg-no-repeat pr-8 ${props.className ?? ""}`} style={{ backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path d='M3 4.5l3 3 3-3' fill='none' stroke='%2366757a' stroke-width='1.4'/></svg>\")" }}>
      {children}
    </select>
  );
}

/** Link-based filter chips bound to one query parameter. */
export function FilterChips({ param, options }: { param: string; options: Array<{ value: string; label: ReactNode; count?: number }> }) {
  const [sp] = useSearchParams();
  const current = sp.get(param) ?? "";
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const next = new URLSearchParams(sp);
        if (o.value) next.set(param, o.value);
        else next.delete(param);
        next.delete("page");
        const active = current === o.value;
        return (
          <CossButton
            key={o.value || "all"}
            render={<Link to={`?${next}`} preventScrollReset aria-current={active ? "true" : undefined} />}
            variant={active ? "secondary" : "ghost"}
            size="sm"
          >
            {o.label}
            {o.count !== undefined && <span className="num text-xs text-ink-3">{o.count}</span>}
          </CossButton>
        );
      })}
    </div>
  );
}

export function Pager({ page, hasMore }: { page: number; hasMore: boolean }) {
  const [sp] = useSearchParams();
  const to = (p: number) => {
    const next = new URLSearchParams(sp);
    if (p > 1) next.set("page", String(p));
    else next.delete("page");
    return `?${next}`;
  };
  if (page <= 1 && !hasMore) return null;
  return (
    <div className="mt-4 flex items-center justify-center gap-2 text-[13px]">
      {page > 1 && <ButtonLink to={to(page - 1)} size="sm">上一页</ButtonLink>}
      <span className="num px-2 text-ink-3">第 {page} 页</span>
      {hasMore && <ButtonLink to={to(page + 1)} size="sm">下一页</ButtonLink>}
    </div>
  );
}

export function Json({ value, collapsed = true, label = "原始数据" }: { value: unknown; collapsed?: boolean; label?: string }) {
  const [open, setOpen] = useState(!collapsed);
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="group rounded-control bg-bg-sunk/70 ring-1 ring-line">
      <summary className="cursor-pointer select-none px-3 py-1.5 text-[12px] text-ink-3 hover:text-ink-2">{label}</summary>
      {open && <pre className="max-h-[420px] overflow-auto px-3 pb-3 font-mono text-[11.5px] leading-relaxed text-ink-2">{JSON.stringify(value, null, 2)}</pre>}
    </details>
  );
}

/**
 * A modal that collects a reason (and optional extra fields) before a manual change. The submit
 * handler receives the reason; returning true closes the dialog.
 */
export function ReasonDialog({
  open,
  title,
  description,
  confirmLabel = "确认",
  danger,
  requireReason = true,
  children,
  onClose,
  onSubmit,
  busy,
}: {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  requireReason?: boolean;
  children?: ReactNode;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<boolean | void> | boolean | void;
  busy?: boolean;
}) {
  const [reason, setReason] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (open) setReason("");
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogPopup initialFocus={ref} showCloseButton={false}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy || (requireReason && !reason.trim())) return;
            const closed = await onSubmit(reason.trim());
            if (closed !== false) onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription render={<div />}>{description}</DialogDescription>}
          </DialogHeader>
          <DialogPanel>
            {children && <div className="mb-4 space-y-3">{children}</div>}
            <Field label={requireReason ? "原因（写进审计记录）" : "备注（可选）"}>
              <Textarea ref={ref} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={requireReason ? "为什么做这个改动" : ""} rows={2} />
            </Field>
          </DialogPanel>
          <DialogFooter>
            <Button tone="ghost" onClick={onClose}>取消</Button>
            <Button type="submit" tone={danger ? "danger" : "primary"} busy={busy} disabled={requireReason && !reason.trim()}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export function KV({ items }: { items: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[13px]">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-ink-3">{k}</dt>
          <dd className="min-w-0 break-words text-ink-2">{v ?? <span className="text-ink-4">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}
