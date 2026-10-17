"use client";

/**
 * Sheet — a side drawer / peek panel.
 *
 * Design-system contract (docs/DESIGN_SYSTEM.md):
 *  - colour from tokens only: scrim `--overlay`, surface `.surface-raised-strong`
 *    (`--shadow-3` + `--radius-xl`) — never a raw hex;
 *  - motion from tokens only: enter/exit ride `--dur-3` (== `DUR.slow`) and
 *    `--ease-smooth`; the right drawer uses the named `animate-slide-in-right`
 *    utility, the bottom drawer the `rise` keyframe re-timed to `--dur-3`, the
 *    left drawer mirrors the right settle with the same token transition;
 *  - layering from `Z.*` only: scrim `Z.overlay`, panel `Z.modal`;
 *  - body scroll is locked while the sheet is open (shared counter so nested
 *    overlays unlock exactly once) and restored on close;
 *  - focus is trapped inside the panel (`@/lib/focus-trap` kernel, wrapping at
 *    the ends) and returned to the invoking control on close.
 */

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { DUR, Z } from "@/lib/design-tokens";
import {
  focusableSelector,
  resolveReturnTarget,
  trapPlan,
  type Focusable,
  type FocusPlan,
} from "@/lib/focus-trap";

export const SHEET_SIDES = ["left", "right", "bottom"] as const;
export const SHEET_SIZES = ["sm", "md", "lg", "full"] as const;

export type SheetSide = (typeof SHEET_SIDES)[number];
export type SheetSize = (typeof SHEET_SIZES)[number];

/**
 * Size → class map. A side sheet's `size` is its *width*, a bottom sheet's is
 * its *height*; `full` fills the viewport minus the 8 px floating gap. Pure and
 * total so `sheetSizeClass` can never return `undefined`.
 */
export const SHEET_SIZE_CLASS: Record<SheetSide, Record<SheetSize, string>> = {
  left: {
    sm: "w-80",
    md: "w-96",
    lg: "w-[480px]",
    full: "w-[calc(100vw-1rem)]",
  },
  right: {
    sm: "w-80",
    md: "w-96",
    lg: "w-[480px]",
    full: "w-[calc(100vw-1rem)]",
  },
  bottom: {
    sm: "h-72",
    md: "h-96",
    lg: "h-[560px]",
    full: "h-[calc(100vh-1rem)]",
  },
};

/** The width/height utility for a `(side, size)` pair. */
export function sheetSizeClass(side: SheetSide, size: SheetSize): string {
  return SHEET_SIZE_CLASS[side][size];
}

/** Where the floating panel sits (8 px inset, so `.surface-raised-strong` rounds cleanly). */
const SHEET_SIDE_LAYOUT: Record<SheetSide, string> = {
  left: "top-2 bottom-2 left-2",
  right: "top-2 bottom-2 right-2",
  bottom: "left-2 right-2 bottom-2",
};

export function sheetSideLayoutClass(side: SheetSide): string {
  return SHEET_SIDE_LAYOUT[side];
}

/** The off-screen transform the panel animates from (and back to on exit). */
export function sheetClosedTransform(side: SheetSide): string {
  switch (side) {
    case "left":
      return "translateX(calc(-100% - 0.5rem))";
    case "right":
      return "translateX(calc(100% + 0.5rem))";
    case "bottom":
      return "translateY(calc(100% + 0.5rem))";
  }
}

/** Token-only motion string used for the enter/exit transition. */
const SHEET_MOTION =
  "transform var(--dur-3) var(--ease-smooth), opacity var(--dur-3) var(--ease-smooth)";

/**
 * The enter class that owns the panel's transform while it opens. `right` uses
 * the design-system's named drawer animation; `bottom` and `left` leave the
 * transform to {@link sheetPanelStyle} (the system ships no left/bottom keyframe
 * and the shared stylesheet is out of this change's scope).
 */
export function sheetEnterClass(side: SheetSide, entered: boolean): string {
  return entered && side === "right" ? "animate-slide-in-right" : "";
}

/**
 * Inline motion style for the panel. Enter is a named animation where one
 * exists; exit always mirrors it with the `--dur-3` token transition, so a
 * closing sheet slides back the way it came. `zIndex` is always `Z.modal`.
 */
