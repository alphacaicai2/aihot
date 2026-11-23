import type { ButtonHTMLAttributes, Ref, SelectHTMLAttributes } from "react";
import { Button as CossButton, buttonVariants } from "../coss/button";
import { IconChevronDown } from "../icons";

const variants = { primary: "default", secondary: "outline", ghost: "ghost", danger: "destructive" } as const;
const sizes = { sm: "sm", md: "default", lg: "xl" } as const;
type Variant = keyof typeof variants;
type Size = keyof typeof sizes;

/** Used by links and form submit buttons that share the site's button styles. */
export function buttonClass(variant: Variant = "secondary", size: Size = "md") {
  return buttonVariants({ variant: variants[variant], size: sizes[size] });
}

export function Button({
  variant = "secondary", size = "md", ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; ref?: Ref<HTMLButtonElement> }) {
  return <CossButton variant={variants[variant]} size={sizes[size]} {...props} />;
}

export function Select({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={`relative inline-flex ${className}`}>
      <select
        className="h-8 w-full cursor-pointer appearance-none rounded-lg border border-input bg-background py-0 pl-3 pr-8 text-[13px] text-foreground shadow-xs/5 outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
        {...rest}
      >
        {children}
      </select>
      <IconChevronDown size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
    </span>
  );
}
