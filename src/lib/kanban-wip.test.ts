import { describe, expect, it } from "vitest";
import {
  EMPTY_GROUP_KEY,
  groupRowsByProperty,
  type BoardGroup,
  type BoardPropertyDescriptor,
  type BoardRow,
} from "@/lib/board-groups";
import {
  canMoveRow,
  checkWip,
  wipSummary,
  type WipLimits,
} from "@/lib/kanban-wip";

const status: BoardPropertyDescriptor = {
  id: "status",
  name: "Status",
  type: "STATUS",
  config: {
    options: [
      { id: "todo", name: "To do" },
      { id: "doing", name: "Doing" },
      { id: "done", name: "Done" },
    ],
  },
};

function row(id: string, optionId: string | null): BoardRow {
  return {
    id,
    propertyValues: optionId === null ? [] : [{ propertyId: "status", value: { optionId } }],
  };
}

// todo -> 2, doing -> 1, done -> 1, Empty -> 2
const rows: BoardRow[] = [
  row("r1", "todo"),
  row("r2", "done"),
  row("r3", "todo"),
  row("r4", null),
  row("r5", "doing"),
  row("r6", null),
];

const groups = groupRowsByProperty(rows, [status], "status");

// todo 2/2 at, doing 1/3 ok, done 1/0 over, empty unlimited
const limits: WipLimits = { todo: 2, doing: 3, done: 0 };

describe("checkWip — per-column grading", () => {
  it("grades each column ok/at/over and keeps group order", () => {
    const check = checkWip(groups, limits);
    expect(check.columns).toHaveLength(4);
    expect(check.columns[0]).toStrictEqual({ key: "todo", count: 2, limit: 2, status: "at" });
    expect(check.columns[1]).toStrictEqual({ key: "doing", count: 1, limit: 3, status: "ok" });
    expect(check.columns[2]).toStrictEqual({ key: "done", count: 1, limit: 0, status: "over" });
  });

  it("reports violations (over) and atLimit keys, and flips ok", () => {
    const check = checkWip(groups, limits);
    expect(check.violations).toEqual(["done"]);
    expect(check.atLimit).toEqual(["todo"]);
    expect(check.ok).toBe(false);
  });

  it("omits limit and reports ok for a column with no configured limit", () => {
    const check = checkWip(groups, limits);
    const empty = check.columns[3];
    expect(empty.key).toBe(EMPTY_GROUP_KEY);
    expect(empty.count).toBe(2);
    expect(empty.status).toBe("ok");
    expect(empty.limit).toBeUndefined();
    expect("limit" in empty).toBe(false);
  });

  it("treats every column as ok/unlimited without limits, and holds empty input", () => {
    const check = checkWip(groups);
    expect(check.columns.every((column) => column.status === "ok")).toBe(true);
    expect(check.columns.every((column) => column.limit === undefined)).toBe(true);
    expect(check.violations).toEqual([]);
    expect(check.atLimit).toEqual([]);
    expect(check.ok).toBe(true);
    expect(checkWip([])).toEqual({ columns: [], violations: [], atLimit: [], ok: true });
  });

  it("ignores malformed limits (negative, fractional, NaN, Infinity)", () => {
    const odd: WipLimits = { todo: -1, doing: 2.5, done: Number.NaN };
    const check = checkWip(groups, odd);
    expect(check.columns.every((column) => column.limit === undefined)).toBe(true);
    expect(check.columns.every((column) => column.status === "ok")).toBe(true);
    expect(checkWip(groups, { todo: Number.POSITIVE_INFINITY }).columns[0].limit).toBeUndefined();
  });

  it("does not mutate the groups or the limits map", () => {
    const groupsSnapshot = JSON.stringify(groups);
    const limitsSnapshot = JSON.stringify(limits);
    checkWip(groups, limits);
    expect(JSON.stringify(groups)).toBe(groupsSnapshot);
    expect(JSON.stringify(limits)).toBe(limitsSnapshot);
  });
});

