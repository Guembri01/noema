"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Z } from "@/lib/design-tokens";
import { cn } from "@/lib/utils";

/**
 * Tooltip — Radix-backed, but pinned to the design system.
 *
 * - Enter is a `--dur-1` (120ms) fade + 4px rise (`animate-rise`); exit is a
 *   short fade (`animate-fade`). Both come from named motion tokens, never an
 *   ad-hoc duration.
 * - First open waits {@link TOOLTIP_DELAY_MS} (500ms); re-entering another
 *   trigger within {@link TOOLTIP_SKIP_DELAY_MS} opens instantly
 *   (Radix `skipDelayDuration`), so moving across a toolbar does not flicker.
 * - Layering comes from `Z.tooltip` (inline `z-index`, never a magic value).
 * - `role="tooltip"` is declared on the surface and Radix wires the trigger's
 *   `aria-describedby` while the tooltip is open.
 *
 * `TooltipProvider` and `TooltipRoot`/`Trigger`/`Content` keep the exact export
 * names the app already imports (`layout.tsx`, `page-tree`, `sidebar-footer`,
 * `bubble-toolbar`). `Tooltip` keeps its `{ label, children, side }` API.
 */

/** First-open delay. Radix's default is 700ms; the design system uses 500. */
export const TOOLTIP_DELAY_MS = 500;

/** Window in which the next tooltip opens instantly (no re-delay, no flicker). */
export const TOOLTIP_SKIP_DELAY_MS = 300;

/** Surface chrome: token colours, the popover radius, `shadow-2`, motion tokens. */
export const TOOLTIP_CONTENT_BASE =
  "animate-rise rounded-md bg-fg px-2 py-1 text-xs font-medium text-bg shadow-2 data-[state=closed]:animate-fade";

/** `Z.tooltip` as an inline style so layering never drifts into a magic class. */
export const TOOLTIP_CONTENT_STYLE: React.CSSProperties = {
  zIndex: Z.tooltip,
};

export const TooltipRoot = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

/**
 * Provider with the design-system defaults. An explicit `delayDuration` still
 * wins (the root layout passes one), but every `Tooltip` below overrides the
 * per-root delay to {@link TOOLTIP_DELAY_MS}.
 */
export function TooltipProvider({
  delayDuration = TOOLTIP_DELAY_MS,
  skipDelayDuration = TOOLTIP_SKIP_DELAY_MS,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  );
}

/**
 * The visual surface. Split out of `TooltipContent` so it can be rendered
 * statically (SSR test) and reused through Radix's `asChild`.
 */
export function TooltipSurface({
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      {...props}
      role="tooltip"
      style={{ ...style, ...TOOLTIP_CONTENT_STYLE }}
      className={cn(TOOLTIP_CONTENT_BASE, className)}
    >
      {children}
    </div>
  );
}

export function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content sideOffset={sideOffset} {...props} asChild>
        <TooltipSurface className={className}>{children}</TooltipSurface>
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

/** Convenience wrapper: <Tooltip label="Bold"><button/></Tooltip> */
export function Tooltip({
  label,
  children,
  side = "bottom",
  sideOffset,
  className,
  delayDuration = TOOLTIP_DELAY_MS,
  ...props
}: {
  label: React.ReactNode;
  children?: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  sideOffset?: number;
  className?: string;
  delayDuration?: number;
} & Omit<
  React.ComponentProps<typeof TooltipPrimitive.Root>,
  "delayDuration" | "children"
>) {
  const text = typeof label === "string" ? label : undefined;
  const child =
    text && React.isValidElement(children) &&
    !(children as React.ReactElement<Record<string, unknown>>).props["aria-label"]
      ? React.cloneElement(
          children as React.ReactElement<{ "aria-label"?: string }>,
          { "aria-label": text },
        )
      : children;
  return (
    <TooltipRoot delayDuration={delayDuration} {...props}>
      <TooltipTrigger asChild>{child}</TooltipTrigger>
      <TooltipContent side={side} sideOffset={sideOffset} className={className}>
        {label}
      </TooltipContent>
    </TooltipRoot>
  );
}
