import { describe, expect, it } from "vitest";
import {
  ORDER_STEP,
  needsRenumber,
  normalizeOrders,
  orderForInsertBetween,
  renumberOrders,
  reorderRows,
  sortByOrder,
} from "./row-order";

/**
 * Row reordering — the pure core of a manual order property
 * (MISSING_FEATURES §3; database-deep R89.19).
 *
 * Red-first: `src/lib/row-order.ts` did not exist when this suite was written,
 * so it fails on the missing module until the helper lands. The persisted
 * numbering mirrors the rest of the codebase's `Page.position` convention — a
 * sparse 1000-step integer scale (`(index + 1) * 1000`, insert = `last + 1000`)
 * that leaves room for midpoint inserts — so these helpers must be provable
 * without a DB, a route or React.
 */

type Row = { id: string; order?: number | null };

const row = (id: string, order?: number | null): Row => ({ id, order });
const ids = (rows: readonly { id: string }[]): string[] => rows.map((r) => r.id);
const orders = (rows: readonly { order?: number | null }[]): Array<number | null | undefined> =>
  rows.map((r) => r.order);

describe("reorderRows", () => {
  it("moves an item down by one", () => {
    expect(reorderRows(["a", "b", "c", "d"], 0, 1)).toEqual(["b", "a", "c", "d"]);
  });

  it("moves an item up by one", () => {
    expect(reorderRows(["a", "b", "c", "d"], 2, 1)).toEqual(["a", "c", "b", "d"]);
  });

  it("moves an item several positions at once", () => {
    expect(reorderRows(["a", "b", "c", "d", "e"], 1, 4)).toEqual(["a", "c", "d", "e", "b"]);
  });

  it("moves the first item to the last position", () => {
    expect(reorderRows(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });

  it("moves the last item to the first position", () => {
    expect(reorderRows(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("clamps a toIndex past the end to move-to-back", () => {
    expect(reorderRows(["a", "b", "c"], 1, 99)).toEqual(["a", "c", "b"]);
  });

  it("returns an equal copy when fromIndex equals toIndex", () => {
    const list = ["a", "b", "c"];
    const moved = reorderRows(list, 1, 1);
    expect(moved).toEqual(list);
    expect(moved).not.toBe(list);
  });

  it("leaves the order unchanged when fromIndex is out of bounds", () => {
    expect(reorderRows(["a", "b"], 5, 0)).toEqual(["a", "b"]);
    expect(reorderRows(["a", "b"], -1, 1)).toEqual(["a", "b"]);
  });

  it("leaves the order unchanged when an index is not an integer or is NaN", () => {
    expect(reorderRows(["a", "b"], 0.5, 1)).toEqual(["a", "b"]);
    expect(reorderRows(["a", "b"], 0, Number.NaN)).toEqual(["a", "b"]);
  });

  it("handles empty and single-item lists", () => {
    expect(reorderRows([], 0, 0)).toEqual([]);
    const single = ["a"];
    const moved = reorderRows(single, 0, 0);
    expect(moved).toEqual(["a"]);
    expect(moved).not.toBe(single);
  });

  it("does not mutate the input array", () => {
    const list = ["a", "b", "c"];
    const snapshot = [...list];
    reorderRows(list, 0, 2);
    expect(list).toEqual(snapshot);
  });
});

describe("renumberOrders", () => {
  it("assigns 1000, 2000, 3000… in the given sequence", () => {
    const rows = renumberOrders([row("a"), row("b"), row("c")]);
    expect(orders(rows)).toEqual([1000, 2000, 3000]);
  });

  it("spaces every assigned order by ORDER_STEP", () => {
    const rows = renumberOrders([row("a"), row("b"), row("c"), row("d")]);
    expect(ORDER_STEP).toBe(1000);
    expect(orders(rows)).toEqual([1000, 2000, 3000, 4000]);
  });

  it("preserves the input sequence rather than sorting by the old order", () => {
    const rows = renumberOrders([row("c", 1000), row("a", 9000), row("b", 5000)]);
    expect(ids(rows)).toEqual(["c", "a", "b"]);
    expect(orders(rows)).toEqual([1000, 2000, 3000]);
  });

  it("overwrites stale, duplicate and missing orders", () => {
    const rows = renumberOrders([row("a", 7), row("b", 7), row("c")]);
    expect(orders(rows)).toEqual([1000, 2000, 3000]);
  });

  it("returns fresh row objects and never mutates the input", () => {
    const rows = [row("a", 5), row("b", 6)];
    const snapshot = rows.map((r) => ({ ...r }));
    const renumbered = renumberOrders(rows);
    expect(rows).toEqual(snapshot);
    expect(renumbered).not.toBe(rows);
    expect(renumbered[0]).not.toBe(rows[0]);
  });

  it("handles an empty list", () => {
    expect(renumberOrders([])).toEqual([]);
  });
});

describe("orderForInsertBetween", () => {
  it("returns the first order when the list is empty", () => {
    expect(orderForInsertBetween()).toBe(1000);
    expect(orderForInsertBetween(undefined, undefined)).toBe(1000);
  });

  it("treats null as a missing neighbour", () => {
    expect(orderForInsertBetween(null, null)).toBe(1000);
    expect(orderForInsertBetween(1000, null)).toBe(2000);
    expect(orderForInsertBetween(null, 1000)).toBe(500);
  });

  it("returns the midpoint between two orders", () => {
    expect(orderForInsertBetween(1000, 2000)).toBe(1500);
    expect(orderForInsertBetween(2000, 3000)).toBe(2500);
    expect(orderForInsertBetween(1000, 1500)).toBe(1250);
  });

  it("inserts before the first row at less than half the first order", () => {
    expect(orderForInsertBetween(undefined, 1000)).toBe(500);
    expect(orderForInsertBetween(undefined, 3000)).toBe(1500);
  });

  it("inserts after the last row one step later", () => {
    expect(orderForInsertBetween(1000, undefined)).toBe(2000);
    expect(orderForInsertBetween(500, undefined)).toBe(1500);
  });

  it("treats non-finite neighbours as missing", () => {
    expect(orderForInsertBetween(Number.NaN, 2000)).toBe(1000);
    expect(orderForInsertBetween(1000, Number.POSITIVE_INFINITY)).toBe(2000);
  });

  it("returns an integer even when the neighbours are only one apart", () => {
    // No room for a strict midpoint: the result collides, which is exactly
    // what needsRenumber/normalizeOrders exist to repair.
    expect(orderForInsertBetween(1000, 1001)).toBe(1000);
    expect(Number.isInteger(orderForInsertBetween(1000, 1001))).toBe(true);
  });
});

describe("normalizeOrders", () => {
  it("collapses gaps into dense 1000-steps", () => {
    const rows = normalizeOrders([row("a", 1000), row("b", 5000), row("c", 9000)]);
    expect(ids(rows)).toEqual(["a", "b", "c"]);
    expect(orders(rows)).toEqual([1000, 2000, 3000]);
  });

  it("dedupes duplicate orders while preserving relative input order", () => {
    const rows = normalizeOrders([row("c", 2000), row("a", 1000), row("b", 1000)]);
    expect(ids(rows)).toEqual(["a", "b", "c"]);
    expect(orders(rows)).toEqual([1000, 2000, 3000]);
  });

  it("keeps the input order for rows sharing an order (stable)", () => {
    const rows = normalizeOrders([row("b", 1000), row("a", 1000)]);
    expect(ids(rows)).toEqual(["b", "a"]);
    expect(orders(rows)).toEqual([1000, 2000]);
  });

  it("sorts missing orders last", () => {
    const rows = normalizeOrders([row("x"), row("a", 1000), row("b", 2000)]);
    expect(ids(rows)).toEqual(["a", "b", "x"]);
    expect(orders(rows)).toEqual([1000, 2000, 3000]);
  });

  it("returns fresh row objects and never mutates the input", () => {
    const rows = [row("b", 2000), row("a", 1000)];
    const snapshot = rows.map((r) => ({ ...r }));
    const normalized = normalizeOrders(rows);
    expect(rows).toEqual(snapshot);
    expect(normalized).not.toBe(rows);
    expect(normalized[0]).not.toBe(rows[1]);
  });

  it("is idempotent on an already-normalized list", () => {
    const first = normalizeOrders([row("a", 1000), row("b", 2000), row("c", 3000)]);
    const second = normalizeOrders(first);
    expect(orders(second)).toEqual(orders(first));
  });
});

describe("sortByOrder", () => {
  it("sorts ascending by order", () => {
    expect(ids(sortByOrder([row("c", 3000), row("a", 1000), row("b", 2000)]))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("ranks rows without an order last", () => {
    expect(ids(sortByOrder([row("x"), row("b", 2000), row("y"), row("a", 1000)]))).toEqual([
      "a",
      "b",
      "x",
      "y",
    ]);
  });

  it("breaks unpositioned ties by id ascending", () => {
    expect(ids(sortByOrder([row("z"), row("m"), row("a")]))).toEqual(["a", "m", "z"]);
  });

  it("breaks equal-order ties by id ascending", () => {
    expect(ids(sortByOrder([row("c", 1000), row("a", 1000), row("b", 1000)]))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("treats null and NaN as unpositioned", () => {
    expect(ids(sortByOrder([row("a", null), row("n", Number.NaN), row("b", 1000)]))).toEqual([
      "b",
      "a",
      "n",
    ]);
  });

  it("sorts any permutation of the same rows into the same sequence", () => {
    const a = [row("a", 2000), row("b", 1000), row("x")];
    const b = [row("x"), row("b", 1000), row("a", 2000)];
    expect(ids(sortByOrder(a))).toEqual(ids(sortByOrder(b)));
  });

  it("does not mutate the input array", () => {
    const rows = [row("b", 2000), row("a", 1000)];
    const snapshot = rows.map((r) => ({ ...r }));
    sortByOrder(rows);
    expect(rows).toEqual(snapshot);
  });
});

describe("needsRenumber", () => {
  it("returns false for an empty list", () => {
    expect(needsRenumber([])).toBe(false);
  });

  it("returns false for a clean 1000-step list", () => {
    expect(needsRenumber([row("a", 1000), row("b", 2000), row("c", 3000)])).toBe(false);
  });

  it("returns false when the values are distinct but the array is unsorted", () => {
    expect(needsRenumber([row("c", 3000), row("a", 1000), row("b", 2000)])).toBe(false);
  });

  it("returns true when two rows share an order", () => {
    expect(needsRenumber([row("a", 1000), row("b", 1000)])).toBe(true);
  });

  it("returns true when a gap is tighter than minGap", () => {
    expect(needsRenumber([row("a", 1000), row("b", 1000.5)])).toBe(true);
    expect(needsRenumber([row("a", 1000), row("b", 1001)])).toBe(false);
    expect(needsRenumber([row("a", 1000), row("b", 1001)], { minGap: 2 })).toBe(true);
  });

  it("returns true when a row has no usable order", () => {
    expect(needsRenumber([row("a", 1000), row("b")])).toBe(true);
    expect(needsRenumber([row("a", 1000), row("b", Number.NaN)])).toBe(true);
  });
});
