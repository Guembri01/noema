import { describe, expect, it } from "vitest";
import {
  indexAtOffset,
  offsetForIndex,
  scrollToIndex,
  totalHeight,
  visibleRange,
} from "@/lib/virtual-list";

/** Fixed-height items, the common case. */
const UNIFORM = { itemHeight: 20, itemCount: 100, viewportSize: 100 } as const;

/** Heights of a 5-row variable-height list: tops 0, 10, 30, 60, 100; total 150. */
const HEIGHTS = [10, 20, 30, 40, 50];
const variable = (index: number): number => HEIGHTS[index] ?? 0;

describe("visibleRange", () => {
  it("returns the first viewport of a fixed-height list (end is exclusive)", () => {
    expect(visibleRange({ ...UNIFORM, scrollTop: 0 })).toEqual({ start: 0, end: 5 });
  });

  it("follows the scroll position", () => {
    expect(visibleRange({ ...UNIFORM, scrollTop: 50 })).toEqual({ start: 2, end: 8 });
  });

  it("expands the window by overscan on both sides", () => {
    expect(visibleRange({ ...UNIFORM, scrollTop: 50, overscan: 2 })).toEqual({
      start: 0,
      end: 10,
    });
  });

  it("clamps the window to the item count", () => {
    expect(visibleRange({ ...UNIFORM, scrollTop: 1990 })).toEqual({ start: 99, end: 100 });
  });

  it("returns an empty window past the end", () => {
    const range = visibleRange({ ...UNIFORM, scrollTop: 5000 });
    expect(range).toEqual({ start: 100, end: 100 });
    expect(range.end - range.start).toBe(0);
  });

  it("guards zero/negative inputs", () => {
    expect(visibleRange({ ...UNIFORM, itemCount: 0, scrollTop: 0 })).toEqual({ start: 0, end: 0 });
    expect(visibleRange({ ...UNIFORM, viewportSize: 0, scrollTop: 0 })).toEqual({ start: 0, end: 0 });
    expect(visibleRange({ ...UNIFORM, viewportSize: -10, scrollTop: 0 })).toEqual({ start: 0, end: 0 });
    expect(visibleRange({ ...UNIFORM, itemHeight: 0, scrollTop: 0 })).toEqual({ start: 0, end: 0 });
  });

  it("clamps a negative scroll offset to the top", () => {
    expect(visibleRange({ ...UNIFORM, scrollTop: -40 })).toEqual({ start: 0, end: 5 });
  });

  it("measures variable-height rows via heightOf", () => {
    const range = visibleRange({
      scrollTop: 0,
      viewportSize: 35,
      itemHeight: 20,
      itemCount: 5,
      heightOf: variable,
    });
    expect(range).toEqual({ start: 0, end: 3 });
  });

  it("walks cumulative heights when scrolled into a variable list", () => {
    const range = visibleRange({
      scrollTop: 35,
      viewportSize: 35,
      itemHeight: 20,
      itemCount: 5,
      heightOf: variable,
    });
    expect(range).toEqual({ start: 2, end: 4 });
  });

  it("still works when only heightOf is supplied (itemHeight degenerate)", () => {
    const range = visibleRange({
      scrollTop: 0,
      viewportSize: 35,
      itemHeight: 0,
      itemCount: 5,
      heightOf: variable,
    });
    expect(range).toEqual({ start: 0, end: 3 });
  });
});

describe("totalHeight", () => {
  it("multiplies count by the fixed row height", () => {
    expect(totalHeight(100, 20)).toBe(2000);
    expect(totalHeight(0, 20)).toBe(0);
  });

  it("guards non-positive counts and heights", () => {
    expect(totalHeight(-5, 20)).toBe(0);
    expect(totalHeight(3, 0)).toBe(0);
    expect(totalHeight(3, -20)).toBe(0);
  });

  it("sums variable row heights", () => {
    expect(totalHeight(5, 20, variable)).toBe(150);
  });
});

