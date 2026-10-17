"use client";

import { useLayoutEffect, useRef } from "react";

/**
 * Layout shifts — animating things that *move* rather than things that change state.
 *
 * A state transition (hover, open, press) is one element changing its own styles, and
 * CSS handles it. A layout shift is different: reordering blocks, inserting a row,
 * deleting a row, expanding a group — the element that moves is not the element that
 * changed, so there is nothing to put a `transition:` on. Left alone, items jump.
 *
 * This is the standard fix: measure every marked child *before* the DOM updates,
 * measure again after, and for anything that moved apply a `transform` back to where it
 * was and release it on the next frame so it slides to its new position (FLIP).
 *
 * Three rules from the motion spec are enforced here rather than left to callers:
 *
 *  · **never while typing.** The hook only runs when its `deps` change, so callers pass
 *    the *structure* (the ordered ids), not the content. A keystroke changes content,
 *    not ids, so no shift animation can run under a caret.
 *  · **never during a drag.** A drag gives the pointer 1:1 control; an item sliding out
 *    from under the cursor fights it. Drag surfaces set `data-dragging="1"` on
 *    `document.body` (the same flag the `u-no-transition` convention uses).
 *  · **never against the OS.** `prefers-reduced-motion: reduce` disables the animation
 *    entirely — items simply appear in place, which is the correct reduced experience.
 */

/** Settle time for a displaced element: the panel tier (`--dur-2`). */
export const LAYOUT_SHIFT_DURATION_MS = 180;

/** Attribute a child must carry for the hook to track it. Value must be stable per item. */
export const FLIP_ID_ATTRIBUTE = "data-flip-id";

/** Movement below this is rounding, not a shift worth animating. */
export const LAYOUT_SHIFT_MIN_PX = 2;

export type FlipPoint = { x: number; y: number };

/** How far to offset an element so it starts where it used to be. */
export type FlipDelta = { dx: number; dy: number };

/**
 * How far an element moved, or `null` when it should not be animated.
 *
 * Pure, so the arithmetic is pinned by tests instead of by watching the screen.
 */
export function flipDelta(before: FlipPoint | undefined, after: FlipPoint): FlipDelta | null {
  if (!before) return null;
  const dx = before.x - after.x;
  const dy = before.y - after.y;
  if (Math.abs(dx) < LAYOUT_SHIFT_MIN_PX && Math.abs(dy) < LAYOUT_SHIFT_MIN_PX) return null;
  return { dx, dy };
}

/** Whether a layout shift may animate at all. */
export function shouldAnimateLayout(options: { reducedMotion: boolean; dragging: boolean }): boolean {
  return !options.reducedMotion && !options.dragging;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function isDragging(): boolean {
  if (typeof document === "undefined") return false;
  return document.body?.dataset?.dragging === "1";
}

/**
 * Animate the children of `containerRef` that move when `deps` change.
 *
 * Children must carry `data-flip-id` with a value that is stable for the item (a block
 * id, a row id) so the hook can tell "moved" from "replaced".
 */
export function useFlipList(
  containerRef: React.RefObject<HTMLElement | null>,
  deps: readonly unknown[],
): void {
  const positions = useRef(new Map<string, FlipPoint>());

  // Measure *after* React has committed but *before* the browser paints, so the
  // compensating transform is never visible as a flash.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = (): Map<string, FlipPoint> => {
      const next = new Map<string, FlipPoint>();
      for (const child of Array.from(container.querySelectorAll<HTMLElement>(`[${FLIP_ID_ATTRIBUTE}]`))) {
        const id = child.getAttribute(FLIP_ID_ATTRIBUTE);
        if (!id) continue;
        const rect = child.getBoundingClientRect();
        next.set(id, { x: rect.x, y: rect.y });
      }
      return next;
    };

    const after = measure();
    const animate = shouldAnimateLayout({ reducedMotion: prefersReducedMotion(), dragging: isDragging() });

    if (animate) {
      for (const [id, point] of after) {
        const delta = flipDelta(positions.current.get(id), point);
        if (!delta) continue;
        const child = container.querySelector<HTMLElement>(`[${FLIP_ID_ATTRIBUTE}="${CSS.escape(id)}"]`);
        if (!child) continue;
        // Start where it was, with no transition, then release on the next frame.
        child.style.transition = "none";
        child.style.transform = `translate(${delta.dx}px, ${delta.dy}px)`;
        requestAnimationFrame(() => {
          child.style.transition = `transform var(--dur-2) var(--ease-smooth)`;
          child.style.transform = "";
        });
      }
    }

    positions.current = after;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