export function sheetPanelStyle(
  side: SheetSide,
  entered: boolean,
): React.CSSProperties {
  if (entered) {
    if (side === "right") {
      // `animate-slide-in-right` (see sheetEnterClass) owns the transform.
      return { zIndex: Z.modal };
    }
    if (side === "bottom") {
      return {
        zIndex: Z.modal,
        animation: "rise var(--dur-3) var(--ease-smooth) both",
      };
    }
    return {
      zIndex: Z.modal,
      transform: "translate(0, 0)",
      opacity: 1,
      transition: SHEET_MOTION,
    };
  }
  return {
    zIndex: Z.modal,
    transform: sheetClosedTransform(side),
    opacity: 0,
    transition: SHEET_MOTION,
  };
}

/* ------------------------------------------------------------------------- *
 * Body-scroll lock
 *
 * A module counter so several overlays may be open at once and the body only
 * unlocks when the last one closes. The scrollbar-width padding compensates the
 * removed scrollbar, so the page behind does not shift sideways.
 * ------------------------------------------------------------------------- */

let lockCount = 0;
let savedOverflow = "";
let savedPaddingRight = "";

function lockBodyScroll(): void {
  if (typeof document === "undefined") return;
  if (lockCount === 0) {
    savedOverflow = document.body.style.overflow;
    savedPaddingRight = document.body.style.paddingRight;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (gap > 0) document.body.style.paddingRight = `${gap}px`;
  }
  lockCount += 1;
}

function unlockBodyScroll(): void {
  if (typeof document === "undefined") return;
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0) {
    document.body.style.overflow = savedOverflow;
    document.body.style.paddingRight = savedPaddingRight;
  }
}

/**
 * Tab / Shift+Tab plan for the sheet, delegated to the shared
 * `@/lib/focus-trap` kernel. `activeId` is the focused stop's id (`null` when
 * focus is outside the ring, which enters at the first stop — the last on
 * Shift+Tab). `null` means "nothing to trap".
 */
export function planSheetTab(
  stops: readonly Focusable[],
  { activeId = null, shift = false }: { activeId?: string | null; shift?: boolean } = {},
): FocusPlan | null {
  return trapPlan(stops, {
    initial: activeId === null ? null : { id: activeId },
    shift,
  });
}

/** The panel's real tabbable elements, tagged with their index as the id. */
function sheetStops(root: HTMLElement): {
  stops: Focusable[];
  nodes: HTMLElement[];
} {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(focusableSelector));
  const stops = nodes.map((element, index) => ({
    id: String(index),
    disabled:
      element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled") === "true",
    hidden: element.hidden || element.getAttribute("aria-hidden") === "true",
    tabIndex: element.tabIndex,
  }));
  return { stops, nodes };
}

export type SheetProps = Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "title"
> & {
  /** Controlled open state. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which edge the panel slides in from. Defaults to `right`. */
  side?: SheetSide;
  /** Panel width (side sheets) or height (bottom sheets). Defaults to `md`. */
  size?: SheetSize;
  /** Header title. Wires `aria-labelledby`. */
  title?: React.ReactNode;
  /** Optional header subtitle. Wires `aria-describedby`. */
  description?: React.ReactNode;
  /** Header right-hand actions (icon buttons, menus). */
  actions?: React.ReactNode;
  /** Sticky footer content (primary/secondary actions). */
  footer?: React.ReactNode;
  /** Accessible name for the close control and the scrim. Defaults to "Close". */
  closeLabel?: string;
  /** Click the scrim to dismiss. Defaults to true. */
  closeOnScrimClick?: boolean;
  /** Escape dismisses. Defaults to true. */
  closeOnEscape?: boolean;
  /** Render the header close button. Defaults to true. */
  showClose?: boolean;
  /** Extra classes for the scrollable body. */
  bodyClassName?: string;
  /** Override the generated panel id (used by tests / label wiring). */
  panelId?: string;
};

/**
 * Side drawer with a header (title + actions), a scrollable `.scrollbar-thin`
 * body and a sticky footer. Dismisses on Escape and scrim click, traps and
 * restores focus, and locks the body scroll behind it.
 */
