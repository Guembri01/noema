import { describe, expect, it } from "vitest";
import { EMPTY_GROUP_LABEL } from "@/lib/aggregations";
import type { BoardRow } from "@/lib/board-groups";
import {
  SWIMLANE_EMPTY_KEY,
  buildSwimlanes,
  collapseLane,
  laneCounts,
  swimlaneSummary,
  type SwimlaneMatrix,
} from "@/lib/board-swimlanes";

function row(id: string, cells: Record<string, unknown> = {}): BoardRow {
  return {
    id,
    propertyValues: Object.entries(cells).map(([propertyId, value]) => ({ propertyId, value })),
  };
}

const idsIn = (matrix: SwimlaneMatrix, laneKey: string, columnKey: string): string[] => {
  const lane = matrix.lanes.find((entry) => entry.key === laneKey);
  const bucket = lane?.buckets.find((entry) => entry.columnKey === columnKey);
  return bucket ? bucket.rows.map((entry) => entry.id) : [];
};

// status (lane) x priority (column). Empty lane holds r4 + r6; empty column
// holds r4 + r5.
const rows: BoardRow[] = [
  row("r1", { status: { optionId: "todo" }, priority: "high", tags: { optionIds: ["web"] } }),
  row("r2", { status: { optionId: "done" }, priority: "low" }),
  row("r3", { status: { optionId: "todo" }, priority: "high", tags: { optionIds: ["web", "api"] } }),
  row("r4"),
  row("r5", { status: { optionId: "doing" } }),
  row("r6", { priority: "high" }),
];

const matrix = buildSwimlanes(rows, "status", "priority");

describe("buildSwimlanes — lanes × columns matrix", () => {
  it("orders lanes and columns by first appearance, Empty last", () => {
    expect(matrix.laneKeys).toEqual(["todo", "done", "doing", SWIMLANE_EMPTY_KEY]);
    expect(matrix.columnKeys).toEqual(["high", "low", SWIMLANE_EMPTY_KEY]);
    expect(matrix.lanes.map((lane) => lane.key)).toEqual(matrix.laneKeys);
    expect(matrix.lanes[0].buckets.map((bucket) => bucket.columnKey)).toEqual(matrix.columnKeys);
    expect(matrix.lanes[0].label).toBe("todo");
    expect(matrix.lanes[3].label).toBe(EMPTY_GROUP_LABEL);
  });

  it("routes rows into the right bucket, preserving input order", () => {
    expect(idsIn(matrix, "todo", "high")).toEqual(["r1", "r3"]);
    expect(idsIn(matrix, "done", "low")).toEqual(["r2"]);
    expect(idsIn(matrix, "doing", SWIMLANE_EMPTY_KEY)).toEqual(["r5"]);
    expect(idsIn(matrix, SWIMLANE_EMPTY_KEY, "high")).toEqual(["r6"]);
    expect(idsIn(matrix, SWIMLANE_EMPTY_KEY, SWIMLANE_EMPTY_KEY)).toEqual(["r4"]);
    expect(idsIn(matrix, "todo", "low")).toEqual([]);
    expect(matrix.lanes[0].buckets[0].laneKey).toBe("todo");
  });

  it("does not mutate the input rows and reuses the same row objects", () => {
    const snapshot = rows.map((entry) => entry.id);
    const rebuilt = buildSwimlanes(rows, "status", "priority");
    expect(rows.map((entry) => entry.id)).toEqual(snapshot);
    expect(rebuilt.lanes[0].buckets[0].rows[0]).toBe(rows[0]);
  });

  it("places a multi-select row in every matching lane", () => {
    const multi = buildSwimlanes(rows, "tags", "status");
    expect(multi.laneKeys).toEqual(["web", "api", SWIMLANE_EMPTY_KEY]);
    expect(multi.columnKeys).toEqual(["todo", "done", "doing", SWIMLANE_EMPTY_KEY]);
    expect(multi.lanes).toHaveLength(3);
    expect(idsIn(multi, "web", "todo")).toEqual(["r1", "r3"]);
    expect(idsIn(multi, "api", "todo")).toEqual(["r3"]);
    expect(idsIn(multi, SWIMLANE_EMPTY_KEY, "done")).toEqual(["r2"]);
    expect(idsIn(multi, "api", SWIMLANE_EMPTY_KEY)).toEqual([]);
  });

  it("cross-products multi-select lanes and columns, deduplicating repeated keys", () => {
    const cross = buildSwimlanes(
      [row("c1", { tags: { optionIds: ["web", "web", "api"] }, labels: { optionIds: ["x", "y"] } })],
      "tags",
      "labels",
    );
    expect(cross.laneKeys).toEqual(["web", "api"]);
    expect(cross.columnKeys).toEqual(["x", "y"]);
    expect(idsIn(cross, "web", "x")).toEqual(["c1"]);
    expect(idsIn(cross, "web", "y")).toEqual(["c1"]);
    expect(idsIn(cross, "api", "x")).toEqual(["c1"]);
    expect(idsIn(cross, "api", "y")).toEqual(["c1"]);
  });

  it("reads object-backed and primitive header values alike", () => {
    const mixed = buildSwimlanes(
      [
        row("m1", { text: { text: "Alpha" }, points: { number: 3 } }),
        row("m2", { text: "Beta", points: 3 }),
      ],
      "text",
      "points",
    );
    expect(mixed.laneKeys).toEqual(["Alpha", "Beta"]);
    expect(mixed.columnKeys).toEqual(["3"]);
    expect(idsIn(mixed, "Beta", "3")).toEqual(["m2"]);
  });

  it("falls back to one Empty lane × Empty column for unknown properties", () => {
    const unknown = buildSwimlanes(rows, "nope", "also-missing");
    expect(unknown.laneKeys).toEqual([SWIMLANE_EMPTY_KEY]);
    expect(unknown.columnKeys).toEqual([SWIMLANE_EMPTY_KEY]);
    expect(unknown.lanes[0].buckets[0].rows.map((entry) => entry.id)).toEqual([
      "r1",
      "r2",
      "r3",
      "r4",
      "r5",
      "r6",
    ]);
  });

  it("returns an empty matrix for empty input", () => {
    expect(buildSwimlanes([], "a", "b")).toEqual({ laneKeys: [], columnKeys: [], lanes: [] });
  });
});