describe("offsetForIndex", () => {
  it("is index * itemHeight for a fixed list", () => {
    expect(offsetForIndex(0, 20)).toBe(0);
    expect(offsetForIndex(3, 20)).toBe(60);
    expect(offsetForIndex(2.9, 20)).toBe(40);
  });

  it("treats negative indices as the top", () => {
    expect(offsetForIndex(-4, 20)).toBe(0);
  });

  it("sums preceding variable heights", () => {
    expect(offsetForIndex(0, 20, variable)).toBe(0);
    expect(offsetForIndex(1, 20, variable)).toBe(10);
    expect(offsetForIndex(2, 20, variable)).toBe(30);
    expect(offsetForIndex(3, 20, variable)).toBe(60);
  });
});

describe("indexAtOffset", () => {
  it("divides the offset by the fixed row height", () => {
    expect(indexAtOffset(0, 20)).toBe(0);
    expect(indexAtOffset(19, 20)).toBe(0);
    expect(indexAtOffset(20, 20)).toBe(1);
    expect(indexAtOffset(40, 20)).toBe(2);
  });

  it("treats negative offsets as the top", () => {
    expect(indexAtOffset(-5, 20)).toBe(0);
  });

  it("finds the row containing an offset in a variable list", () => {
    expect(indexAtOffset(0, 20, variable)).toBe(0);
    expect(indexAtOffset(9, 20, variable)).toBe(0);
    expect(indexAtOffset(10, 20, variable)).toBe(1);
    expect(indexAtOffset(29, 20, variable)).toBe(1);
    expect(indexAtOffset(30, 20, variable)).toBe(2);
  });

  it("round-trips with offsetForIndex", () => {
    for (let i = 0; i < HEIGHTS.length; i += 1) {
      expect(indexAtOffset(offsetForIndex(i, 20, variable), 20, variable)).toBe(i);
    }
  });
});

describe("scrollToIndex", () => {
  it("aligns the row to the start (default padding 0)", () => {
    expect(scrollToIndex(10, { ...UNIFORM, align: "start" })).toBe(200);
  });

  it("aligns the row to the end", () => {
    expect(scrollToIndex(10, { ...UNIFORM, align: "end" })).toBe(120);
  });

  it("centers the row", () => {
    expect(scrollToIndex(10, { ...UNIFORM, align: "center" })).toBe(160);
  });

  it("leaves scrollTop untouched with `nearest` when already visible", () => {
    expect(scrollToIndex(2, { ...UNIFORM, align: "nearest", scrollTop: 0 })).toBe(0);
  });

  it("scrolls minimally with `nearest` when the row is below the viewport", () => {
    expect(scrollToIndex(10, { ...UNIFORM, align: "nearest", scrollTop: 0 })).toBe(120);
  });

  it("scrolls minimally with `nearest` when the row is above the viewport", () => {
    expect(scrollToIndex(2, { ...UNIFORM, align: "nearest", scrollTop: 100 })).toBe(40);
  });

  it("honours padding for start and end alignment", () => {
    expect(scrollToIndex(10, { ...UNIFORM, align: "start", padding: 5 })).toBe(195);
    expect(scrollToIndex(10, { ...UNIFORM, align: "end", padding: 5 })).toBe(125);
  });

  it("clamps to the scrollable range", () => {
    expect(scrollToIndex(0, { ...UNIFORM, align: "end" })).toBe(0);
    expect(scrollToIndex(99, { ...UNIFORM, align: "start" })).toBe(1900);
  });

  it("clamps an out-of-range index into the list", () => {
    expect(scrollToIndex(500, { ...UNIFORM, align: "start" })).toBe(1900);
    expect(scrollToIndex(-3, { ...UNIFORM, align: "start" })).toBe(0);
  });

  it("returns 0 for an empty list", () => {
    expect(scrollToIndex(3, { ...UNIFORM, itemCount: 0, align: "start" })).toBe(0);
  });

  it("accounts for variable row heights", () => {
    const geometry = { itemHeight: 20, itemCount: 5, viewportSize: 35, heightOf: variable };
    expect(scrollToIndex(3, { ...geometry, align: "start" })).toBe(60);
    expect(scrollToIndex(3, { ...geometry, align: "end" })).toBe(65);
    expect(scrollToIndex(4, { ...geometry, align: "end" })).toBe(115);
  });
});
