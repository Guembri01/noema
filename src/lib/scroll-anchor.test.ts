import { describe, expect, it } from "vitest";
import {
  adjustForInsertions,
  captureAnchor,
  nearestVisibleIndex,
  restoreScrollTop,
} from "@/lib/scroll-anchor";

describe("captureAnchor", () => {
  it("keeps finite, non-negative values and floors fractions", () => {
    expect(
      captureAnchor({ anchorIndex: 3, anchorOffset: 12.9, scrollTop: 100.5 }),
    ).toEqual({ anchorIndex: 3, anchorOffset: 12, scrollTop: 100 });
  });

  it("defaults the optional offset and scrollTop to zero", () => {
    expect(captureAnchor({ anchorIndex: 4 })).toEqual({
      anchorIndex: 4,
      anchorOffset: 0,
      scrollTop: 0,
    });
  });

  it("clamps negatives up to zero", () => {
    expect(
      captureAnchor({ anchorIndex: -2, anchorOffset: -8, scrollTop: -40 }),
    ).toEqual({ anchorIndex: 0, anchorOffset: 0, scrollTop: 0 });
  });

  it("coerces non-finite inputs to zero", () => {
    expect(
      captureAnchor({
        anchorIndex: Number.NaN,
        anchorOffset: Number.POSITIVE_INFINITY,
        scrollTop: Number.NEGATIVE_INFINITY,
      }),
    ).toEqual({ anchorIndex: 0, anchorOffset: 0, scrollTop: 0 });
  });

  it("is pure and never mutates its input", () => {
    const input = { anchorIndex: 2, anchorOffset: 5, scrollTop: 30 };
    const first = captureAnchor(input);
    const second = captureAnchor(input);
    expect(first).toEqual(second);
    expect(input).toEqual({ anchorIndex: 2, anchorOffset: 5, scrollTop: 30 });
  });
});

describe("restoreScrollTop", () => {
  const anchor = captureAnchor({
    anchorIndex: 5,
    anchorOffset: 14,
    scrollTop: 200,
  });

  it("adds the intra-row offset to the row's new absolute offset", () => {
    expect(restoreScrollTop(anchor, { newOffsetOfIndex: 320 })).toBe(334);
    expect(restoreScrollTop(anchor, { newOffsetOfIndex: 0 })).toBe(14);
  });

  it("never returns a negative scroll position", () => {
    expect(restoreScrollTop(anchor, { newOffsetOfIndex: -100 })).toBe(0);
  });

  it("falls back to the captured scrollTop when the row offset is unusable", () => {
    expect(
      restoreScrollTop(anchor, { newOffsetOfIndex: Number.NaN }),
    ).toBe(200);
    expect(
      restoreScrollTop(anchor, { newOffsetOfIndex: Number.POSITIVE_INFINITY }),
    ).toBe(200);
  });
});

