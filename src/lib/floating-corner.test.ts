import { describe, expect, it } from "vitest";
import {
  FLOATING_BUTTON_REM,
  FLOATING_CORNER,
  FLOATING_GAP_REM,
  FLOATING_INSET_REM,
  findFloatingOverlaps,
  floatingBoxesOverlap,
  floatingSlotOffsetRem,
  type FloatingBox,
} from "./floating-corner";

/** `bottom-20` → 20 × 0.25rem, the value Tailwind actually applies. */
function bottomRem(className: string): number {
  const match = /(?:^|\s)bottom-(\d+)(?:\s|$)/.exec(className);
  if (!match) throw new Error(`no bottom-* utility in "${className}"`);
  return Number(match[1]) * 0.25;
}

/** A 1440×900 window, with the corner controls measured from the right edge. */
const VIEWPORT = { width: 1440, height: 900 };
function cornerBox(name: string, bottomPx: number, heightPx: number, widthPx: number): FloatingBox {
  const right = VIEWPORT.width - FLOATING_INSET_REM * 16;
  return {
    name,
    right,
    left: right - widthPx,
    bottom: VIEWPORT.height - bottomPx,
    top: VIEWPORT.height - bottomPx - heightPx,
  };
}

describe("floating corner arithmetic", () => {
  it("stacks one button-height plus one gap per slot", () => {
    expect(floatingSlotOffsetRem(0)).toBe(FLOATING_INSET_REM);
    expect(floatingSlotOffsetRem(1)).toBe(FLOATING_INSET_REM + FLOATING_BUTTON_REM + FLOATING_GAP_REM);
    expect(floatingSlotOffsetRem(2)).toBe(
      FLOATING_INSET_REM + 2 * (FLOATING_BUTTON_REM + FLOATING_GAP_REM),
    );
  });

  it("keeps the class strings and the arithmetic in step", () => {
    // If someone edits a class, this fails instead of shipping a silent overlap.
    expect(bottomRem(FLOATING_CORNER.fab)).toBe(floatingSlotOffsetRem(0));
    expect(bottomRem(FLOATING_CORNER.bar)).toBe(floatingSlotOffsetRem(1));
    expect(bottomRem(FLOATING_CORNER.notice)).toBe(floatingSlotOffsetRem(2));
  });

  it("gives every stacked control its own slot, so two transient bars cannot collide", () => {
    const slots = [FLOATING_CORNER.bar, FLOATING_CORNER.notice].map((className) =>
      cornerBox(className, bottomRem(className) * 16, 36, 320),
    );
    expect(findFloatingOverlaps([...slots, cornerBox("fab", floatingSlotOffsetRem(0) * 16, 40, 40)])).toEqual([]);
  });

  it("anchors the stack to the same inline end as the button", () => {
    const edge = (className: string) => /(?:^|\s)(end-\d+)(?:\s|$)/.exec(className)?.[1];
    expect(edge(FLOATING_CORNER.fab)).toBe("end-5");
    expect(edge(FLOATING_CORNER.bar)).toBe(edge(FLOATING_CORNER.fab));
  });
});

describe("floating box overlaps", () => {
  const fab = cornerBox("fab", FLOATING_INSET_REM * 16, FLOATING_BUTTON_REM * 16, 40);

  it("does not overlap the bar one slot up — the fix", () => {
    const bar = cornerBox("history", floatingSlotOffsetRem(1) * 16, 36, 200);
    expect(floatingBoxesOverlap(fab, bar)).toBe(false);
    expect(findFloatingOverlaps([fab, bar])).toEqual([]);
  });

  it("would overlap in the corner slot — the bug that was reported", () => {
    const bar = cornerBox("history", floatingSlotOffsetRem(0) * 16, 36, 200);
    expect(floatingBoxesOverlap(fab, bar)).toBe(true);
    expect(findFloatingOverlaps([fab, bar])).toHaveLength(1);
  });

  it("reports every offending pair, not just the first", () => {
    const a = cornerBox("a", 20, 40, 200);
    const b = cornerBox("b", 30, 40, 200);
    const c = cornerBox("c", 35, 40, 200);
    expect(findFloatingOverlaps([a, b, c])).toHaveLength(3);
  });

  it("treats touching edges as clear, so a shared edge is not a defect", () => {
    const a: FloatingBox = { name: "a", left: 0, right: 10, top: 0, bottom: 10 };
    const b: FloatingBox = { name: "b", left: 0, right: 10, top: 10, bottom: 20 };
    expect(floatingBoxesOverlap(a, b)).toBe(false);
  });
});
