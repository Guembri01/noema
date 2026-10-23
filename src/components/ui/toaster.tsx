"use client";

import type { ReactNode } from "react";
import { useTheme } from "next-themes";
import { Toaster as Sonner, useSonner } from "sonner";
import { Check, Info, Loader2, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Z } from "@/lib/design-tokens";

/**
 * Notion-like toasts.
 *
 * Sonner stays the engine (it owns the timers, stacking, swipe and the enter/
 * exit animations the app already triggers through `toast.*`), but it runs
 * `unstyled` so every surface colour, radius and the action button come from
 * our tokens through {@link TOAST_BASE_CLASS} / {@link TOAST_VARIANT_CLASS}.
 *
 * Only {@link MAX_VISIBLE_TOASTS} sit in the stack at once; the rest collapse
 * behind a `+N` counter built from {@link overflowCount}.
 */

/** Toasts shown in the stack before the rest collapse behind a counter. */
export const MAX_VISIBLE_TOASTS = 3;

/** Visual variants a toast can take. `undo` is a plain toast carrying an action. */
export type ToastVariant =
  | "default"
  | "success"
  | "error"
  | "info"
  | "warning"
  | "undo";

/** Shared frame: token surface, radius, elevation and rhythm. Never raw values. */
export const TOAST_BASE_CLASS =
  "relative flex items-start gap-2 rounded-card border border-border bg-bg px-3 py-2 text-sm text-fg shadow-2";

/**
 * Variant → classes. The left edge carries the status colour so a status is
 * readable at a glance; every value resolves to a token.
 */
export const TOAST_VARIANT_CLASS: Record<ToastVariant, string> = {
  default: "border-l-2 border-l-border-strong",
  success: "border-l-2 border-l-success",
  error: "border-l-2 border-l-danger",
  info: "border-l-2 border-l-accent",
  warning: "border-l-2 border-l-warning",
  undo: "border-l-2 border-l-border-strong",
};

/** The class string for a variant; the single source the live toaster and the
 * presentational {@link ToastView} share. */
export function toastVariantClass(variant: ToastVariant): string {
  return TOAST_VARIANT_CLASS[variant];
}

/**
 * How many toasts are hidden behind the visible window (`total - max`, floored
 * at 0). Drives the `+N` overflow counter; non-finite input is treated as none.
 */
export function overflowCount(
  total: number,
  max: number = MAX_VISIBLE_TOASTS,
): number {
  const cap = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
  const count = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  return Math.max(0, count - cap);
}

/** Per-variant icons. Each status colour is a token utility class, so it is
 *  re-themeable with the rest of the palette (no inline `var(--…)` colour). */
const TOAST_ICON_CLASS = "h-4 w-4";

/**
 * The toast visual, on its own. It backs the overflow counter and is the
 * presentational contract the live toaster mirrors through `classNames`.
 */
export function ToastView({
  variant = "default",
  title,
  description,
  actionLabel,
  onAction,
  ariaLabel,
  className,
}: {
  variant?: ToastVariant;
  title: ReactNode;
  description?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div
      data-testid="toast"
      data-variant={variant}
      aria-label={ariaLabel}
      style={{ zIndex: Z.toast }}
      className={cn(TOAST_BASE_CLASS, toastVariantClass(variant), className)}
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium leading-5">{title}</p>
        {description ? (
          <p className="mt-0.5 text-xs text-muted">{description}</p>
        ) : null}
      </div>
      {actionLabel ? (
        <button
          type="button"
          onClick={onAction}
          aria-label={actionLabel}
          className="focus-ring u-interactive shrink-0 rounded-control bg-fg px-2 py-1 text-xs font-medium text-bg transition-opacity hover:opacity-90"
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

export function Toaster() {
  const { resolvedTheme } = useTheme();
  // Subscribes to Sonner's store so we know how many toasts are hidden.
  const { toasts } = useSonner();
  const overflow = overflowCount(toasts.length);
  const lifted = overflow > 0;

  return (
    <>
      <Sonner
        theme={(resolvedTheme as "light" | "dark") ?? "system"}
        position="bottom-right"
        visibleToasts={MAX_VISIBLE_TOASTS}
        gap={12}
        closeButton
        dir="auto"
        offset={{ bottom: lifted ? 64 : 24, right: 24 }}
        mobileOffset={{ bottom: lifted ? 60 : 16, right: 16 }}
        style={{ zIndex: Z.toast }}
        icons={{
          success: (
            <Check
              aria-hidden
              className={cn(TOAST_ICON_CLASS, "text-success")}
            />
          ),
          error: (
            <TriangleAlert
              aria-hidden
              className={cn(TOAST_ICON_CLASS, "text-danger")}
            />
          ),
          warning: (
            <TriangleAlert
              aria-hidden
              className={cn(TOAST_ICON_CLASS, "text-warning")}
            />
          ),
          info: (
            <Info
              aria-hidden
              className={cn(TOAST_ICON_CLASS, "text-accent")}
            />
          ),
          loading: (
            <Loader2
              aria-hidden
              className={cn(TOAST_ICON_CLASS, "animate-spin text-muted")}
            />
          ),
          close: <X aria-hidden className="h-3.5 w-3.5" />,
        }}
        toastOptions={{
          // Colour/radius/shadow come from the class map below, not Sonner's
          // stylesheet, so nothing drifts from the design tokens.
          unstyled: true,
          classNames: {
            toast: cn(
              TOAST_BASE_CLASS,
              "pointer-events-auto w-[356px] max-w-[calc(100vw_-_2rem)]",
            ),
            content: "flex min-w-0 flex-1 flex-col gap-0.5",
            title: "font-medium leading-5",
            description: "text-xs text-muted",
            icon: "relative flex h-4 w-4 shrink-0 items-center justify-center",
            actionButton:
              "shrink-0 rounded-control bg-fg px-2 py-1 text-xs font-medium text-bg transition-opacity hover:opacity-90",
            cancelButton:
              "shrink-0 rounded-control px-2 py-1 text-xs font-medium text-muted transition-colors hover:text-fg",
            closeButton:
              "absolute right-1.5 top-1.5 rounded-control p-0.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg",
            default: toastVariantClass("default"),
            success: toastVariantClass("success"),
            error: toastVariantClass("error"),
            info: toastVariantClass("info"),
            warning: toastVariantClass("warning"),
          },
        }}
      />
      {lifted ? (
        <div
          className="fixed right-4 bottom-3 sm:right-6"
          style={{ zIndex: Z.toast }}
        >
          <ToastView
            variant="info"
            title={`+${overflow}`}
            ariaLabel={`${overflow} more`}
            className="px-2 py-1 text-xs"
          />
        </div>
      ) : null}
    </>
  );
}
