import { describe, expect, it } from "vitest";
import {
  PAGINATION_ELLIPSIS,
  clampPage,
  hasNext,
  hasPrev,
  pageCount,
  paginationWindow,
  rangeForPage,
} from "@/lib/pagination-window";

describe("pageCount", () => {
  it("returns 0 for empty or non-positive inputs", () => {
    expect(pageCount(0, 10)).toBe(0);
    expect(pageCount(-3, 10)).toBe(0);
    expect(pageCount(10, 0)).toBe(0);
    expect(pageCount(10, -5)).toBe(0);
  });

  it("rounds a partial last page up", () => {
    expect(pageCount(1, 10)).toBe(1);
    expect(pageCount(10, 10)).toBe(1);
    expect(pageCount(11, 10)).toBe(2);
    expect(pageCount(100, 25)).toBe(4);
    expect(pageCount(50, 20)).toBe(3);
  });
});

describe("rangeForPage", () => {
  it("returns a 0-based, end-exclusive slice range", () => {
    expect(rangeForPage(1, 10)).toEqual({ start: 0, end: 10 });
    expect(rangeForPage(2, 10)).toEqual({ start: 10, end: 20 });
    expect(rangeForPage(3, 25)).toEqual({ start: 50, end: 75 });
  });

  it("clamps a too-small page to the first page", () => {
    expect(rangeForPage(0, 10)).toEqual({ start: 0, end: 10 });
    expect(rangeForPage(-4, 10)).toEqual({ start: 0, end: 10 });
  });

  it("collapses to an empty range when perPage is not positive", () => {
    expect(rangeForPage(3, 0)).toEqual({ start: 0, end: 0 });
    expect(rangeForPage(3, -10)).toEqual({ start: 0, end: 0 });
  });
});

describe("clampPage", () => {
  it("leaves an in-range page untouched", () => {
    expect(clampPage(5, 20)).toBe(5);
    expect(clampPage(1, 20)).toBe(1);
    expect(clampPage(20, 20)).toBe(20);
  });

  it("clamps below 1 and above total", () => {
    expect(clampPage(0, 20)).toBe(1);
    expect(clampPage(-3, 20)).toBe(1);
    expect(clampPage(99, 20)).toBe(20);
  });

  it("floors fractions and falls back to 1 for NaN", () => {
    expect(clampPage(4.9, 20)).toBe(4);
    expect(clampPage(Number.NaN, 20)).toBe(1);
  });

  it("still yields the first page when there are no pages", () => {
    expect(clampPage(3, 0)).toBe(1);
  });
});

describe("hasPrev / hasNext", () => {
  it("detects the first and last page", () => {
    expect(hasPrev(1, 20)).toBe(false);
    expect(hasPrev(2, 20)).toBe(true);
    expect(hasNext(20, 20)).toBe(false);
    expect(hasNext(19, 20)).toBe(true);
  });

  it("reports nothing to move to on a single page", () => {
    expect(hasPrev(1, 1)).toBe(false);
    expect(hasNext(1, 1)).toBe(false);
  });

  it("normalises out-of-range pages before judging", () => {
    expect(hasPrev(0, 20)).toBe(false);
    expect(hasNext(0, 20)).toBe(true);
    expect(hasNext(99, 20)).toBe(false);
  });
});

describe("paginationWindow", () => {
  it("matches the reference window for a middle page", () => {
    expect(paginationWindow({ current: 5, total: 20 })).toEqual([
      1,
      "…",
      4,
      5,
      6,
      "…",
      20,
    ]);
  });

  it("lists every page when they all fit", () => {
    expect(paginationWindow({ current: 2, total: 5 })).toEqual([1, 2, 3, 4, 5]);
  });

  it("pins the boundary pages near the start", () => {
    expect(paginationWindow({ current: 1, total: 10 })).toEqual([
      1,
      2,
      3,
      4,
      5,
      "…",
      10,
    ]);
  });

  it("pins the boundary pages near the end", () => {
    expect(paginationWindow({ current: 10, total: 10 })).toEqual([
      1,
      "…",
      6,
      7,
      8,
      9,
      10,
    ]);
  });

  it("honours a wider boundary", () => {
    expect(paginationWindow({ current: 5, total: 20, boundary: 2 })).toEqual([
      1,
      2,
      3,
      4,
      5,
      6,
      "…",
      19,
      20,
    ]);
  });

  it("honours the sibling count around the current page", () => {
    expect(paginationWindow({ current: 6, total: 20, siblings: 0 })).toEqual([
      1,
      "…",
      6,
      "…",
      20,
    ]);
    expect(paginationWindow({ current: 10, total: 20, siblings: 2 })).toEqual([
      1,
      "…",
      8,
      9,
      10,
      11,
      12,
      "…",
      20,
    ]);
  });

  it("clamps an out-of-range current page", () => {
    expect(paginationWindow({ current: 999, total: 20 })).toEqual([
      1,
      "…",
      16,
      17,
      18,
      19,
      20,
    ]);
  });

  it("treats negative siblings/boundary as zero", () => {
    expect(
      paginationWindow({ current: 6, total: 20, siblings: -1, boundary: -2 }),
    ).toEqual(["…", 6, "…"]);
  });

  it("returns nothing for a non-positive total", () => {
    expect(paginationWindow({ current: 1, total: 0 })).toEqual([]);
    expect(paginationWindow({ current: 1, total: -7 })).toEqual([]);
  });

  it("returns the single page for a one-page document", () => {
    expect(paginationWindow({ current: 1, total: 1 })).toEqual([1]);
  });

  it("is pure and deterministic (never mutates options, stable across calls)", () => {
    const options = { current: 5, total: 20 };
    const first = paginationWindow(options);
    const second = paginationWindow(options);
    expect(first).toEqual(second);
    expect(options).toEqual({ current: 5, total: 20 });
  });

  it("exposes the ellipsis marker as a shared constant", () => {
    expect(PAGINATION_ELLIPSIS).toBe("…");
    expect(paginationWindow({ current: 5, total: 20 })[1]).toBe(
      PAGINATION_ELLIPSIS,
    );
  });
});