describe("canMoveRow — WIP gate", () => {
  it("blocks a drop into a column that is at its limit", () => {
    // todo is 2/2 (at); r4 currently lives in Empty.
    expect(canMoveRow(groups, limits, "r4", "todo")).toBe(false);
  });

  it("blocks a drop into a column that is over its limit", () => {
    // done is 1/0 (over).
    expect(canMoveRow(groups, limits, "r1", "done")).toBe(false);
  });

  it("allows a drop into a column below its limit", () => {
    // doing is 1/3.
    expect(canMoveRow(groups, limits, "r1", "doing")).toBe(true);
  });

  it("allows an override even when the target is at/over its limit", () => {
    expect(canMoveRow(groups, limits, "r4", "todo", { override: true })).toBe(true);
    expect(canMoveRow(groups, limits, "r1", "done", { override: true })).toBe(true);
  });

  it("always allows a reorder within the row's current column", () => {
    expect(canMoveRow(groups, limits, "r1", "todo")).toBe(true);
    expect(canMoveRow(groups, limits, "r2", "done")).toBe(true);
  });

  it("allows a drop into an unlimited column", () => {
    expect(canMoveRow(groups, limits, "r1", EMPTY_GROUP_KEY)).toBe(true);
  });

  it("rejects unknown rows and unknown target columns", () => {
    expect(canMoveRow(groups, limits, "nope", "doing")).toBe(false);
    expect(canMoveRow(groups, limits, "r1", "ghost")).toBe(false);
    expect(canMoveRow(groups, limits, "nope", "ghost", { override: true })).toBe(false);
  });

  it("does not mutate the groups when gating a move", () => {
    const snapshot = JSON.stringify(groups);
    canMoveRow(groups, limits, "r1", "doing");
    canMoveRow(groups, limits, "r4", "todo");
    expect(JSON.stringify(groups)).toBe(snapshot);
  });
});

describe("wipSummary — header roll-up", () => {
  it("counts limited/unlimited columns and status tallies", () => {
    const summary = wipSummary(groups, limits);
    expect(summary.columnCount).toBe(4);
    expect(summary.limitedColumns).toBe(3);
    expect(summary.unlimitedColumns).toBe(1);
    expect(summary.okCount).toBe(1);
    expect(summary.atCount).toBe(1);
    expect(summary.overCount).toBe(1);
    expect(summary.ok).toBe(false);
  });

  it("sums excess rows and remaining capacity across limited columns", () => {
    const summary = wipSummary(groups, limits);
    // done: 1 row with limit 0 -> 1 excess. doing: 3 - 1 = 2 spare.
    expect(summary.excessRows).toBe(1);
    expect(summary.remainingCapacity).toBe(2);
  });

  it("reports an all-clear summary when nothing is over and handles no limits", () => {
    const clear = wipSummary(groups, { todo: 5, doing: 5, done: 5 });
    expect(clear.ok).toBe(true);
    expect(clear.overCount).toBe(0);
    expect(clear.excessRows).toBe(0);
    expect(clear.remainingCapacity).toBe(15 - 4);

    const none = wipSummary(groups);
    expect(none.limitedColumns).toBe(0);
    expect(none.unlimitedColumns).toBe(4);
    expect(none.ok).toBe(true);
  });

  it("handles empty input", () => {
    expect(wipSummary([], limits)).toEqual({
      columnCount: 0,
      limitedColumns: 0,
      unlimitedColumns: 0,
      okCount: 0,
      atCount: 0,
      overCount: 0,
      excessRows: 0,
      remainingCapacity: 0,
      ok: true,
    });
  });

  it("does not mutate the groups", () => {
    const snapshot = JSON.stringify(groups);
    wipSummary(groups, limits);
    expect(JSON.stringify(groups)).toBe(snapshot);
  });
});

describe("kanban-wip — integration with hand-built columns", () => {
  it("works on a bare group list and a lowered limit", () => {
    const bare: BoardGroup[] = [
      { key: "a", label: "A", optionId: "a", rows: [row("x", "a"), row("y", "a")] },
      { key: "b", label: "B", optionId: "b", rows: [] },
    ];
    const check = checkWip(bare, { a: 1, b: 0 });
    expect(check.violations).toEqual(["a"]);
    expect(check.atLimit).toEqual(["b"]);
    expect(check.ok).toBe(false);
    expect(canMoveRow(bare, { a: 1 }, "x", "b")).toBe(true);
    expect(canMoveRow(bare, { b: 0 }, "x", "b")).toBe(false);
  });
});
