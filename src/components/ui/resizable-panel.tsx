"use client";

import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

/**
 * ResizablePanel — a panel with a real, keyboard-operable drag handle.
 *
 * The handle is a WAI-ARIA `separator`: it carries `aria-orientation` plus
 * `aria-valuenow/min/max`, is focusable, moves on the arrow keys (Shift widens
 * the step) and jumps to the limits on Home/End; double-click resets to
 * `defaultWidth`. Dragging works with mouse, pen and touch through pointer
 * events, clamped to `[min, max]`.
 *
 * Structure vs drag (design system §6): while the handle is held the panel must
 * track the pointer 1:1, so it carries `u-no-transition` and an inline
 * `transition: none`; at rest every size change animates on `--dur-2` /
 * `--ease-smooth`.
 *
 * The component is uncontrolled by default (it owns the width) and controlled
 * when `width` is passed: every change fires `onResize`, and a drag/keyboard
 * commit also fires `onResizeEnd` (the persistence hook — the live drag frames
 * never write).
 */

export type ResizablePanelOrientation = "vertical" | "horizontal";
export type ResizablePanelEdge = "start" | "end";

/** Bounds shared by every pure size resolver. */
export type PanelBounds = {
  min: number;
  max: number;
  /** Used when the incoming value is not finite. */
  fallback: number;
};

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Clamp `value` into `[min, max]`, rounded to whole px. A non-finite `value`
 * falls back to `fallback` (itself falling back to the low bound), so an
 * unusable number can never produce a broken panel size.
 */
export function clampPanelSize(
  value: number,
  min: number,
  max: number,
  fallback: number = min,
): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const safe = finiteOr(value, finiteOr(fallback, lo));
  return Math.min(hi, Math.max(lo, Math.round(safe)));
}

/**
 * Size implied by dragging from `startSize` when the pointer has moved `delta`
 * px along the resize axis. A handle on the `end` edge grows with the pointer;
 * one on the `start` edge shrinks.
 */
export function dragPanelSize(
  startSize: number,
  delta: number,
  bounds: PanelBounds,
  edge: ResizablePanelEdge = "end",
): number {
  const sign = edge === "start" ? -1 : 1;
  return clampPanelSize(
    finiteOr(startSize, bounds.fallback) + sign * finiteOr(delta, 0),
    bounds.min,
    bounds.max,
    bounds.fallback,
  );
}

/** Size after an arrow-key nudge of `delta` px from `current`. */
export function nudgePanelSize(
  current: number,
  delta: number,
  bounds: PanelBounds,
): number {
  return clampPanelSize(
    finiteOr(current, bounds.fallback) + finiteOr(delta, 0),
    bounds.min,
    bounds.max,
    bounds.fallback,
  );
}

export type ResizablePanelProps = {
  children: ReactNode;
  /** Controlled size in px; omit to let the panel own it (initial `defaultWidth`). */
  width?: number;
  /** Initial size, and the size a double-click resets to. */
  defaultWidth: number;
  min: number;
  max: number;
  /** Arrow-key step in px (default 8). */
  step?: number;
  /** Arrow-key step while Shift is held (default `step * 3`). */
  largeStep?: number;
  /** Fired with every new size (each drag frame and each keyboard change). */
  onResize?: (width: number) => void;
  /** Fired when a drag ends or a keyboard change commits — the persistence hook. */
  onResizeEnd?: (width: number) => void;
  /** Accessible name for the separator (required). */
  label: string;
  /** Tooltip on the separator. */
  handleTitle?: string;
  /** `vertical` (default) is a left/right divider; `horizontal` is top/bottom. */
  orientation?: ResizablePanelOrientation;
  /** Which edge holds the handle; `end` (default) grows toward the pointer. */
  edge?: ResizablePanelEdge;
  /** Panel element. Default `div`. */
  as?: "div" | "aside" | "section";
  /** Classes for the panel element. */
  className?: string;
  /** Extra classes for the separator (positioning, layering). */
  handleClassName?: string;
  /** `data-testid` for the panel element. */
  testId?: string;
  /** `data-testid` for the separator. */
  handleTestId?: string;
};

