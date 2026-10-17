import { describe, expect, it } from "vitest";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ADD_COLUMN_LABEL,
  DELETE_COLUMN_LABEL,
  TABLE_CHROME_REVEAL,
  TableAffordances,
  addColumnIndex,
  addColumnToMatrix,
  addRowIndex,
  addRowToMatrix,
  canDeleteColumn,
  canDeleteRow,
  deleteNeedsConfirm,
  gutterButtonClass,
  gutterControlPlacement,
  gutterControlStyle,
  removeColumnFromMatrix,
  removeRowFromMatrix,
  tableChromeClass,
  tableChromeVisible,
  tableCellClass,
  type TableAffordancesProps,
} from "./table";

/**
 * Pure mappings for the table's hover chrome: the index maths for `+ row` /
 * `+ column` and the delete guards, the gutter placement, the accent styling,
 * and a `renderToStaticMarkup` of a table with its affordances in the hover
 * state (and the two-step delete confirm).
 */

const renderTable = (props: Partial<TableAffordancesProps> = {}) =>
  renderToStaticMarkup(
    createElement(TableAffordances as ComponentType<TableAffordancesProps>, props),
  );

const MATRIX = [
  ["A", "B"],
  ["1", "2"],
];

describe("add-control index maths", () => {
  it("inserts after the hovered row, clamped to the end", () => {
    expect(addRowIndex(0, 2)).toBe(1);
    expect(addRowIndex(1, 2)).toBe(2);
    expect(addRowIndex(9, 2)).toBe(2);
    expect(addRowIndex(-4, 2)).toBe(0);
  });

  it("appends when there is no hovered row", () => {
    expect(addRowIndex(Number.NaN, 3)).toBe(3);
    expect(addColumnIndex(Number.NaN, 3)).toBe(3);
  });

  it("never inserts above a pinned header row", () => {
    expect(addRowIndex(0, 3, true)).toBe(1);
    expect(addRowIndex(-1, 3, true)).toBe(1);
  });

  it("inserts after the hovered column, clamped", () => {
    expect(addColumnIndex(0, 2)).toBe(1);
    expect(addColumnIndex(1, 2)).toBe(2);
    expect(addColumnIndex(9, 2)).toBe(2);
    expect(addColumnIndex(-1, 2)).toBe(0);
  });
});

describe("delete guards", () => {
  it("allows an in-range row and blocks out-of-range", () => {
    expect(canDeleteRow(0, 2)).toBe(true);
    expect(canDeleteRow(1, 2)).toBe(true);
    expect(canDeleteRow(2, 2)).toBe(false);
    expect(canDeleteRow(-1, 2)).toBe(false);
    expect(canDeleteRow(0.5, 2)).toBe(false);
  });

  it("protects the pinned header row", () => {
    expect(canDeleteRow(0, 2, true)).toBe(false);
    expect(canDeleteRow(1, 2, true)).toBe(true);
  });

  it("allows an in-range column and blocks out-of-range", () => {
    expect(canDeleteColumn(0, 2)).toBe(true);
    expect(canDeleteColumn(1, 2)).toBe(true);
    expect(canDeleteColumn(2, 2)).toBe(false);
    expect(canDeleteColumn(-1, 2)).toBe(false);
  });

  it("asks for confirmation only when the target carries content", () => {
    expect(deleteNeedsConfirm(["", "   "])).toBe(false);
    expect(deleteNeedsConfirm(["", "x"])).toBe(true);
    expect(deleteNeedsConfirm([])).toBe(false);
  });
});

describe("gutter control placement", () => {
  it("puts + row in the right gutter and + column in the bottom gutter", () => {
    const placement = gutterControlPlacement({ row: 1, column: 0, rows: 2, columns: 2 });
    expect(placement.addRow).toEqual({ edge: "right", index: 2 });
    expect(placement.addColumn).toEqual({ edge: "bottom", index: 1 });
  });

  it("omits a delete when the target cannot be removed", () => {
    const header = gutterControlPlacement({
      row: 0,
      column: 1,
      rows: 2,
      columns: 2,
      headerRow: true,
    });
    expect(header.deleteRow).toBeNull();
    expect(header.deleteColumn).toEqual({ index: 1 });
    expect(header.addRow).toEqual({ edge: "right", index: 1 });
  });
});

