import { describe, expect, it } from "vitest";
import {
  applyFilterBuilder,
  applyView,
  normalizeViewConfig,
  paginateRows,
  parseViewConfig,
  type QueryProperty,
  type QueryRow,
} from "@/lib/database-query";
import {
  makeGroup,
  makeLeaf,
  toQueryExpr,
  type FilterGroup,
} from "@/lib/filter-tree-ui";
import {
  resolveLayout,
  responsivePlan,
  type PropertyLayout,
} from "@/lib/property-layout-engine";

/**
 * Wiring tests for fix05's three previously-unwired modules:
 *
 *   - `@/lib/filter-tree-ui` — the AND/OR builder tree persists as
 *     `config.filterBuilder` (through `normalizeViewConfig`) and is lowered by
 *     `database-query`'s `applyFilterBuilder`/`applyView` through `toQueryExpr`.
 *   - `@/lib/property-layout-engine` — a page layout persists as
 *     `config.propertyLayout` and resolves to grid placements / a responsive
 *     plan.
 *   - `@/lib/pagination-window` — `paginateRows` windows a row set.
 *
 * Fixtures mirror database-query.test.ts so the integrated paths are compared
 * against the same vocabulary the flat evaluator already ships.
 */

const properties: QueryProperty[] = [
  { id: "name", name: "Name", type: "TEXT", config: { primary: true } },
  { id: "estimate", name: "Estimate", type: "NUMBER", config: null },
  {
    id: "status",
    name: "Status",
    type: "STATUS",
    config: {
      options: [
        { id: "todo", name: "To-do", color: "gray" },
        { id: "done", name: "Done", color: "green" },
      ],
    },
  },
  { id: "due", name: "Due", type: "DATE", config: null },
];

const row = (
  id: string,
  title: string,
  values: Record<string, unknown>,
): QueryRow => ({
  id,
  title,
  icon: null,
  propertyValues: Object.entries(values).map(([propertyId, value]) => ({
    propertyId,
    value,
  })),
});

const rows: QueryRow[] = [
  row("1", "Alpha", { estimate: { number: 5 }, status: { optionId: "todo" } }),
  row("2", "Beta", { estimate: { number: 2 }, status: { optionId: "done" } }),
  row("3", "Gamma", { estimate: { number: 9 }, status: { optionId: "todo" } }),
];

/** (Status is Done) OR (Estimate > 5 AND Status is To-do) → rows 2 and 3. */
const mixedTree: FilterGroup = makeGroup("or", [
  makeLeaf({ propertyId: "status", op: "is", value: "done", id: "l1" }),
  makeGroup(
    "and",
    [
      makeLeaf({ propertyId: "estimate", op: "gt", value: "5", id: "l2" }),
      makeLeaf({ propertyId: "status", op: "is", value: "to-do", id: "l3" }),
    ],
    "g1",
  ),
], "root");

