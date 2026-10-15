import { describe, expect, it } from "vitest";
import {
  buildIntervals,
  insert,
  maxOverlap,
  mergeIntervals,
  queryOverlaps,
  remove,
  type Interval,
} from "./interval-tree";

/**
 * H2-interval-tree — pure interval utilities over half-open `[start, end)`
 * numeric spans.
 *
 * Written RED-first against a stub, then implemented. Coverage pins:
 * - `buildIntervals` projects items through `{ startOf, endOf }` into a
 *   deterministic, sorted list that keeps the source item,
 * - half-open overlap: `start` is contained, `end` is not, so touching spans
 *   never overlap (they may still coalesce in `mergeIntervals`),
 * - point vs range probes, stable ordering and empty results,
 * - `insert`/`remove` are immutable and keep the list sorted,
 * - `maxOverlap` counts concurrent spans, ends processed before starts so
 *   back-to-back spans do not double-count; empty spans cover nothing,
 * - `mergeIntervals` coalesces overlapping **or touching** spans,
 * - fixed numeric inputs only — no clocks, no `Date`, so results are identical
 *   on every machine and every run.
 */

type Meeting = { id: string; from: number; to: number };

const meeting = (id: string, from: number, to: number): Meeting => ({ id, from, to });

const iv = (start: number, end: number): Interval => ({ start, end });

const bounds = (list: readonly Interval[]): [number, number][] =>
  list.map((interval) => [interval.start, interval.end]);

const accessors = {
  startOf: (m: Meeting) => m.from,
  endOf: (m: Meeting) => m.to,
};

describe("buildIntervals", () => {
  it("maps items via the accessors into sorted intervals that keep the item", () => {
    const items = [meeting("c", 5, 8), meeting("a", 1, 4), meeting("b", 2, 6)];
    const built = buildIntervals(items, accessors);
    expect(bounds(built)).toEqual([
      [1, 4],
      [2, 6],
      [5, 8],
    ]);
    expect(built.map((entry) => entry.item.id)).toEqual(["a", "b", "c"]);
  });

  it("is stable for equal bounds: input order breaks the tie", () => {
    const built = buildIntervals(
      [meeting("x", 1, 3), meeting("y", 1, 3), meeting("z", 0, 2)],
      accessors,
    );
    expect(built.map((entry) => entry.item.id)).toEqual(["z", "x", "y"]);
  });

  it("returns a new array and never mutates the input", () => {
    const items = [meeting("c", 5, 8), meeting("a", 1, 4)];
    const built = buildIntervals(items, accessors);
    expect(built).not.toBe(items);
    expect(items.map((entry) => entry.id)).toEqual(["c", "a"]);
  });

  it("rejects invalid bounds with a RangeError", () => {
    expect(() => buildIntervals([meeting("bad", 0, Number.NaN)], accessors)).toThrow(RangeError);
    expect(() => buildIntervals([meeting("rev", 5, 1)], accessors)).toThrow(RangeError);
  });
});

describe("queryOverlaps — point probe", () => {
  const list = [iv(0, 10), iv(10, 20), iv(20, 30)];

  it("contains the start boundary but not the end boundary (half-open)", () => {
    expect(bounds(queryOverlaps(list, 0))).toEqual([[0, 10]]);
    expect(bounds(queryOverlaps(list, 10))).toEqual([[10, 20]]);
    expect(bounds(queryOverlaps(list, 30))).toEqual([]);
  });

  it("returns nothing for a point in a gap", () => {
    expect(queryOverlaps([iv(0, 4), iv(10, 14)], 7)).toEqual([]);
  });

  it("returns matches in the stored order", () => {
    expect(bounds(queryOverlaps([iv(20, 30), iv(0, 10), iv(10, 20)], 15))).toEqual([[10, 20]]);
  });
});

describe("queryOverlaps — range probe", () => {
  it("excludes touching ranges (half-open)", () => {
    const list = [iv(0, 5), iv(5, 10), iv(10, 15)];
    expect(bounds(queryOverlaps(list, iv(5, 10)))).toEqual([[5, 10]]);
  });

  it("returns every interval the probe intersects", () => {
    const list = [iv(0, 5), iv(5, 10), iv(10, 15)];
    expect(bounds(queryOverlaps(list, iv(2, 12)))).toEqual([
      [0, 5],
      [5, 10],
      [10, 15],
    ]);
  });

  it("matches a nested interval and returns nothing between intervals", () => {
    expect(bounds(queryOverlaps([iv(2, 4)], iv(0, 10)))).toEqual([[2, 4]]);
    expect(queryOverlaps([iv(0, 1), iv(5, 6)], iv(2, 3))).toEqual([]);
  });
});

