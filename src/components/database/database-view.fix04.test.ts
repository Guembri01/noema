import { describe, expect, it } from "vitest";
import {
  SUB_ISSUE_MAX_DEPTH,
  buildRelationState,
  layoutSubIssues,
  mutualRelationCount,
  planRelationWrite,
  rollupCellFromPairs,
  toSubIssueEdges,
} from "./database-view";
import type { DBProperty, DBRow } from "@/components/database/database-types";
import type { QueryRow } from "@/lib/database-query";
import type { RelationData } from "@/server/queries";

/**
 * fix04 — the additive bridges from `database-view.tsx` onto the newer
 * `@/lib/sub-issues` (R89.30/31), `@/lib/relation-pairs` and
 * `@/lib/rollup-config` engines. The JSX is not node-rendered here (no DOM);
 * the *pure* mappings the component routes through are exported for exactly
 * this: tree → rows, rollup config → value, and the two-way relation write plan.
 */

const queryRow = (
  id: string,
  parentId: string | null,
  order?: number,
  extra: Partial<QueryRow> = {},
): QueryRow & { parentId: string | null; order?: number } => ({
  id,
  title: id,
  icon: null,
  propertyValues: [],
  parentId,
  ...(order === undefined ? {} : { order }),
  ...extra,
});

const property = (id: string, type: string, config?: unknown): DBProperty =>
  ({ id, name: id, type, config: config ?? null }) as unknown as DBProperty;

const row = (id: string, propertyValues: { propertyId: string; value: unknown }[]): DBRow =>
  ({ id, title: id, icon: null, propertyValues }) as DBRow;

describe("toSubIssueEdges — dependency edges into the sub-issues vocabulary", () => {
  it("maps `from` blocks `to` onto blocker/blocked ids", () => {
    expect(toSubIssueEdges([{ from: "x", to: "y" }])).toEqual([
      { blockerId: "x", blockedId: "y" },
    ]);
    expect(toSubIssueEdges([])).toEqual([]);
  });
});