export function Sheet({
  open,
  onOpenChange,
  side = "right",
  size = "md",
  title,
  description,
  actions,
  footer,
  children,
  closeLabel = "Close",
  closeOnScrimClick = true,
  closeOnEscape = true,
  showClose = true,
  className,
  bodyClassName,
  style,
  panelId,
  ...rest
}: SheetProps) {
  const reactId = React.useId();
  const id = panelId ?? `sheet-${reactId}`;
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;

  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const invokerRef = React.useRef<HTMLElement | null>(null);

  // Keep the panel mounted through the exit animation.
  const [mounted, setMounted] = React.useState(open);
  const [entered, setEntered] = React.useState(open);

  React.useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(raf);
    }
    setEntered(false);
    const timer = setTimeout(() => setMounted(false), DUR.slow);
    return () => clearTimeout(timer);
  }, [open]);

  // Lock scroll, record the invoker, move focus in; restore everything on close.
  React.useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) {
      invokerRef.current = active;
    }
    lockBodyScroll();
    const raf = requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(focusableSelector);
      (first ?? panelRef.current)?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      unlockBodyScroll();
      const invoker = invokerRef.current;
      invokerRef.current = null;
      const target = resolveReturnTarget({
        invoker: invoker
          ? { id: "sheet-invoker", connected: invoker.isConnected }
          : null,
      });
      if (target) invoker?.focus();
    };
  }, [open]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (closeOnEscape && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
      return;
    }
    if (event.key !== "Tab") return;
    const root = panelRef.current;
    if (!root) return;
    const { stops, nodes } = sheetStops(root);
    const active = document.activeElement;
    const activeIndex = active instanceof HTMLElement ? nodes.indexOf(active) : -1;
    const plan = planSheetTab(stops, {
      activeId: activeIndex >= 0 ? String(activeIndex) : null,
      shift: event.shiftKey,
    });
    if (!plan) return;
    const target = nodes[Number(plan.target.id)];
    if (!target) return;
    event.preventDefault();
    target.focus();
  };

  if (!mounted) return null;

  const hasHeader = Boolean(title || description || actions || showClose);

  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-label={closeLabel}
        data-sheet-scrim=""
        onClick={() => {
          if (closeOnScrimClick) onOpenChange(false);
        }}
        className="fixed inset-0 u-colors"
        style={{
          zIndex: Z.overlay,
          background: "var(--overlay)",
          opacity: entered ? 1 : 0,
          transition: "opacity var(--dur-3) var(--ease-smooth)",
        }}
      />
      <div
        {...rest}
        ref={panelRef}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={hasHeader && title ? titleId : undefined}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        data-side={side}
        data-size={size}
        data-state={entered ? "open" : "closed"}
        onKeyDown={onKeyDown}
        className={cn(
          "surface-raised-strong fixed flex flex-col overflow-hidden outline-none",
          sheetSideLayoutClass(side),
          sheetSizeClass(side, size),
          sheetEnterClass(side, entered),
          "focus-ring",
          className,
        )}
        style={{ ...sheetPanelStyle(side, entered), ...style }}
      >
        {hasHeader ? (
          <header className="flex shrink-0 items-start gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0 flex-1">
              {title ? (
                <h2
                  id={titleId}
                  className="truncate text-xl font-semibold tracking-heading"
                >
                  {title}
                </h2>
              ) : null}
              {description ? (
                <p id={descId} className="mt-0.5 text-sm text-muted">
                  {description}
                </p>
              ) : null}
            </div>
            {actions ? (
              <div className="flex shrink-0 items-center gap-1">{actions}</div>
            ) : null}
            {showClose ? (
              <button
                type="button"
                aria-label={closeLabel}
                onClick={() => onOpenChange(false)}
                className="focus-ring u-colors flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-surface-2 hover:text-fg"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            ) : null}
          </header>
        ) : null}

        <div
          className={cn(
            "scrollbar-thin flex-1 overflow-y-auto overscroll-contain px-4 py-4",
            bodyClassName,
          )}
        >
          {children}
        </div>

        {footer ? (
          <div className="shrink-0 border-t border-border bg-bg px-4 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </>
  );
}