describe("adjustForInsertions", () => {
  const anchor = captureAnchor({
    anchorIndex: 4,
    anchorOffset: 10,
    scrollTop: 250,
  });

  it("leaves the anchor untouched when the change is below it", () => {
    expect(
      adjustForInsertions(anchor, { atIndex: 7, deltaHeight: 120 }),
    ).toEqual(anchor);
  });

  it("shifts the index and scrollTop when a row is inserted at the anchor", () => {
    expect(
      adjustForInsertions(anchor, { atIndex: 4, deltaHeight: 60 }),
    ).toEqual({ anchorIndex: 5, anchorOffset: 10, scrollTop: 310 });
  });

  it("shifts the index and scrollTop when a row is inserted above the anchor", () => {
    expect(
      adjustForInsertions(anchor, { atIndex: 1, deltaHeight: 40 }),
    ).toEqual({ anchorIndex: 5, anchorOffset: 10, scrollTop: 290 });
  });

  it("runs the inverse shift when height is removed above the anchor", () => {
    expect(
      adjustForInsertions(anchor, { atIndex: 2, deltaHeight: -30 }),
    ).toEqual({ anchorIndex: 3, anchorOffset: 10, scrollTop: 220 });
  });

  it("clamps the shifted index at zero", () => {
    const top = captureAnchor({ anchorIndex: 0, anchorOffset: 3, scrollTop: 5 });
    expect(adjustForInsertions(top, { atIndex: 0, deltaHeight: -15 })).toEqual({
      anchorIndex: 0,
      anchorOffset: 3,
      scrollTop: -10,
    });
  });

  it("reports no movement for a zero height change", () => {
    expect(
      adjustForInsertions(anchor, { atIndex: 0, deltaHeight: 0 }),
    ).toEqual(anchor);
  });

  it("treats a non-finite delta as no height change", () => {
    expect(
      adjustForInsertions(anchor, { atIndex: 0, deltaHeight: Number.NaN }),
    ).toEqual(anchor);
  });

  it("is pure and never mutates its arguments", () => {
    const edit = { atIndex: 2, deltaHeight: 50 };
    const first = adjustForInsertions(anchor, edit);
    const second = adjustForInsertions(anchor, edit);
    expect(first).toEqual(second);
    expect(edit).toEqual({ atIndex: 2, deltaHeight: 50 });
    expect(anchor).toEqual({
      anchorIndex: 4,
      anchorOffset: 10,
      scrollTop: 250,
    });
  });
});

describe("nearestVisibleIndex", () => {
  const heights = [30, 40, 50, 20];

  it("returns 0 for the top of the list", () => {
    expect(nearestVisibleIndex(0, heights)).toBe(0);
    expect(nearestVisibleIndex(-25, heights)).toBe(0);
  });

  it("finds the row containing an offset", () => {
    expect(nearestVisibleIndex(10, heights)).toBe(0);
    expect(nearestVisibleIndex(30, heights)).toBe(1);
    expect(nearestVisibleIndex(65, heights)).toBe(1);
    expect(nearestVisibleIndex(70, heights)).toBe(2);
    expect(nearestVisibleIndex(139, heights)).toBe(3);
  });

  it("clamps past the end to the last row", () => {
    expect(nearestVisibleIndex(140, heights)).toBe(3);
    expect(nearestVisibleIndex(9999, heights)).toBe(3);
  });

  it("returns -1 for an empty list", () => {
    expect(nearestVisibleIndex(0, [])).toBe(-1);
    expect(nearestVisibleIndex(500, [])).toBe(-1);
  });

  it("handles a single row", () => {
    expect(nearestVisibleIndex(0, [80])).toBe(0);
    expect(nearestVisibleIndex(79, [80])).toBe(0);
    expect(nearestVisibleIndex(80, [80])).toBe(0);
  });

  it("coerces non-finite scrollTop and treats bad heights as zero", () => {
    expect(nearestVisibleIndex(Number.NaN, heights)).toBe(0);
    expect(nearestVisibleIndex(0, [0, 0, 25])).toBe(2);
    expect(nearestVisibleIndex(10, [Number.NaN, 25])).toBe(1);
    expect(nearestVisibleIndex(10, [-5, 25])).toBe(1);
  });

  it("is pure and never mutates the heights array", () => {
    const rows = [10, 20, 30];
    const first = nearestVisibleIndex(15, rows);
    const second = nearestVisibleIndex(15, rows);
    expect(first).toBe(second);
    expect(rows).toEqual([10, 20, 30]);
  });
});

describe("scroll anchor round trip", () => {
  it("reproduces the captured offset after a re-measure", () => {
    const heights = [30, 40, 50, 20];
    const scrollTop = 45;
    const anchor = captureAnchor({
      anchorIndex: nearestVisibleIndex(scrollTop, heights),
      anchorOffset: scrollTop - 30,
      scrollTop,
    });
    const grown = [30, 90, 40, 50, 20];
    const restored = restoreScrollTop(anchor, { newOffsetOfIndex: 30 });
    expect(anchor).toEqual({ anchorIndex: 1, anchorOffset: 15, scrollTop: 45 });
    expect(nearestVisibleIndex(restored, grown)).toBe(1);
    expect(restored).toBe(45);
  });
});
