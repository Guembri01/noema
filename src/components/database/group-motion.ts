/**
 * Database view motion — the pure half of the row add/delete/reorder and group
 * reveal animations.
 *
 * These helpers are deliberately React-free so the arithmetic is pinned by node
 * tests instead of by watching the screen; `view-renderers.tsx` owns the hooks
 * that feed them. They cover three things the raw FLIP hook
 * (`@/lib/layout-shift`) does not do on its own:
 *
 *  · **which rows are new** — a row that appears should fade in, one that stays
 *    should not animate at all (so typing in a cell never replays a fade);
 *  · **keeping a leaving row in the list** — a deleted row is removed from the
 *    data, so it has to be re-inserted at its old slot for the exit to play
 *    before the rows around it close the gap (the FLIP hook then slides them);
 *  · **the styles themselves** — every value comes from the motion token layer
 *    (`--dur-*` / `--ease-*`), never an ad-hoc duration or easing keyword.
 */

import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { DUR } from "@/lib/design-tokens";

/** How long a row's entry/exit plays: the panel tier (`--dur-2`). */
export const ROW_MOTION_MS = DUR.base;

/** How a rendered row should animate, if at all. */
export type RowMotionState = "enter" | "leave" | "idle";

/** Whether two id sequences are identical, order included. */
export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** Ordered ids present in `next` but absent from `previous` (the rows that entered). */
export function enteredIds(
  previous: readonly string[],
  next: readonly string[],
): string[] {
  const before = new Set(previous);
  return next.filter((id) => !before.has(id));
}

/** Ordered ids present in `previous` but absent from `next` (the rows that left). */
export function leftIds(
  previous: readonly string[],
  next: readonly string[],
): string[] {
  const after = new Set(next);
  return previous.filter((id) => !after.has(id));
}

/**
 * A single dependency value that changes only when the **ordered ids** change.
 *
 * `useFlipList` takes a dependency array whose length must not change between
 * renders, so the row list is folded into one string: a keystroke changes a
 * cell, never the id signature, so no layout animation can run under a caret.
 */
export function rowIdsKey(ids: readonly string[]): string {
  return ids.join("\u0000");
}

/**
 * Re-insert the items that just left `current` back into the render list, at
 * the slot they held in `previous` (the list rendered last commit), so a
 * removed row keeps its box while it fades out instead of vanishing mid-frame.
 * Items still present keep the order `current` gives them, so a reorder is
 * never undone by the exit list.
 */
export function retainLeaving<T>(
  current: readonly T[],
  previous: readonly T[],
  keyOf: (item: T) => string,
): T[] {
  if (previous.length === 0) return [...current];
  const present = new Set(current.map(keyOf));
  const result = [...current];
  previous.forEach((item, index) => {
    if (present.has(keyOf(item))) return;
    result.splice(Math.min(index, result.length), 0, item);
  });
  return result;
}

/** Resolve a row's animation from the current presence sets. */
export function rowMotionState(
  id: string,
  context: { present: ReadonlySet<string>; entering: ReadonlySet<string> },
): RowMotionState {
  if (!context.present.has(id)) return "leave";
  return context.entering.has(id) ? "enter" : "idle";
}

/**
 * The motion a rendered row carries. A new row fades in on the shared `fade`
 * keyframe; a row that just left keeps its slot and transitions its opacity to
 * zero on `--dur-2` before the caller unmounts it. An idle row carries nothing,
 * so a cell edit or a hover never restarts an animation.
 */
export function rowMotionStyle(state: RowMotionState): CSSProperties {
  if (state === "enter") {
    return { animation: "fade var(--dur-2) var(--ease-smooth) both" };
  }
  if (state === "leave") {
    return {
      opacity: 0,
      transition: "opacity var(--dur-2) var(--ease-smooth)",
      pointerEvents: "none",
    };
  }
  return {};
}

/** A leaving row holds its layout slot for the whole fade, so surrounding rows never jump. */
export function rowMotionClass(state: RowMotionState): string {
  return state === "leave" ? "pointer-events-none" : "";
}

/** The chevron inside a group heading: rotates on the shared transform token. */
export function groupChevronClass(expanded: boolean): string {
  return cn("h-3.5 w-3.5 u-transform", expanded && "rotate-90");
}