describe("matrix maths (via table-ops)", () => {
  it("adds a blank row after the given index", () => {
    expect(addRowToMatrix(MATRIX, 0)).toEqual([
      ["A", "B"],
      ["", ""],
      ["1", "2"],
    ]);
  });

  it("keeps the header pinned when adding a row", () => {
    expect(addRowToMatrix(MATRIX, 1, true)).toEqual([
      ["A", "B"],
      ["1", "2"],
      ["", ""],
    ]);
  });

  it("removes a row and protects the header", () => {
    expect(removeRowFromMatrix(MATRIX, 1)).toEqual([["A", "B"]]);
    expect(removeRowFromMatrix(MATRIX, 0, true)).toEqual(MATRIX);
  });

  it("adds a column after the given index", () => {
    expect(addColumnToMatrix(MATRIX, 1)).toEqual([
      ["A", "B", ""],
      ["1", "2", ""],
    ]);
  });

  it("removes a column from every row", () => {
    expect(removeColumnFromMatrix(MATRIX, 0)).toEqual([["B"], ["2"]]);
  });

  it("never mutates its input", () => {
    const frozen = MATRIX.map((row) => [...row]);
    addColumnToMatrix(MATRIX, 0);
    removeColumnFromMatrix(MATRIX, 0);
    expect(MATRIX).toEqual(frozen);
  });
});

describe("chrome visibility + accent styling", () => {
  it("is hidden with no hover, focus or selection", () => {
    expect(tableChromeVisible()).toBe(false);
    expect(tableChromeClass()).toContain("opacity-0");
    expect(tableChromeClass()).not.toContain("opacity-100");
  });

  it("shows on hover, focus or selection (keyboard parity)", () => {
    expect(tableChromeClass({ hovered: true })).toContain("opacity-100");
    expect(tableChromeClass({ focused: true })).toContain("opacity-100");
    expect(tableChromeClass({ selected: true })).toContain("opacity-100");
    expect(tableChromeClass({ hovered: true })).toContain("u-colors");
    expect(tableChromeClass({ hovered: true })).toContain("u-transform");
  });

  it("treats a header cell like a body cell (same chrome anchor)", () => {
    expect(tableCellClass(true)).toContain("noema-table-cell");
    expect(tableCellClass(true)).toContain("noema-table-header-cell");
    expect(tableCellClass(false)).toContain("noema-table-cell");
    expect(tableCellClass(false)).not.toContain("noema-table-header-cell");
  });

  it("lifts on group hover and focus-within", () => {
    expect(TABLE_CHROME_REVEAL).toContain("group-hover:opacity-100");
    expect(TABLE_CHROME_REVEAL).toContain("focus-within:opacity-100");
  });

  it("tints the gutter controls with the accent tokens", () => {
    const cls = gutterButtonClass();
    expect(cls).toContain("bg-accent-soft");
    expect(cls).toContain("text-accent");
    expect(cls).toContain("border-accent");
  });

  it("layers the gutter with a token z-index", () => {
    expect(gutterControlStyle().zIndex).toBeGreaterThan(0);
  });
});

describe("TableAffordances (renderToStaticMarkup)", () => {
  it("renders a table with the gutter controls while hovering", () => {
    const html = renderTable({ state: { hovered: true } });
    expect(html).toContain("data-table-affordances");
    expect(html).toContain("<table>");
    expect(html).toContain('data-testid="table-add-row"');
    expect(html).toContain('data-testid="table-add-column"');
    expect(html).toContain("data-table-drag-grip");
    expect(html).toContain('data-chrome-visible="true"');
    expect(html).toContain("opacity-100");
    expect(html).toContain("bg-accent-soft");
  });

  it("marks the header row for the same hover/focus treatment", () => {
    const html = renderTable({ state: { hovered: true } });
    expect(html).toContain("noema-table-cell");
    expect(html).toContain("noema-table-header-cell");
  });

  it("hides the gutters when the table is not hovered, focused or selected", () => {
    const html = renderTable({ state: {} });
    expect(html).toContain('data-chrome-visible="false"');
    expect(html).toContain("opacity-0");
  });

  it("names the add controls (row key + column literal)", () => {
    const html = renderTable({ state: { hovered: true } });
    expect(html).toContain('aria-label="New row"');
    expect(html).toContain(`aria-label="${ADD_COLUMN_LABEL}"`);
  });

  it("uses a plain danger delete for an empty row (no confirm)", () => {
    const html = renderTable({ state: { hovered: true } });
    expect(html).toContain('data-testid="table-delete-row"');
    expect(html).not.toContain("confirm-twostep");
  });

  it("arms a two-step confirm when a populated row/column is deleted", () => {
    const html = renderTable({
      state: { hovered: true },
      needsConfirmRow: true,
      needsConfirmColumn: true,
    });
    expect(html).toContain("confirm-twostep");
    expect(html).toContain(DELETE_COLUMN_LABEL);
  });
});
