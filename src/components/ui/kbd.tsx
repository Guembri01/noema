import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Kbd — a keyboard-key hint, e.g. the shortcut chip in the sidebar.
 *
 * Backwards compatible: `<Kbd>Ctrl K</Kbd>` (the existing call sites) keeps
 * working. A string child is split on whitespace into a *key group* — "Ctrl K"
 * renders as two keycaps joined by a gap — and an explicit `keys` array can be
 * passed instead. Non-string children render as a single key.
 *
 * Sizes are the micro scale (`xs · sm · md`); every size uses `text-xs` (the
 * only micro type size in the design system) so no size is invented.
 */

export type KbdSize = "xs" | "sm" | "md";

export const KBD_BASE =
  "inline-flex items-center justify-center rounded-xs border border-border bg-surface font-sans font-medium text-muted";

export const KBD_SIZES: Record<KbdSize, string> = {
  xs: "h-4 min-w-4 px-1 text-xs",
  sm: "h-5 min-w-5 px-1 text-xs",
  md: "h-6 min-w-6 px-1.5 text-xs",
};

/** Classes for one keycap. Pure — pinned by the node test. */
export function kbdClasses({
  size = "sm",
  className,
}: {
  size?: KbdSize;
  className?: string;
} = {}): string {
  return cn(KBD_BASE, KBD_SIZES[size], className);
}

/**
 * Split a shortcut string into keycaps. "Ctrl Shift K" → ["Ctrl","Shift","K"].
 * A string with no whitespace is already a single key.
 */
export function kbdKeys(
  children: React.ReactNode,
  keys?: ReadonlyArray<string | number>,
): Array<string | number> {
  if (keys && keys.length > 0) return [...keys];
  if (typeof children === "string") {
    const parts = children.trim().split(/\s+/).filter(Boolean);
    if (parts.length > 0) return parts;
  }
  return [];
}

export interface KbdProps {
  children?: React.ReactNode;
  className?: string;
  size?: KbdSize;
  /** Explicit key group, e.g. `keys={["Ctrl", "K"]}`. */
  keys?: ReadonlyArray<string | number>;
}

export function Kbd({
  children,
  className,
  size = "sm",
  keys,
}: KbdProps) {
  const caps = kbdKeys(children, keys);

  // Multiple keys → a group of keycaps. A single key (or arbitrary non-string
  // children) stays a single <kbd> so the existing markup shape is preserved.
  if (caps.length > 1) {
    return (
      <span
        className="inline-flex items-center gap-1"
        data-slot="kbd-group"
        role="group"
      >
        {caps.map((key, index) => (
          <kbd key={`${key}-${index}`} className={kbdClasses({ size, className })}>
            {key}
          </kbd>
        ))}
      </span>
    );
  }

  return (
    <kbd className={kbdClasses({ size, className })}>
      {caps.length === 1 ? caps[0] : children}
    </kbd>
  );
}
