/**
 * Floating-layer placement.
 *
 * Every popup in the app (Select listbox, menu submenus, pickers) must:
 * - flip to the opposite side when there is no room,
 * - clamp inside the viewport so it is never clipped,
 * - keep a consistent gap from its anchor,
 * - never overflow the viewport edge by even 1px.
 *
 * The maths lives here (pure, unit-tested) so `select.tsx`, the actions menu and
 * any future popover share one implementation instead of four fragile ones.
 */

export type Side = "top" | "bottom" | "left" | "right";
export type Align = "start" | "center" | "end";

/** Gap between the anchor and the floating layer, in px. Matches `--space-1`. */
export const FLOATING_GAP = 4;
/** Minimum distance the layer keeps from the viewport edge, in px. */
export const FLOATING_PADDING = 8;

export type Rect = { top: number; left: number; width: number; height: number };
export type Size = { width: number; height: number };
export type Viewport = { width: number; height: number };

export type Placement = {
  top: number;
  left: number;
  /** The side actually used after flipping. */
  side: Side;
  /** Whether the layer had to flip away from the preferred side. */
  flipped: boolean;
  /** Whether the layer is taller than the available space (caller should scroll). */
  cramped: boolean;
  /** Largest height that fits without leaving the viewport. */
  maxHeight: number;
};

const OPPOSITE: Record<Side, Side> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
};

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

/** Space available on a given side of the anchor, inside the viewport padding. */
export function availableSpace(
  anchor: Rect,
  side: Side,
  viewport: Viewport,
  padding = FLOATING_PADDING,
  gap = FLOATING_GAP,
): number {
  switch (side) {
    case "bottom":
      return viewport.height - (anchor.top + anchor.height) - gap - padding;
    case "top":
      return anchor.top - gap - padding;
    case "right":
      return viewport.width - (anchor.left + anchor.width) - gap - padding;
    case "left":
      return anchor.left - gap - padding;
  }
}

/**
 * Resolve where a floating layer should sit.
 *
 * `preferred` is the side the design wants; it flips when the layer does not fit
 * but the opposite side has room for more of it. The result is always clamped
 * inside the viewport.
 */
export function placeFloating(input: {
  anchor: Rect;
  size: Size;
  viewport: Viewport;
  preferred: Side;
  align?: Align;
  gap?: number;
  padding?: number;
}): Placement {
  const {
    anchor,
    size,
    viewport,
    preferred,
    align = "start",
    gap = FLOATING_GAP,
    padding = FLOATING_PADDING,
  } = input;

  const room = (side: Side) => availableSpace(anchor, side, viewport, padding, gap);
  const needs = (side: Side) =>
    side === "top" || side === "bottom" ? size.height : size.width;

  let side = preferred;
  let flipped = false;
  if (room(side) < needs(side)) {
    const other = OPPOSITE[side];
    if (room(other) > room(side)) {
      side = other;
      flipped = true;
    }
  }

  const maxHeight = Math.max(0, room(side));

  let top: number;
  let left: number;

  if (side === "bottom" || side === "top") {
    top = side === "bottom" ? anchor.top + anchor.height + gap : anchor.top - gap - size.height;
    if (align === "start") left = anchor.left;
    else if (align === "center") left = anchor.left + anchor.width / 2 - size.width / 2;
    else left = anchor.left + anchor.width - size.width;
  } else {
    left = side === "right" ? anchor.left + anchor.width + gap : anchor.left - gap - size.width;
    if (align === "start") top = anchor.top;
    else if (align === "center") top = anchor.top + anchor.height / 2 - size.height / 2;
    else top = anchor.top + anchor.height - size.height;
  }

  return {
    top: clamp(top, padding, viewport.height - padding - Math.min(size.height, maxHeight)),
    left: clamp(left, padding, viewport.width - padding - size.width),
    side,
    flipped,
    cramped: needs(side) > room(side),
    maxHeight,
  };
}

/** Inline style for a fixed-position floating layer. */
export function floatingStyle(placement: Placement): {
  position: "fixed";
  top: number;
  left: number;
  maxHeight: number;
} {
  return {
    position: "fixed",
    top: Math.round(placement.top),
    left: Math.round(placement.left),
    maxHeight: Math.round(placement.maxHeight),
  };
}
