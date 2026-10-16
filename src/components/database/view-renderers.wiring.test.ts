/**
 * Wiring acceptance for the four previously un-imported structural engines now
 * made load-bearing by the database view renderers:
 *
 *  - `@/lib/table-ops`   → `moveTableRowIds` / `insertTableRowIds` /
 *                          `deleteTableRowIds` / `moveTableColumnIds` /
 *                          `insertTableColumnIds` / `deleteTableColumnIds`
 *                          (the table's row & column affordances)
 *  - `@/lib/list-ops`    → `outlineItems` / `nextOutlineLevel`
 *                          (the list's nesting/indent model)
 *  - `@/lib/scroll-anchor` → `anchoredScrollTop`
 *                          (keeping a long list from jumping on re-measure)
 *  - `@/lib/property-layout` → `legacyPropertyColumns` / `propertyPlacements` /
 *                          `PropertyPanel` (the two-column property display)
 *
 * These are node tests: the renderer imports server actions and `next/navigation`,
 * so both are stubbed, then the pure mappings are exercised directly (plus one
 * static render of the panel to prove the layout reaches the DOM).
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/server/actions/database", () => ({
  reorderRowsAction: vi.fn(),
  createPropertyAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

import {
  anchoredScrollTop,
  deleteTableColumnIds,
  deleteTableRowIds,
  insertTableColumnIds,
  insertTableRowIds,
  legacyPropertyColumns,
  moveTableColumnIds,
  moveTableRowIds,
  nextOutlineLevel,
  outlineItems,
  propertyPlacements,
  PropertyPanel,
} from "./view-renderers";
import type { DBProperty } from "./database-types";

const properties: DBProperty[] = [
  { id: "title", name: "Title", type: "TEXT", config: { primary: true } },
  { id: "status", name: "Status", type: "SELECT", config: null },
  { id: "owner", name: "Owner", type: "TEXT", config: null },
];

describe("table renderer ⇄ @/lib/table-ops (ops → rows/cols)", () => {
  const ids = ["a", "b", "c", "d"];

  it("moves a row, clamps past-the-end to the back and guards bad indexes", () => {
    expect(moveTableRowIds(ids, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveTableRowIds(ids, 3, 99)).toEqual(["a", "b", "c", "d"]);
    expect(moveTableRowIds(ids, 9, 0)).toEqual(ids);
    expect(moveTableRowIds(ids, 0, Number.NaN)).toEqual(ids);
  });

  it("inserts a blank row and deletes one by index", () => {
    expect(insertTableRowIds(["a", "b"], 1)).toEqual(["a", "", "b"]);
    expect(insertTableRowIds([], 0)).toEqual([""]);
    expect(deleteTableRowIds(["a", "b", "c"], 1)).toEqual(["a", "c"]);
    expect(deleteTableRowIds(["a"], 0)).toEqual([]);
    expect(deleteTableRowIds(["a"], 5)).toEqual(["a"]);
  });

  it("moves, inserts and deletes columns across the id order", () => {
    expect(moveTableColumnIds(["x", "y", "z"], 2, 0)).toEqual(["z", "x", "y"]);
    expect(moveTableColumnIds(["x", "y"], 0, 9)).toEqual(["y", "x"]);
    expect(insertTableColumnIds(["x", "z"], 1)).toEqual(["x", "", "z"]);
    expect(deleteTableColumnIds(["x", "y", "z"], 1)).toEqual(["x", "z"]);
  });

  it("never mutates the id list it is given", () => {
    const input = ["a", "b", "c"];
    const snapshot = [...input];
    moveTableRowIds(input, 0, 2);
    insertTableColumnIds(input, 0);
    deleteTableRowIds(input, 1);
    expect(input).toEqual(snapshot);
  });
});

describe("list renderer ⇄ @/lib/list-ops (outline levels)", () => {
  const rows = [
    { id: "a", text: "alpha" },
    { id: "b", text: "bravo" },
    { id: "c", text: "charlie" },
  ];

  it("repairs a level run that jumps more than one step deeper", () => {
    const outline = outlineItems(rows, { a: 0, b: 3, c: 1 });
    expect(outline.map((item) => item.level)).toEqual([0, 1, 1]);
  });

  it("keeps every row at the top level without a level map", () => {
    expect(outlineItems(rows, undefined).map((item) => item.level)).toEqual([0, 0, 0]);
  });

  it("computes the next nesting level for indent/outdent", () => {
    const flat = outlineItems(rows, { a: 0, b: 0, c: 0 });
    expect(nextOutlineLevel(flat, "b", "in")).toBe(1);
    expect(nextOutlineLevel(flat, "b", "out")).toBe(0);
    // Outdenting the root (or an unknown id) stays at the top level.
    expect(nextOutlineLevel(flat, "a", "out")).toBe(0);
    expect(nextOutlineLevel(flat, "ghost", "in")).toBe(0);
  });
});

describe("renderers ⇄ @/lib/scroll-anchor (anchor → scrollTop)", () => {
  const row = (id: string, height = 40) => ({ id, height });
  const list = (ids: readonly string[], height = 40) => ids.map((id) => row(id, height));

  it("re-pins the row under the viewport when a row above it grows", () => {
    // Scrolled 50px into [40,40,40,40] → row "b", 10px down.
    const previous = list(["a", "b", "c", "d"]);
    const next = [row("a", 65), row("b"), row("c"), row("d")];
    expect(anchoredScrollTop(50, previous, next)).toBe(75);
  });

  it("follows the anchored row's id when a row above it is removed", () => {
    // Scrolled 90px → row "c" (offset 80), 10px down; "b" is filtered out.
    const previous = list(["a", "b", "c", "d"]);
    const next = list(["a", "c", "d"]);
    expect(anchoredScrollTop(90, previous, next)).toBe(50);
  });

  it("clamps to a neighbour when the anchored row itself disappears", () => {
    const previous = list(["a", "b", "c"]);
    const next = list(["a", "b"]);
    expect(anchoredScrollTop(90, previous, next)).toBe(50);
  });

  it("clamps offsets before the list and tolerates an empty previous layout", () => {
    const next = list(["a", "b"]);
    expect(anchoredScrollTop(-20, list(["a"]), next)).toBe(0);
    expect(anchoredScrollTop(50, [], next)).toBe(50);
  });
});

describe("property panel ⇄ @/lib/property-layout (layout → columns)", () => {
  it("adapts a persisted array-of-columns layout into a flat order", () => {
    const plan = legacyPropertyColumns(
      { columns: [["title", "status"], ["owner"]] },
      ["title", "status", "owner"],
    );
    expect(plan.columns).toEqual([["title", "status"], ["owner"]]);
    expect(plan.order).toEqual(["title", "status", "owner"]);
  });

  it("drops unknown and duplicate ids, and tolerates malformed JSON", () => {
    expect(
      legacyPropertyColumns(
        { columns: [["title", "ghost", "title"], ["owner"]] },
        ["title", "owner"],
      ).order,
    ).toEqual(["title", "owner"]);
    expect(legacyPropertyColumns("{not json", ["title"]).order).toEqual([]);
  });

  it("resolves the legacy layout into engine placements", () => {
    const placements = propertyPlacements(
      { columns: [["title"], ["status", "owner"]] },
      properties,
    );
    expect(
      placements.map((placement) => [placement.propertyId, placement.column, placement.row]),
    ).toEqual([
      ["title", 0, 0],
      ["status", 1, 0],
      ["owner", 0, 1],
    ]);
  });

  it("appends properties the layout never listed, in schema order", () => {
    const placements = propertyPlacements({ columns: [["status"]] }, properties);
    expect(placements.map((placement) => placement.propertyId)).toEqual([
      "status",
      "title",
      "owner",
    ]);
  });

  it("renders the persisted columns' cells", () => {
    const values: Record<string, unknown> = {
      title: { text: "Alpha" },
      status: { text: "Doing" },
      owner: { text: "Ada" },
    };
    const html = renderToStaticMarkup(
      createElement(PropertyPanel, {
        properties,
        layout: { columns: [["title"], ["status", "owner"]] },
        values: (propertyId: string) => values[propertyId],
      }),
    );
    expect(html).toContain('data-testid="property-panel"');
    expect(html).toContain('data-testid="property-Status"');
    expect(html).toContain('data-column="1"');
    expect(html).toContain("Alpha");
  });
});
