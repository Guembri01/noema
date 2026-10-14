import { describe, expect, it } from "vitest";
import { EMPTY_GROUP_LABEL, propertyValueOf } from "@/lib/aggregations";
import {
  EMPTY_GROUP_KEY,
  groupRowsByProperty,
  groupStats,
  moveRowBetweenGroups,
  reorderGroups,
  visibleGroups,
  type BoardGroup,
  type BoardPropertyDescriptor,
  type BoardRow,
} from "@/lib/board-groups";

const status: BoardPropertyDescriptor = {
  id: "status",
  name: "Status",
  type: "STATUS",
  config: {
    options: [
      { id: "todo", name: "To do", color: "gray" },
      { id: "doing", name: "Doing", color: "blue" },
      { id: "done", name: "Done", color: "green" },
    ],
  },
};

const tags: BoardPropertyDescriptor = {
  id: "tags",
  name: "Tags",
  type: "MULTI_SELECT",
  config: {
    options: [
      { id: "web", name: "Web", color: "purple" },
      { id: "api", name: "API", color: "orange" },
      { id: "infra", name: "Infra", color: "red" },
    ],
  },
};

const props: BoardPropertyDescriptor[] = [status, tags];

function row(id: string, cells: Record<string, unknown> = {}): BoardRow {
  return {
    id,
    propertyValues: Object.entries(cells).map(([propertyId, value]) => ({ propertyId, value })),
  };
}

const rows: BoardRow[] = [
  row("r1", { status: { optionId: "todo" }, tags: { optionIds: ["web"] } }),
  row("r2", { status: { optionId: "done" } }),
  row("r3", { status: { optionId: "todo" }, tags: { optionIds: ["web", "api"] } }),
  row("r4"),
  row("r5", { status: { optionId: "doing" } }),
  row("r6", { status: { optionId: "ghost" } }),
];

const keys = (groups: BoardGroup[]) => groups.map((group) => group.key);

const idsOf = (groups: BoardGroup[], key: string): string[] | undefined =>
  groups.find((group) => group.key === key)?.rows.map((entry) => entry.id);

const cellOf = (
  groups: BoardGroup[],
  key: string,
  id: string,
  propertyId: string,
): unknown => {
  const found = groups.find((group) => group.key === key)?.rows.find((entry) => entry.id === id);
  return found ? propertyValueOf(found, propertyId) : undefined;
};