describe("builder tree ⇄ config ⇄ where", () => {
  it("lowers the builder tree to a nested expression through toQueryExpr", () => {
    expect(toQueryExpr(mixedTree)).toEqual({
      OR: [
        { propertyId: "status", op: "is", value: "done" },
        {
          AND: [
            { propertyId: "estimate", op: "gt", value: "5" },
            { propertyId: "status", op: "is", value: "to-do" },
          ],
        },
      ],
    });
  });

  it("round-trips the tree through normalizeViewConfig with ids intact", () => {
    const stored = JSON.parse(
      JSON.stringify(normalizeViewConfig({ filterBuilder: mixedTree })),
    ) as { filterBuilder: FilterGroup };
    expect(stored.filterBuilder).toEqual(mixedTree);
    // The normaliser is idempotent on the persisted shape.
    expect(parseViewConfig(stored).filterBuilder).toEqual(mixedTree);
  });

  it("drops a malformed root group and malformed leaves", () => {
    expect(
      normalizeViewConfig({
        filterBuilder: { id: "root", op: "xor", children: [] },
      }).filterBuilder,
    ).toBeUndefined();
    expect(normalizeViewConfig({ filterBuilder: { id: "l", propertyId: "", op: "is" } }).filterBuilder).toBeUndefined();
    expect(
      normalizeViewConfig({
        filterBuilder: { id: "l", propertyId: "name", op: "bogus" },
      }).filterBuilder,
    ).toBeUndefined();
  });

  it("filters rows through applyFilterBuilder", () => {
    expect(applyFilterBuilder(rows, properties, mixedTree).map((r) => r.id)).toEqual([
      "2",
      "3",
    ]);
  });

  it("treats an empty root and an unknown property as neutral", () => {
    expect(applyFilterBuilder(rows, properties, makeGroup("and", [], "root"))).toBe(
      rows,
    );
    const unknown = makeGroup("and", [
      makeLeaf({ propertyId: "ghost", op: "is", value: "x", id: "l1" }),
    ], "root");
    expect(applyFilterBuilder(rows, properties, unknown).map((r) => r.id)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("gives the saved builder tree precedence in applyView", () => {
    const { rows: out } = applyView(rows, properties, {
      // A flat filter that would keep only row 1 must lose to the builder tree.
      filters: [{ propertyId: "name", operator: "contains", value: "Alpha" }],
      filterBuilder: mixedTree,
    });
    expect(out.map((r) => r.id)).toEqual(["2", "3"]);
  });
});

describe("property layout ⇄ config ⇄ resolution", () => {
  const layout: PropertyLayout = {
    columns: 2,
    order: ["name", "status", "estimate"],
    spans: { estimate: 2 },
    dividers: true,
  };

  const schema = [
    { id: "name" },
    { id: "status" },
    { id: "estimate" },
  ];

  it("persists the layout through normalizeViewConfig", () => {
    const stored = JSON.parse(
      JSON.stringify(normalizeViewConfig({ propertyLayout: layout })),
    ) as { propertyLayout: PropertyLayout };
    expect(stored.propertyLayout).toEqual(layout);
    expect(parseViewConfig(stored).propertyLayout).toEqual(layout);
  });

  it("resolves the persisted layout into two-column placements", () => {
    const persisted = parseViewConfig(
      JSON.parse(JSON.stringify(normalizeViewConfig({ propertyLayout: layout }))),
    ).propertyLayout as PropertyLayout;
    expect(resolveLayout(persisted, { properties: schema })).toEqual([
      { propertyId: "name", column: 0, span: 1, row: 0 },
      { propertyId: "status", column: 1, span: 1, row: 0 },
      { propertyId: "estimate", column: 0, span: 2, row: 1 },
    ]);
  });

  it("collapses two columns to one on a narrow viewport", () => {
    const narrow = responsivePlan(layout, { widthBucket: "narrow" });
    expect(narrow).toMatchObject({ columns: 1, collapsed: true });
    expect(responsivePlan(layout, { widthBucket: "medium" })).toMatchObject({
      columns: 2,
      collapsed: false,
    });
  });

  it("normalises a malformed saved layout (bad column count, duplicate order)", () => {
    const out = normalizeViewConfig({
      propertyLayout: { columns: 5, order: ["name", "name", "status"], spans: { name: 2 } },
    }).propertyLayout as PropertyLayout;
    expect(out.columns).toBe(1);
    expect(out.order).toEqual(["name", "status"]);
    // A span-2 entry in a one-column layout still round-trips as stored data.
    expect(out.spans).toEqual({ name: 2 });
  });
});

describe("pagination windows", () => {
  it("slices the requested page and reports the window", () => {
    const first = paginateRows(rows, 1, 2);
    expect(first.rows.map((r) => r.id)).toEqual(["1", "2"]);
    expect(first).toMatchObject({
      total: 3,
      page: 1,
      pageCount: 2,
      perPage: 2,
      range: { start: 0, end: 2 },
      hasPrev: false,
      hasNext: true,
    });
    expect(first.slots).toEqual([1, 2]);

    const second = paginateRows(rows, 2, 2);
    expect(second.rows.map((r) => r.id)).toEqual(["3"]);
    expect(second.range).toEqual({ start: 2, end: 4 });
    expect(second).toMatchObject({ hasPrev: true, hasNext: false });
  });

  it("clamps an out-of-range page to the last page", () => {
    expect(paginateRows(rows, 99, 2)).toMatchObject({ page: 2, hasNext: false });
    expect(paginateRows(rows, 0, 2)).toMatchObject({ page: 1, hasPrev: false });
  });

  it("collapses to an empty window without a positive page size", () => {
    const none = paginateRows(rows, 1, 0);
    expect(none).toMatchObject({ rows: [], pageCount: 0, perPage: 0, slots: [] });
    expect(none.rows).toEqual([]);
  });

  it("builds an ellipsised pager run for a large collection", () => {
    const many = Array.from({ length: 100 }, (_, index) =>
      row(String(index + 1), `Row ${index + 1}`, {}),
    );
    const window = paginateRows(many, 5, 10);
    expect(window.pageCount).toBe(10);
    expect(window.rows).toHaveLength(10);
    expect(window.slots).toEqual([1, "…", 4, 5, 6, "…", 10]);
  });
});
