import { describe, expect, it } from "vitest";
import {
  FLOATING_GAP,
  FLOATING_PADDING,
  availableSpace,
  floatingStyle,
  placeFloating,
  type Rect,
} from "@/lib/floating";

const viewport = { width: 1000, height: 800 };
const anchor = (over: Partial<Rect> = {}): Rect => ({ top: 100, left: 100, width: 120, height: 32, ...over });

describe("floating placement", () => {
  it("keeps the preferred side when the layer fits", () => {
    const p = placeFloating({ anchor: anchor(), size: { width: 240, height: 300 }, viewport, preferred: "bottom" });
    expect(p.side).toBe("bottom");
    expect(p.flipped).toBe(false);
    expect(p.top).toBe(100 + 32 + FLOATING_GAP);
    expect(p.left).toBe(100);
  });

  it("flips to the top when there is no room below", () => {
    const p = placeFloating({
      anchor: anchor({ top: 700, height: 32 }),
      size: { width: 240, height: 300 },
      viewport,
      preferred: "bottom",
    });
    expect(p.side).toBe("top");
    expect(p.flipped).toBe(true);
    expect(p.top + 300).toBeLessThanOrEqual(700 - FLOATING_GAP + 0.001);
  });

  it("flips a start-side submenu to the left near the right edge", () => {
    const p = placeFloating({
      anchor: anchor({ left: 900, width: 60 }),
      size: { width: 220, height: 200 },
      viewport,
      preferred: "right",
    });
    expect(p.side).toBe("left");
    expect(p.flipped).toBe(true);
    expect(p.left).toBeGreaterThanOrEqual(FLOATING_PADDING);
    expect(p.left + 220).toBeLessThanOrEqual(viewport.width - FLOATING_PADDING + 0.001);
  });

  it("never leaves the viewport horizontally (clamped)", () => {
    const p = placeFloating({
      anchor: anchor({ left: 980, width: 20 }),
      size: { width: 300, height: 100 },
      viewport,
      preferred: "bottom",
      align: "start",
    });
    expect(p.left).toBeGreaterThanOrEqual(FLOATING_PADDING);
    expect(p.left + 300).toBeLessThanOrEqual(viewport.width - FLOATING_PADDING + 0.001);
  });

  it("reports cramped + a max height when the layer is taller than the room", () => {
    const p = placeFloating({
      anchor: anchor({ top: 400, height: 30 }),
      size: { width: 200, height: 900 },
      viewport: { width: 1000, height: 500 },
      preferred: "bottom",
    });
    expect(p.cramped).toBe(true);
    expect(p.maxHeight).toBeGreaterThan(0);
    expect(p.maxHeight).toBeLessThan(900);
  });

  it("supports align start/center/end on the cross axis", () => {
    const size = { width: 200, height: 100 };
    const start = placeFloating({ anchor: anchor(), size, viewport, preferred: "bottom", align: "start" });
    const center = placeFloating({ anchor: anchor(), size, viewport, preferred: "bottom", align: "center" });
    const end = placeFloating({ anchor: anchor(), size, viewport, preferred: "bottom", align: "end" });
    expect(start.left).toBe(100);
    expect(center.left).toBe(100 + 60 - 100);
    expect(end.left).toBe(100 + 120 - 200);
  });

  it("computes available space per side", () => {
    const a = anchor({ top: 200, left: 300, width: 100, height: 40 });
    expect(availableSpace(a, "bottom", viewport)).toBe(800 - 240 - FLOATING_GAP - FLOATING_PADDING);
    expect(availableSpace(a, "top", viewport)).toBe(200 - FLOATING_GAP - FLOATING_PADDING);
    expect(availableSpace(a, "right", viewport)).toBe(1000 - 400 - FLOATING_GAP - FLOATING_PADDING);
    expect(availableSpace(a, "left", viewport)).toBe(300 - FLOATING_GAP - FLOATING_PADDING);
  });

  it("produces a rounded fixed-position style", () => {
    const p = placeFloating({ anchor: anchor({ top: 10.6 }), size: { width: 200.4, height: 100 }, viewport, preferred: "bottom" });
    const style = floatingStyle(p);
    expect(style.position).toBe("fixed");
    expect(Number.isInteger(style.top)).toBe(true);
    expect(Number.isInteger(style.left)).toBe(true);
    expect(Number.isInteger(style.maxHeight)).toBe(true);
  });
});