describe("laneCounts", () => {
  it("counts distinct rows per lane in lane order", () => {
    expect(laneCounts(matrix)).toEqual([
      { key: "todo", label: "todo", count: 2 },
      { key: "done", label: "done", count: 1 },
      { key: "doing", label: "doing", count: 1 },
      { key: SWIMLANE_EMPTY_KEY, label: EMPTY_GROUP_LABEL, count: 2 },
    ]);
  });

  it("does not double-count a multi-select row spread across columns", () => {
    const multi = buildSwimlanes(rows, "tags", "status");
    expect(laneCounts(multi)[0]).toEqual({ key: "web", label: "web", count: 2 });
    expect(laneCounts(multi)[1]).toEqual({ key: "api", label: "api", count: 1 });
    expect(laneCounts(multi)[2].count).toBe(4);
  });

  it("handles empty input and does not mutate the matrix", () => {
    const snapshot = JSON.stringify(matrix);
    expect(laneCounts(buildSwimlanes([], "a", "b"))).toEqual([]);
    expect(JSON.stringify(matrix)).toBe(snapshot);
  });
});

describe("swimlaneSummary", () => {
  it("summarizes the matrix shape and finds the largest bucket", () => {
    const summary = swimlaneSummary(matrix);
    expect(summary.laneCount).toBe(4);
    expect(summary.columnCount).toBe(3);
    expect(summary.bucketCount).toBe(12);
    expect(summary.filledBuckets).toBe(5);
    expect(summary.emptyBuckets).toBe(7);
    expect(summary.rowCount).toBe(6);
    expect(summary.largestBucket).toEqual({ laneKey: "todo", columnKey: "high", count: 2 });
  });

  it("breaks bucket-size ties by lane then column order", () => {
    const multi = buildSwimlanes(rows, "tags", "status");
    const summary = swimlaneSummary(multi);
    expect(summary.laneCount).toBe(3);
    expect(summary.columnCount).toBe(4);
    expect(summary.bucketCount).toBe(12);
    expect(summary.filledBuckets).toBe(5);
    expect(summary.rowCount).toBe(6);
    expect(summary.largestBucket).toEqual({ laneKey: "web", columnKey: "todo", count: 2 });
  });

  it("handles empty input and does not mutate the matrix", () => {
    expect(swimlaneSummary(buildSwimlanes([], "a", "b"))).toEqual({
      laneCount: 0,
      columnCount: 0,
      bucketCount: 0,
      filledBuckets: 0,
      emptyBuckets: 0,
      rowCount: 0,
      largestBucket: null,
    });
    const snapshot = JSON.stringify(matrix);
    swimlaneSummary(matrix);
    expect(JSON.stringify(matrix)).toBe(snapshot);
  });
});

describe("collapseLane", () => {
  it("flattens a lane across its columns in column order", () => {
    expect(collapseLane(matrix, "doing").map((entry) => entry.id)).toEqual(["r5"]);
    expect(collapseLane(matrix, SWIMLANE_EMPTY_KEY).map((entry) => entry.id)).toEqual([
      "r6",
      "r4",
    ]);
  });

  it("de-duplicates a row that appears in several columns of one lane", () => {
    const cross = buildSwimlanes(
      [row("c1", { tags: { optionIds: ["web"] }, labels: { optionIds: ["x", "y"] } })],
      "tags",
      "labels",
    );
    const collapsed = collapseLane(cross, "web");
    expect(collapsed.map((entry) => entry.id)).toEqual(["c1"]);
    expect(collapsed[0]).toBe(cross.lanes[0].buckets[0].rows[0]);
  });

  it("returns [] for an unknown lane and does not mutate the matrix", () => {
    const snapshot = JSON.stringify(matrix);
    expect(collapseLane(matrix, "nope")).toEqual([]);
    expect(JSON.stringify(matrix)).toBe(snapshot);
  });
});
