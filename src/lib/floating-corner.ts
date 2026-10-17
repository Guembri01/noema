/**
 * The floating bottom-right corner.
 *
 * Four controls used to claim the same 1rem/1.25rem inset — the Ask-AI button,
 * the editor's undo/redo bar, the sync notice and the editor's "Suggesting"
 * toggle — so they drew on top of each other. The corner is now a single
 * contract: the Ask-AI button owns it, and any other bar stacks *above* it,
 * sharing its inline-end edge.
 *
 * The "Suggesting" toggle used to sit in the bottom-**left** corner to stay out
 * of this stack's way, which put it on top of the sidebar's footer — a fixed
 * control cannot dodge the app chrome by picking a corner the contract does not
 * cover. It has a slot here now, and `npm run check:floating` fails if any fixed
 * control lands on the sidebar.
 *
 * Stacking (rather than sitting side by side) is what keeps the contract usable
 * on a narrow window: the sync notice is 20rem wide, and a horizontal offset
 * would push it off-screen on a phone.
 *
 * The values are Tailwind's spacing scale (`--spacing` multiples of 0.25rem),
 * so they are the same tokens the rest of the UI uses, and the arithmetic below
 * is exercised by `floating-corner.test.ts` and measured in a real browser by
 * `npm run check:floating`.
 */

/** Distance from the viewport edges to the corner button, in rem. */
export const FLOATING_INSET_REM = 1.25;
/** The corner button's side, in rem (`h-10 w-10`). */
export const FLOATING_BUTTON_REM = 2.5;
/** Vertical gap between two stacked floating controls, in rem. */
export const FLOATING_GAP_REM = 1.25;

/**
 * Bottom offset of a stack slot, in rem. Slot 0 is the button itself; each
 * further slot clears a button-height plus one gap.
 */
export function floatingSlotOffsetRem(slot: number): number {
  return FLOATING_INSET_REM + slot * (FLOATING_BUTTON_REM + FLOATING_GAP_REM);
}

/**
 * The slot classes. Kept as whole class strings (not composed at runtime) so
 * Tailwind can see them and the design audit can read them.
 *
 * - `fab`     slot 0 · 1.25rem  — the Ask-AI button.
 * - `bar`     slot 1 · 5rem     — transient bars (the editor's undo/redo).
 * - `notice`  slot 2 · 8.75rem  — the sync notice, which can be up while a bar is.
 * - `suggest` slot 3 · 12.5rem  — the editor's Suggesting toggle, which is up
 *   whenever the editor is, i.e. at the same time as the undo/redo bar.
 */
export const FLOATING_CORNER = {
  fab: "bottom-5 end-5",
  bar: "bottom-20 end-5",
  notice: "bottom-35 end-5",
  suggest: "bottom-50 end-5",
} as const;

/** A bottom-anchored box's geometry, as measured in the browser. */
export type FloatingBox = {
  /** Identifies the element in a failure message. */
  name: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

/** Two boxes overlap when they share both axes. */
export function floatingBoxesOverlap(a: FloatingBox, b: FloatingBox): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * Every overlapping pair in `boxes` — empty when the corner is laid out
 * correctly. Used by the browser check, so a future control that grabs the
 * corner is caught instead of shipped.
 */
export function findFloatingOverlaps(boxes: readonly FloatingBox[]): [FloatingBox, FloatingBox][] {
  const overlaps: [FloatingBox, FloatingBox][] = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (floatingBoxesOverlap(boxes[i], boxes[j])) overlaps.push([boxes[i], boxes[j]]);
    }
  }
  return overlaps;
}