describe("insert", () => {
  it("inserts into sorted position and returns a new array", () => {
    const base = [iv(0, 5), iv(10, 15)];
    const next = insert(base, iv(5, 10));
    expect(bounds(next)).toEqual([
      [0, 5],
      [5, 10],
      [10, 15],
    ]);
    expect(next).not.toBe(base);
    expect(bounds(base)).toEqual([
      [0, 5],
      [10, 15],
    ]);
  });

  it("keeps the new interval after an existing equal-start tie (stable)", () => {
    expect(bounds(insert([iv(5, 6)], iv(5, 8)))).toEqual([
      [5, 6],
      [5, 8],
    ]);
  });

  it("rejects an invalid interval", () => {
    expect(() => insert([iv(0, 5)], iv(9, 2))).toThrow(RangeError);
  });
});

describe("remove", () => {
  it("removes matching intervals and returns a new array", () => {
    const base = [iv(0, 5), iv(5, 10), iv(10, 15)];
    const next = remove(base, iv(5, 10));
    expect(bounds(next)).toEqual([
      [0, 5],
      [10, 15],
    ]);
    expect(next).not.toBe(base);
    expect(bounds(base)).toEqual([
      [0, 5],
      [5, 10],
      [10, 15],
    ]);
  });

  it("removes every interval sharing the same bounds; leaves others alone", () => {
    expect(bounds(remove([iv(1, 2), iv(1, 2), iv(3, 4)], iv(1, 2)))).toEqual([[3, 4]]);
    expect(bounds(remove([iv(0, 1)], iv(5, 6)))).toEqual([[0, 1]]);
  });
});

describe("maxOverlap", () => {
  it("is 0 for no intervals and 1 for a single one", () => {
    expect(maxOverlap([])).toBe(0);
    expect(maxOverlap([iv(1, 2)])).toBe(1);
  });

  it("counts three mutually overlapping spans", () => {
    expect(maxOverlap([iv(0, 10), iv(1, 3), iv(2, 4)])).toBe(3);
  });

  it("does not count touching spans and counts a nested span", () => {
    expect(maxOverlap([iv(0, 5), iv(5, 10)])).toBe(1);
    expect(maxOverlap([iv(0, 10), iv(2, 4)])).toBe(2);
  });

  it("ignores zero-length spans, which cover no instant", () => {
    expect(maxOverlap([iv(5, 5)])).toBe(0);
    expect(maxOverlap([iv(0, 10), iv(5, 5)])).toBe(1);
  });

  it("finds the peak across a mixed set", () => {
    expect(maxOverlap([iv(1, 4), iv(2, 6), iv(5, 8), iv(7, 9)])).toBe(2);
  });
});

describe("mergeIntervals", () => {
  it("coalesces overlapping and touching spans, sorted", () => {
    expect(bounds(mergeIntervals([iv(1, 4), iv(3, 6), iv(6, 9), iv(11, 12)]))).toEqual([
      [1, 9],
      [11, 12],
    ]);
  });

  it("absorbs a nested span and keeps an isolated zero-length span", () => {
    expect(bounds(mergeIntervals([iv(0, 10), iv(2, 4)]))).toEqual([[0, 10]]);
    expect(bounds(mergeIntervals([iv(5, 5)]))).toEqual([[5, 5]]);
  });

  it("sorts disjoint spans into a new array", () => {
    const input = [iv(5, 6), iv(1, 2)];
    const merged = mergeIntervals(input);
    expect(bounds(merged)).toEqual([
      [1, 2],
      [5, 6],
    ]);
    expect(merged).not.toBe(input);
  });
});

describe("determinism", () => {
  it("produces identical results across repeated calls", () => {
    const input = [iv(3, 7), iv(1, 2), iv(6, 9), iv(2, 4)];
    expect(mergeIntervals(input)).toEqual(mergeIntervals(input));
    expect(maxOverlap(input)).toBe(maxOverlap(input));
  });
});