describe("layoutSubIssues — tree → render rows + roll-up", () => {
  const rows = [
    queryRow("a", null, 1000),
    queryRow("b", null, 2000),
    queryRow("b1", "b", 1000),
    queryRow("b2", "b", 2000),
    queryRow("c", "ghost", 1000),
  ];

  it("nests by parentId and orders siblings by `order`", () => {
    const layout = layoutSubIssues(rows, [], { maxDepth: 2 });
    expect(layout.rows.map((entry) => entry.id)).toEqual(["a", "b", "b1", "b2", "c"]);
  });

  it("appends rows the tree cannot place so nothing is dropped", () => {
    const layout = layoutSubIssues(rows, [], { maxDepth: 2 });
    expect(layout.orphans).toEqual(["c"]);
    expect(layout.rows.at(-1)?.id).toBe("c");
  });

  it("hides the descendants of a collapsed row but keeps the row", () => {
    const layout = layoutSubIssues(rows, ["b"], { maxDepth: 2 });
    expect(layout.rows.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("enforces the depth cap, surfacing deeper rows as orphans", () => {
    const layout = layoutSubIssues(rows, [], { maxDepth: 0 });
    expect(layout.rows.map((entry) => entry.id)).toEqual(["a", "b", "b1", "b2", "c"]);
    expect(layout.orphans.sort()).toEqual(["b1", "b2", "c"]);
  });

  it("rolls estimates and done state up the subtree", () => {
    const estimated = [
      { id: "epic", parentId: null, order: 1000, estimate: 8, done: false },
      { id: "s1", parentId: "epic", order: 1000, estimate: 3, done: true },
      { id: "s2", parentId: "epic", order: 2000, estimate: 5, done: false },
    ] as unknown as (QueryRow & { parentId: string | null; order?: number })[];
    const layout = layoutSubIssues(estimated, [], { maxDepth: 2 });
    expect(layout.rollups.get("epic")).toMatchObject({
      own: 8,
      childrenTotal: 8,
      total: 16,
      done: 1,
      count: 3,
    });
  });

  it("exposes the default depth cap constant", () => {
    expect(SUB_ISSUE_MAX_DEPTH).toBeGreaterThanOrEqual(1);
  });
});

describe("relation state + rollup cell — config → value", () => {
  const properties = [
    property("rel", "RELATION", { targetDatabaseId: "db-target" }),
    property("roll", "ROLLUP", {
      relationPropertyId: "rel",
      targetPropertyId: "points",
      function: "sum",
    }),
  ];
  const rows = [
    row("a1", [{ propertyId: "rel", value: { pageIds: ["b1", "b2"] } }]),
  ];
  const relationData: Record<string, RelationData> = {
    rel: {
      options: [],
      valuesByRow: {
        b1: { points: { number: 10 } },
        b2: { points: { number: 20 } },
      },
      properties: [{ id: "points", name: "Points", type: "NUMBER" }],
    },
  };
  const built = buildRelationState({ databaseId: "db-a", properties, rows, relationData });

  it("computes a numeric rollup over the linked target rows", () => {
    expect(
      rollupCellFromPairs(built.state, "a1", {
        relationPropertyId: "rel",
        targetPropertyId: "points",
        function: "sum",
      }),
    ).toBe("30");
    expect(
      rollupCellFromPairs(built.state, "a1", {
        relationPropertyId: "rel",
        targetPropertyId: "points",
        function: "avg",
      }),
    ).toBe("15");
    expect(
      rollupCellFromPairs(built.state, "a1", {
        relationPropertyId: "rel",
        targetPropertyId: "points",
        function: "unique",
      }),
    ).toBe("2");
  });

  it("returns null for functions outside the mapped subset (caller falls back)", () => {
    expect(
      rollupCellFromPairs(built.state, "a1", {
        relationPropertyId: "rel",
        targetPropertyId: "points",
        function: "count",
      }),
    ).toBeNull();
    expect(
      rollupCellFromPairs(built.state, "a1", {
        relationPropertyId: "",
        targetPropertyId: "points",
        function: "sum",
      }),
    ).toBeNull();
  });

  it("renders an em dash when the relation links to nothing", () => {
    expect(
      rollupCellFromPairs(built.state, "missing", {
        relationPropertyId: "rel",
        targetPropertyId: "points",
        function: "sum",
      }),
    ).toBe("—");
  });
});

describe("planRelationWrite — two-way link/unlink", () => {
  const properties = [property("rel", "RELATION", { targetDatabaseId: "db-target" })];
  const rows = [row("a1", [{ propertyId: "rel", value: { pageIds: ["b1"] } }])];

  it("reconciles the source side and reports the plain single write", () => {
    const relationData: Record<string, RelationData> = {
      rel: {
        options: [],
        valuesByRow: { b1: {}, b2: {} },
        properties: [{ id: "points", name: "Points", type: "NUMBER" }],
      },
    };
    const built = buildRelationState({ databaseId: "db-a", properties, rows, relationData });
    const plan = planRelationWrite(built.state, built.pairs, properties[0], "a1", {
      pageIds: ["b2"],
    });
    expect(plan).not.toBeNull();
    expect(plan?.writes).toEqual([
      { rowId: "a1", propertyId: "rel", value: { pageIds: ["b2"] } },
    ]);
  });

  it("emits the far-side write when a real inverse relation exists", () => {
    const relationData: Record<string, RelationData> = {
      rel: {
        options: [],
        valuesByRow: { b1: {} },
        properties: [{ id: "back", name: "Back", type: "RELATION" }],
      },
    };
    const built = buildRelationState({
      databaseId: "db-a",
      properties,
      rows: [row("a1", [{ propertyId: "rel", value: { pageIds: [] } }])],
      relationData,
    });
    const plan = planRelationWrite(built.state, built.pairs, properties[0], "a1", {
      pageIds: ["b1"],
    });
    expect(plan?.writes).toContainEqual({
      rowId: "b1",
      propertyId: "back",
      value: { pageIds: ["a1"] },
    });
    expect(plan?.writes[0]).toEqual({
      rowId: "a1",
      propertyId: "rel",
      value: { pageIds: ["b1"] },
    });
  });

  it("returns null for an unpaired property so the caller keeps the plain write", () => {
    const relationData: Record<string, RelationData> = {};
    const built = buildRelationState({ databaseId: "db-a", properties, rows, relationData });
    const other = property("other", "TEXT");
    expect(planRelationWrite(built.state, built.pairs, other, "a1", {})).toBeNull();
  });
});

describe("mutualRelationCount — reciprocal edges stored on both sides", () => {
  const properties = [property("rel", "RELATION", { targetDatabaseId: "db-target" })];
  const rows = [row("a1", [{ propertyId: "rel", value: { pageIds: ["b1"] } }])];
  const relationData: Record<string, RelationData> = {
    rel: {
      options: [],
      valuesByRow: { b1: { back: { pageIds: ["a1"] } } },
      properties: [{ id: "back", name: "Back", type: "RELATION" }],
    },
  };

  it("counts an edge only when both directions are stored", () => {
    const built = buildRelationState({ databaseId: "db-a", properties, rows, relationData });
    const pairId = built.pairs["rel"].pairId;
    expect(mutualRelationCount(built.state, pairId, "a1")).toBe(1);
    expect(mutualRelationCount(built.state, pairId, "b1")).toBe(0);
  });

  it("reports nothing for a one-sided link", () => {
    const oneSided = buildRelationState({
      databaseId: "db-a",
      properties,
      rows,
      relationData: {
        rel: {
          options: [],
          valuesByRow: { b1: {} },
          properties: [{ id: "back", name: "Back", type: "RELATION" }],
        },
      },
    });
    expect(mutualRelationCount(oneSided.state, oneSided.pairs["rel"].pairId, "a1")).toBe(0);
  });
});
