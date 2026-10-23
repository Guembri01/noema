"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Button — the design-system action primitive.
 *
 * Public API is intentionally backwards compatible: `variant` / `size` keep the
 * values they had (`primary | secondary | ghost | danger`, `sm | md`) and every
 * `ButtonHTMLAttributes` prop still forwards to the DOM element. The additions
 * are purely options on top:
 *
 * - variants:  `primary · secondary · ghost · subtle · danger`
 * - tone:      `solid | soft` — `soft` swaps a filled variant's fill for its
 *              `*-soft` token (e.g. `danger` → `danger-soft`).
 * - sizes:     `xs · sm · md · lg` + the two square sizes `icon` (28px, aligns
 *              with `sm`) and `iconOnly` (36px, aligns with `md`).
 * - `loading`: replaces the content with a centred spinner, keeps the button's
 *              measured width by leaving the content in the layout at
 *              `visibility: hidden` (never `display: none`), sets `aria-busy`,
 *              disables the control and swallows the click so a form cannot
 *              submit twice.
 * - `leftIcon` / `rightIcon`: decorative icon slots around the label.
 * - `asChild`: renders the single child (e.g. `<Link>`) instead of a
 *              `<button>`, cloning it with the button's classes and the same
 *              loading/disabled guards (Radix-style `asChild` without pulling
 *              in `@radix-ui/react-slot`).
 *
 * Every interactive state rides the shared vocabulary: `.focus-ring` for
 * focus-visible, `.u-interactive` for hover/press (`scale(0.985)`), the
 * `disabled:` utility pair for disabled, and `aria-busy` for loading.
 */

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "subtle"
  | "danger";

export type ButtonTone = "solid" | "soft";

export type ButtonSize =
  | "xs"
  | "sm"
  | "md"
  | "lg"
  | "icon"
  | "iconOnly";

/** Layout + interaction contract shared by every variant/size. */
export const BUTTON_BASE =
  "relative inline-flex select-none items-center justify-center whitespace-nowrap rounded-control font-medium focus-ring u-interactive disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

/** Filled (`tone="solid"`) palettes. Colour always comes from a token. */
export const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-action text-action-fg hover:bg-action/90",
  secondary: "border border-border bg-bg text-fg hover:bg-surface-2",
  ghost: "bg-transparent text-fg hover:bg-surface-2",
  subtle: "bg-surface-2 text-fg hover:bg-surface-3",
  danger: "bg-danger text-danger-fg hover:bg-danger/90",
};

/** Soft (`tone="soft"`) palettes — the low-emphasis spelling of the same intent. */
export const BUTTON_SOFT_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-action-soft text-action hover:bg-action/20",
  secondary: "border border-border bg-surface text-fg hover:bg-surface-2",
  ghost: "bg-transparent text-action hover:bg-action-soft",
  subtle: "bg-surface-2 text-fg hover:bg-surface-3",
  danger: "bg-danger-soft text-danger hover:bg-danger/20",
};

/** `xs`–`lg` are text buttons; `icon`/`iconOnly` are the square sizes. */
export const BUTTON_SIZES: Record<ButtonSize, string> = {
  xs: "h-6 px-2 text-xs",
  sm: "h-8 px-3 text-sm",
  md: "h-9 px-3.5 text-sm",
  lg: "h-11 px-5 text-base",
  icon: "h-7 w-7 p-0",
  iconOnly: "h-9 w-9 p-0",
};

/** Space between icon and label, scaled with the button size. */
export const BUTTON_GAPS: Record<ButtonSize, string> = {
  xs: "gap-1",
  sm: "gap-1.5",
  md: "gap-2",
  lg: "gap-2",
  icon: "gap-0",
  iconOnly: "gap-0",
};