const HANDLE_PSEUDO =
  "after:absolute after:bg-transparent hover:after:bg-accent/50 focus-visible:after:bg-accent";
const HANDLE_VERTICAL =
  "absolute inset-y-0 -right-1 w-2 cursor-col-resize touch-none select-none after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2";
const HANDLE_HORIZONTAL =
  "absolute inset-x-0 -bottom-1 h-2 cursor-row-resize touch-none select-none after:inset-x-0 after:top-1/2 after:h-px after:-translate-y-1/2";

export function ResizablePanel({
  children,
  width,
  defaultWidth,
  min,
  max,
  step = 8,
  largeStep,
  onResize,
  onResizeEnd,
  label,
  handleTitle,
  orientation = "vertical",
  edge = "end",
  as: Tag = "div",
  className,
  handleClassName,
  testId,
  handleTestId,
}: ResizablePanelProps) {
  const controlled = width !== undefined;
  const [internal, setInternal] = useState(() =>
    clampPanelSize(defaultWidth, min, max, defaultWidth),
  );
  const current = clampPanelSize(controlled ? width : internal, min, max, defaultWidth);
  const [dragging, setDragging] = useState(false);
  /** The latest size, readable inside the pointer handlers without a re-render. */
  const currentRef = useRef(current);
  currentRef.current = current;

  const commit = useCallback(
    (next: number, final: boolean) => {
      const value = clampPanelSize(next, min, max, defaultWidth);
      if (!controlled) setInternal(value);
      onResize?.(value);
      if (final) onResizeEnd?.(value);
    },
    [controlled, defaultWidth, min, max, onResize, onResizeEnd],
  );

  const bounds: PanelBounds = { min, max, fallback: defaultWidth };
  const stepSize = largeStep ?? step * 3;

  /**
   * Begin a resize. Pointer events cover mouse, pen and touch; the listeners
   * live on `window` so the drag keeps tracking when the pointer leaves the
   * handle. `latest` holds the last computed size so the commit on release
   * matches the final frame exactly.
   */
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startSize = currentRef.current;
    const startCoord = orientation === "vertical" ? event.clientX : event.clientY;
    let latest = startSize;
    setDragging(true);
    const onMove = (move: PointerEvent) => {
      const coord = orientation === "vertical" ? move.clientX : move.clientY;
      latest = dragPanelSize(startSize, coord - startCoord, bounds, edge);
      commit(latest, false);
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      commit(latest, true);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const amount = event.shiftKey ? stepSize : step;
    const sign = edge === "start" ? -1 : 1;
    const forward = orientation === "vertical" ? "ArrowRight" : "ArrowDown";
    const backward = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
    let next: number | null = null;
    if (event.key === forward) next = nudgePanelSize(current, sign * amount, bounds);
    else if (event.key === backward) next = nudgePanelSize(current, -sign * amount, bounds);
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else return;
    event.preventDefault();
    commit(next, true);
  };

  // Drag is 1:1; every other size change animates on a motion token.
  const transition = dragging
    ? "none"
    : `${orientation === "vertical" ? "width" : "height"} var(--dur-2) var(--ease-smooth)`;
  const sizeStyle: CSSProperties =
    orientation === "vertical"
      ? { width: current, transition }
      : { height: current, transition };

  return (
    <Tag
      data-testid={testId}
      className={cn("relative", dragging && "u-no-transition", className)}
      style={sizeStyle}
    >
      {children}
      <div
        role="separator"
        aria-orientation={orientation}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={current}
        tabIndex={0}
        title={handleTitle}
        data-testid={handleTestId}
        data-resizing={dragging ? "true" : undefined}
        onPointerDown={startDrag}
        onKeyDown={onKeyDown}
        onDoubleClick={() => commit(defaultWidth, true)}
        className={cn(
          "focus-ring",
          orientation === "vertical" ? HANDLE_VERTICAL : HANDLE_HORIZONTAL,
          HANDLE_PSEUDO,
          dragging &&
            (orientation === "vertical"
              ? "u-no-transition after:w-0.5 after:bg-accent"
              : "u-no-transition after:h-0.5 after:bg-accent"),
          handleClassName,
        )}
      />
    </Tag>
  );
}