describe("groupRowsByProperty — ordered option buckets", () => {
  it("emits one bucket per declared option in declared order, Empty last", () => {
    const groups = groupRowsByProperty(rows, props, "status");
    expect(keys(groups)).toEqual(["todo", "doing", "done", EMPTY_GROUP_KEY]);
    expect(groups.map((group) => group.label)).toEqual([
      "To do",
      "Doing",
      "Done",
      EMPTY_GROUP_LABEL,
    ]);
    expect(groups[0].optionId).toBe("todo");
    expect(groups[0].color).toBe("gray");
    expect(groups[3].optionId).toBeNull();
  });

  it("keeps input order inside a bucket and routes absent/unknown values to Empty", () => {
    const groups = groupRowsByProperty(rows, props, "status");
    expect(idsOf(groups, "todo")).toEqual(["r1", "r3"]);
    expect(idsOf(groups, "doing")).toEqual(["r5"]);
    expect(idsOf(groups, "done")).toEqual(["r2"]);
    expect(idsOf(groups, EMPTY_GROUP_KEY)).toEqual(["r4", "r6"]);
  });

  it("places a multi-select row in every matching bucket exactly once per bucket", () => {
    const groups = groupRowsByProperty(rows, props, "tags");
    expect(keys(groups)).toEqual(["web", "api", "infra", EMPTY_GROUP_KEY]);
    expect(idsOf(groups, "web")).toEqual(["r1", "r3"]);
    expect(idsOf(groups, "api")).toEqual(["r3"]);
    expect(idsOf(groups, "infra")).toEqual([]);
    expect(idsOf(groups, EMPTY_GROUP_KEY)).toEqual(["r2", "r4", "r5", "r6"]);
  });

  it("honours optionOrder and ignores ids that are not declared options", () => {
    const groups = groupRowsByProperty(rows, props, "status", {
      optionOrder: ["done", "todo", "nope"],
    });
    expect(keys(groups)).toEqual(["done", "todo", "doing", EMPTY_GROUP_KEY]);
  });

  it("drops empty buckets (declared and Empty) when showEmpty is false", () => {
    expect(keys(groupRowsByProperty(rows, props, "status", { showEmpty: false }))).toEqual([
      "todo",
      "doing",
      "done",
    ]);
    expect(keys(groupRowsByProperty(rows, props, "tags", { showEmpty: false }))).toEqual([
      "web",
      "api",
    ]);
    expect(keys(groupRowsByProperty([], props, "status"))).toEqual([
      "todo",
      "doing",
      "done",
      EMPTY_GROUP_KEY,
    ]);
    expect(groupRowsByProperty([], props, "status", { showEmpty: false })).toEqual([]);
  });

  it("does not mutate the input rows and reuses the same row objects", () => {
    const snapshot = rows.map((entry) => entry.id);
    const groups = groupRowsByProperty(rows, props, "status");
    expect(rows.map((entry) => entry.id)).toEqual(snapshot);
    expect(groups.find((group) => group.key === "todo")?.rows[0]).toBe(rows[0]);
  });

  it("falls back to a single Empty bucket for an unknown group property", () => {
    const groups = groupRowsByProperty(rows, props, "missing");
    expect(keys(groups)).toEqual([EMPTY_GROUP_KEY]);
    expect(idsOf(groups, EMPTY_GROUP_KEY)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6"]);
    expect(groupRowsByProperty(rows, props, "missing", { showEmpty: false })).toEqual([]);
  });
});

describe("visibleGroups", () => {
  it("hides groups explicitly marked false and keeps every other group", () => {
    const groups = groupRowsByProperty(rows, props, "status");
    expect(keys(visibleGroups(groups, { doing: false }))).toEqual([
      "todo",
      "done",
      EMPTY_GROUP_KEY,
    ]);
    expect(keys(visibleGroups(groups, {}))).toEqual(["todo", "doing", "done", EMPTY_GROUP_KEY]);
    expect(
      visibleGroups(groups, {
        todo: true,
        doing: true,
        done: true,
        [EMPTY_GROUP_KEY]: true,
      }),
    ).toHaveLength(4);
  });
});

describe("reorderGroups", () => {
  it("moves a group immediately before the target group and is immutable", () => {
    const groups = groupRowsByProperty(rows, props, "status");
    const before = keys(groups);
    const reordered = reorderGroups(groups, "done", "todo");
    expect(keys(reordered)).toEqual(["done", "todo", "doing", EMPTY_GROUP_KEY]);
    expect(keys(groups)).toEqual(before);
    expect(reordered).not.toBe(groups);
    expect(reordered[0]).toBe(groups[2]);
  });

  it("returns a fresh copy for an equal or unknown source key", () => {
    const groups = groupRowsByProperty(rows, props, "status");
    expect(keys(reorderGroups(groups, "todo", "todo"))).toEqual(keys(groups));
    expect(keys(reorderGroups(groups, "nope", "todo"))).toEqual(keys(groups));
    expect(reorderGroups(groups, "todo", "todo")).not.toBe(groups);
  });
});

describe("moveRowBetweenGroups", () => {
  it("relocates a row, appends it to the target bucket, and rewrites its value", () => {
    const groups = groupRowsByProperty(rows, props, "status");
    const moved = moveRowBetweenGroups(groups, "r1", "done", "status");
    expect(idsOf(moved, "todo")).toEqual(["r3"]);
    expect(idsOf(moved, "done")).toEqual(["r2", "r1"]);
    expect(cellOf(moved, "done", "r1", "status")).toEqual({ optionId: "done" });
    // Input is untouched.
    expect(idsOf(groups, "todo")).toEqual(["r1", "r3"]);
    expect(cellOf(groups, "todo", "r1", "status")).toEqual({ optionId: "todo" });
  });

  it("clears the value when the row is moved to the Empty bucket", () => {
    const groups = groupRowsByProperty(rows, props, "status");
    const moved = moveRowBetweenGroups(groups, "r2", EMPTY_GROUP_KEY, "status");
    expect(idsOf(moved, "done")).toEqual([]);
    expect(idsOf(moved, EMPTY_GROUP_KEY)).toEqual(["r4", "r6", "r2"]);
    expect(cellOf(moved, EMPTY_GROUP_KEY, "r2", "status")).toBeNull();
    expect(cellOf(groups, "done", "r2", "status")).toEqual({ optionId: "done" });
    expect(cellOf(moved, EMPTY_GROUP_KEY, "r2", "status")).not.toEqual({ optionId: "done" });
  });

  it("preserves the multi-select value shape and removes a row from every bucket first", () => {
    const groups = groupRowsByProperty(rows, props, "tags");
    const moved = moveRowBetweenGroups(groups, "r1", "api", "tags");
    expect(idsOf(moved, "web")).toEqual(["r3"]);
    expect(idsOf(moved, "api")).toEqual(["r3", "r1"]);
    expect(cellOf(moved, "api", "r1", "tags")).toEqual({ optionIds: ["api"] });
    const ontoEmptyRow = moveRowBetweenGroups(groups, "r2", "api", "tags");
    expect(cellOf(ontoEmptyRow, "api", "r2", "tags")).toEqual({ optionIds: ["api"] });
  });

  it("does not mutate the input groups and ignores unknown row or target keys", () => {
    const groups = groupRowsByProperty(rows, props, "status");
    const snapshot = JSON.stringify(groups);
    moveRowBetweenGroups(groups, "r1", "done", "status");
    moveRowBetweenGroups(groups, "nope", "done", "status");
    moveRowBetweenGroups(groups, "r1", "nope", "status");
    expect(JSON.stringify(groups)).toBe(snapshot);
  });
});

describe("groupStats", () => {
  it("summarizes bucket sizes, empty buckets, and the largest bucket", () => {
    const stats = groupStats(groupRowsByProperty(rows, props, "status"));
    expect(stats.groupCount).toBe(4);
    expect(stats.totalRows).toBe(6);
    expect(stats.emptyGroupCount).toBe(0);
    expect(stats.largest).toEqual({ key: "todo", label: "To do", count: 2 });
    expect(stats.counts).toEqual([
      { key: "todo", label: "To do", count: 2 },
      { key: "doing", label: "Doing", count: 1 },
      { key: "done", label: "Done", count: 1 },
      { key: EMPTY_GROUP_KEY, label: EMPTY_GROUP_LABEL, count: 2 },
    ]);
  });

  it("counts multi-select rows once per bucket and handles empty input", () => {
    const stats = groupStats(groupRowsByProperty(rows, props, "tags"));
    expect(stats.groupCount).toBe(4);
    expect(stats.totalRows).toBe(7);
    expect(stats.emptyGroupCount).toBe(1);
    expect(stats.largest).toEqual({
      key: EMPTY_GROUP_KEY,
      label: EMPTY_GROUP_LABEL,
      count: 4,
    });
    expect(groupStats([])).toEqual({
      groupCount: 0,
      totalRows: 0,
      emptyGroupCount: 0,
      largest: null,
      counts: [],
    });
  });
});
