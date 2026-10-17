import { describe, expect, it } from "vitest";
import {
  FLIP_ID_ATTRIBUTE,
  LAYOUT_SHIFT_MIN_PX,
  flipDelta,
  shouldAnimateLayout,
} from "./layout-shift";

/**
 * The layout-shift arithmetic, pinned. FLIP is easy to get subtly wrong (a sign flip
 * makes everything accelerate away from where it belongs), and the wrong sign is
 * invisible in a still screenshot — so it is asserted here rather than eyeballed.
 */
describe("layout shifts", () => {
  it("returns the compensating delta for an element that moved", () => {
    // It was at y=100, it is now at y=40 → it must start 60px *below* its new home.
    expect(flipDelta({ x: 0, y: 100 }, { x: 0, y: 40 })).toEqual({ dx: 0, dy: 60 });
    // And the other way: it moved down, so it starts above.
    expect(flipDelta({ x: 0, y: 40 }, { x: 0, y: 100 })).toEqual({ dx: 0, dy: -60 });
    expect(flipDelta({ x: 20, y: 0 }, { x: 5, y: 0 })).toEqual({ dx: 15, dy: 0 });
  });

  it("does not animate an element it has never seen", () => {
    // A newly inserted block has no "before": it appears, it does not slide.
    expect(flipDelta(undefined, { x: 10, y: 10 })).toBeNull();
  });

  it("ignores sub-pixel and rounding movement", () => {
    const just = LAYOUT_SHIFT_MIN_PX - 1;
    expect(flipDelta({ x: 0, y: 0 }, { x: just, y: just })).toBeNull();
    expect(flipDelta({ x: 0, y: 0 }, { x: 0, y: 0 })).toBeNull();
  });

  it("animates as soon as either axis is worth it", () => {
    expect(flipDelta({ x: 0, y: 0 }, { x: LAYOUT_SHIFT_MIN_PX, y: 0 })).toEqual({
      dx: -LAYOUT_SHIFT_MIN_PX,
      dy: 0,
    });
  });

  it("stands down for reduced motion and for drags", () => {
    expect(shouldAnimateLayout({ reducedMotion: false, dragging: false })).toBe(true);
    expect(shouldAnimateLayout({ reducedMotion: true, dragging: false })).toBe(false);
    expect(shouldAnimateLayout({ reducedMotion: false, dragging: true })).toBe(false);
  });

  it("exports the attribute callers must put on their items", () => {
    expect(FLIP_ID_ATTRIBUTE).toBe("data-flip-id");
  });
});