/** The classes for one button configuration. Pure — pinned by the node test. */
export function buttonClasses({
  variant = "primary",
  tone = "solid",
  size = "md",
  className,
}: {
  variant?: ButtonVariant;
  tone?: ButtonTone;
  size?: ButtonSize;
  className?: string;
} = {}): string {
  const palette = tone === "soft" ? BUTTON_SOFT_VARIANTS : BUTTON_VARIANTS;
  return cn(BUTTON_BASE, palette[variant], BUTTON_SIZES[size], className);
}

/**
 * Width-preservation rule for `loading`.
 *
 * The content stays mounted — hidden with `visibility: hidden` (`invisible`),
 * never `display: none` (`hidden`) — so the spinner can be centred over it
 * without the button changing width or the surrounding layout shifting.
 */
export function loadingContentClass(loading: boolean): string {
  return loading ? "invisible" : "";
}

/** Centred spinner, absolutely positioned so it adds no layout box of its own. */
export const BUTTON_SPINNER_CLASS =
  "pointer-events-none absolute inset-0 flex items-center justify-center";

/**
 * A loading button is disabled, which is what closes the double-submit hole
 * (and why the `asChild` click guard exists too). Pure — pinned by the test.
 */
export function buttonDisabled({
  disabled,
  loading,
}: {
  disabled?: boolean;
  loading?: boolean;
}): boolean {
  return Boolean(disabled) || Boolean(loading);
}

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  tone?: ButtonTone;
  size?: ButtonSize;
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  /** Render the single child element instead of a `<button>`. */
  asChild?: boolean;
}

/** Decorative icon slot — hidden from assistive tech, never allowed to shrink. */
function IconSlot({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex shrink-0" aria-hidden="true">
      {children}
    </span>
  );
}

export function Button({
  className,
  variant = "primary",
  tone = "solid",
  size = "md",
  loading = false,
  leftIcon,
  rightIcon,
  asChild = false,
  disabled,
  children,
  onClick,
  type,
  ...props
}: ButtonProps) {
  const isDisabled = buttonDisabled({ disabled, loading });
  const classes = buttonClasses({ variant, tone, size, className });

  const spinner = loading ? (
    <span className={BUTTON_SPINNER_CLASS} aria-hidden="true">
      <Loader2 className="h-4 w-4 animate-spin" />
    </span>
  ) : null;

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    // A `disabled` button does not fire clicks, but an `asChild` anchor does —
    // the guard is what makes "no double submit" hold for both shapes.
    if (isDisabled) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };

  if (asChild && React.isValidElement(children)) {
    const child = children as React.ReactElement<Record<string, unknown>>;
    const childOnClick = child.props.onClick as
      | ((event: React.MouseEvent<HTMLElement>) => void)
      | undefined;
    return React.cloneElement(
      child,
      {
        className: cn(classes, child.props.className as string | undefined),
        "aria-busy": loading || undefined,
        "aria-disabled": isDisabled || undefined,
        "data-disabled": isDisabled ? "" : undefined,
        "data-loading": loading ? "" : undefined,
        onClick: (event: React.MouseEvent<HTMLElement>) => {
          if (isDisabled) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          childOnClick?.(event);
        },
      } as Record<string, unknown>,
      <>
        {spinner}
        <span
          className={cn(
            "inline-flex items-center justify-center",
            BUTTON_GAPS[size],
            loadingContentClass(loading),
          )}
        >
          {leftIcon ? <IconSlot>{leftIcon}</IconSlot> : null}
          {child.props.children as React.ReactNode}
          {rightIcon ? <IconSlot>{rightIcon}</IconSlot> : null}
        </span>
      </>,
    );
  }

  return (
    <button
      {...props}
      type={type}
      className={classes}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      data-loading={loading ? "" : undefined}
      onClick={handleClick}
    >
      {spinner}
      <span
        className={cn(
          "inline-flex items-center justify-center",
          BUTTON_GAPS[size],
          loadingContentClass(loading),
        )}
      >
        {leftIcon ? <IconSlot>{leftIcon}</IconSlot> : null}
        {children}
        {rightIcon ? <IconSlot>{rightIcon}</IconSlot> : null}
      </span>
    </button>
  );
}
