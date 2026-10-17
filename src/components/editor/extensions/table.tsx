"use client";

/**
 * Table affordances — the hover-revealed chrome for the editor's table node
 * view: gutter controls (`+ row` / `+ column`), a drag-handle affordance, and a
 * delete control guarded by a two-step confirm when the table is non-empty.
 *
 * This module is **presentation + affordances only**: the table schema,
 * attributes and serialization are untouched (the node view changes the editor
 * DOM, while `Table.renderHTML` still owns JSON/HTML/markdown export). It is
 * built by extending the stock `Table` node with a React node view, so wiring
 * it in is a one-line swap of `TableKit.configure({ table: … })` for
 * `TableKit.configure({ table: false })` + `TableWithAffordances.configure(…)`
 * (that call site lives in `page-editor.tsx`, owned elsewhere).
 *
 * Everything the view reads is a pure mapping (below) so the placement and
 * index maths are proven in `table.test.ts`, plus a static render of the chrome
 * in its hover state.
 */

import { useState, type ReactNode } from "react";
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { Table } from "@tiptap/extension-table";
import { GripHorizontal, GripVertical, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { Z } from "@/lib/design-tokens";
import {
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  normalizeMatrix,
} from "@/lib/table-ops";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/* -------------------------------------------------------------------------- *
 * Pure mappings — proven in `table.test.ts`
 * -------------------------------------------------------------------------- */

/** Table dimensions in cells. */
export type TableAxes = { rows: number; columns: number };

/**
 * Insert position for a new row placed *after* `rowIndex`, clamped into
 * `[0, rowCount]`. With a header row the header is pinned: the new row can
 * never land above it (`min` becomes 1). A non-finite index means "append".
 */
export function addRowIndex(rowIndex: number, rowCount: number, headerRow = false): number {
  const min = headerRow ? Math.min(1, rowCount) : 0;
  if (!Number.isFinite(rowIndex)) return rowCount;
  return Math.min(Math.max(Math.trunc(rowIndex) + 1, min), rowCount);
}

/** Insert position for a new column placed after `columnIndex`, clamped. */
export function addColumnIndex(columnIndex: number, columnCount: number): number {
  if (!Number.isFinite(columnIndex)) return columnCount;
  return Math.min(Math.max(Math.trunc(columnIndex) + 1, 0), columnCount);
}

/** A row can be deleted unless it is out of range or is the pinned header. */
export function canDeleteRow(rowIndex: number, rowCount: number, headerRow = false): boolean {
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= rowCount) return false;
  if (headerRow && rowIndex === 0) return false;
  return true;
}

/** A column can be deleted when the index is in range. */
export function canDeleteColumn(columnIndex: number, columnCount: number): boolean {
  return Number.isInteger(columnIndex) && columnIndex >= 0 && columnIndex < columnCount;
}

/** Where each gutter control sits for a hovered cell. */
export type GutterPlacement = {
  addRow: { edge: "right"; index: number };
  addColumn: { edge: "bottom"; index: number };
  deleteRow: { index: number } | null;
  deleteColumn: { index: number } | null;
};

/**
 * The placement of the four gutter controls for the hovered cell: `+ row` in
 * the **right** gutter aligned to the row, `+ column` in the **bottom** gutter,
 * and the delete controls — omitted (`null`) when the target cannot be removed
 * (out of range, or the pinned header row).
 */
export function gutterControlPlacement(input: {
  row: number;
  column: number;
  rows: number;
  columns: number;
  headerRow?: boolean;
}): GutterPlacement {
  const { row, column, rows, columns, headerRow = false } = input;
  return {
    addRow: { edge: "right", index: addRowIndex(row, rows, headerRow) },
    addColumn: { edge: "bottom", index: addColumnIndex(column, columns) },
    deleteRow: canDeleteRow(row, rows, headerRow) ? { index: row } : null,
    deleteColumn: canDeleteColumn(column, columns) ? { index: column } : null,
  };
}

/* --- matrix wrappers: the index maths applied through `table-ops` ---------- */

/** Insert a blank row after `rowIndex` (header-aware). */
export function addRowToMatrix(
  matrix: string[][],
  rowIndex: number,
  headerRow = false,
): string[][] {
  const rows = normalizeMatrix(matrix);
  return insertRow(rows, addRowIndex(rowIndex, rows.length, headerRow), { headerRow });
}

/** Remove the row at `rowIndex` (header-aware; out-of-range is a no-op). */
export function removeRowFromMatrix(
  matrix: string[][],
  rowIndex: number,
  headerRow = false,
): string[][] {
  return deleteRow(normalizeMatrix(matrix), rowIndex, { headerRow });
}

/** Insert a blank column after `columnIndex`. */
export function addColumnToMatrix(matrix: string[][], columnIndex: number): string[][] {
  const rows = normalizeMatrix(matrix);
  const width = rows.length > 0 ? rows[0].length : 0;
  return insertColumn(rows, addColumnIndex(columnIndex, width));
}

/** Remove the column at `columnIndex` from every row. */
export function removeColumnFromMatrix(matrix: string[][], columnIndex: number): string[][] {
  return deleteColumn(normalizeMatrix(matrix), columnIndex);
}

/**
 * Whether a delete should be confirmed: true when any cell carries content.
 * An empty row/column can be removed outright; a populated one arms a two-step
 * confirm first.
 */
export function deleteNeedsConfirm(cells: readonly string[]): boolean {
  return cells.some((cell) => String(cell ?? "").trim() !== "");
}

/* --- presentation mappings ------------------------------------------------- */

/** Visibility inputs for the table's hover chrome. */
export type TableChromeState = {
  hovered?: boolean;
  focused?: boolean;
  selected?: boolean;
};

/** True when the chrome should be pinned visible (hover, focus or selection). */
export function tableChromeVisible(state: TableChromeState = {}): boolean {
  return Boolean(state.hovered || state.focused || state.selected);
}

/**
 * The gutter chrome fades in on hover and stays put while the table holds focus
 * or a selection — keyboard parity with the pointer. Opacity only (`.u-colors`).
 */
export function tableChromeClass(state: TableChromeState = {}): string {
  return `noema-table-chrome u-colors u-transform ${tableChromeVisible(state) ? "opacity-100" : "opacity-0"}`;
}

/**
 * Cells are the pointer/keyboard anchors for the chrome — a header cell gets
 * exactly the same treatment as a body cell, so revealing the gutter controls
 * while hovering a header row behaves like any other row.
 */
export function tableCellClass(header: boolean): string {
  return cn("noema-table-cell", header && "noema-table-header-cell");
}

/** Reveal rules applied alongside {@link tableChromeClass} (no layout shift). */
export const TABLE_CHROME_REVEAL =
  "group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100";

/**
 * Accent tint for the gutter buttons, straight from the token palette: the
 * `accent-soft` fill, `accent` ink/border and no bespoke radius/shadow. The
 * shared `Button` adds `.u-interactive` + `.focus-ring`.
 */
export function gutterButtonClass(): string {
  return "border border-accent bg-accent-soft text-accent hover:bg-accent/20";
}

/** Inline layer for a gutter control (above the table, below menus). */
export function gutterControlStyle(): { zIndex: number } {
  return { zIndex: Z.sticky };
}

/**
 * Label for the `+ column` control. There is no dedicated `addColumn` key in
 * the i18n catalogue yet (owned elsewhere), so the literal is centralised here
 * pending the key; `+ row` / delete reuse the existing `newRow` / `deleteRow`.
 */
export const ADD_COLUMN_LABEL = "Add column";

/** Label for the `delete column` control (pending an i18n key). */
export const DELETE_COLUMN_LABEL = "Delete column";

/* -------------------------------------------------------------------------- *
 * Presentational chrome (no hooks — static-renderable)
 * -------------------------------------------------------------------------- */

/** A small accent-tinted, `.u-interactive` gutter button. */
export function TableGutterButton({
  label,
  testId,
  onClick,
  className,
  children,
}: {
  label: string;
  testId: string;
  onClick?: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      data-testid={testId}
      onClick={onClick}
      className={cn(gutterButtonClass(), className)}
    >
      {children}
    </Button>
  );
}

/** Decorative drag grip for a row (`vertical`) or a column (`horizontal`). */
export function TableDragGrip({ axis }: { axis: "row" | "column" }) {
  const Icon = axis === "row" ? GripVertical : GripHorizontal;
  return (
    <span
      aria-hidden
      data-table-drag-grip={axis}
      className="noema-table-drag-grip inline-flex h-4 w-4 cursor-grab items-center justify-center text-fg-subtle"
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

/**
 * Delete control: a plain danger button when the target is empty, otherwise a
 * non-blocking two-step `ConfirmDialog` (arm → confirm) so a populated
 * row/column is never removed on a single stray click.
 */
export function TableDeleteControl({
  label,
  testId,
  needsConfirm,
  onDelete,
  locale = "en",
}: {
  label: string;
  testId: string;
  needsConfirm: boolean;
  onDelete?: () => void;
  locale?: string;
}) {
  if (!needsConfirm) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={label}
        data-testid={testId}
        onClick={onDelete}
        className="text-danger hover:bg-danger-soft"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
      </Button>
    );
  }
  return (
    <ConfirmDialog
      open
      onOpenChange={() => {}}
      mode="two-step"
      tone="danger"
      title={label}
      armLabel={label}
      confirmLabel={t(locale, "delete")}
      cancelLabel={t(locale, "cancel")}
      onConfirm={() => onDelete?.()}
      className="[&_button]:h-7 [&_button]:px-2 [&_button]:text-xs"
    />
  );
}

export type TableAffordancesProps = {
  state?: TableChromeState;
  /** Row-major cell content; the first row is the header by default. */
  rows?: readonly (readonly string[])[];
  headerRow?: boolean;
  locale?: string;
  /** Arm the two-step confirm on the row/column delete controls. */
  needsConfirmRow?: boolean;
  needsConfirmColumn?: boolean;
  onAddRow?: () => void;
  onAddColumn?: () => void;
  onDeleteRow?: () => void;
  onDeleteColumn?: () => void;
};

const DEFAULT_ROWS: readonly (readonly string[])[] = [
  ["Name", "Status"],
  ["", ""],
];

/**
 * A static table with its hover chrome rendered in place — the shape the node
 * view produces. The controls live in the right/bottom gutters, absolutely
 * positioned so revealing them never reflows the table; the whole group is
 * `group` + `relative` for the {@link TABLE_CHROME_REVEAL} hover/focus selectors.
 */
export function TableAffordances({
  state = {},
  rows = DEFAULT_ROWS,
  headerRow = true,
  locale = "en",
  needsConfirmRow = false,
  needsConfirmColumn = false,
  onAddRow,
  onAddColumn,
  onDeleteRow,
  onDeleteColumn,
}: TableAffordancesProps) {
  const visible = tableChromeVisible(state);
  const width = rows[0]?.length ?? 0;
  return (
    <div
      className="noema-table-affordances group relative inline-block"
      data-table-affordances=""
    >
      <table>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {Array.from({ length: width }).map((_, columnIndex) => {
                const content = row[columnIndex] ?? "";
                return headerRow && rowIndex === 0 ? (
                  <th key={columnIndex} className={tableCellClass(true)}>
                    {content}
                  </th>
                ) : (
                  <td key={columnIndex} className={tableCellClass(false)}>
                    {content}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {/* Right gutter: drag grip + add row + delete row. */}
      <div
        className={cn(
          TABLE_CHROME_REVEAL,
          tableChromeClass(state),
          "absolute inset-y-0 -end-7 flex flex-col justify-center gap-1",
        )}
        data-table-row-gutter=""
        contentEditable={false}
        data-chrome-visible={visible ? "true" : "false"}
        style={gutterControlStyle()}
      >
        <TableDragGrip axis="row" />
        <TableGutterButton label={t(locale, "newRow")} testId="table-add-row" onClick={onAddRow}>
          <Plus className="h-3.5 w-3.5" aria-hidden />
        </TableGutterButton>
        <TableDeleteControl
          label={t(locale, "deleteRow")}
          testId="table-delete-row"
          needsConfirm={needsConfirmRow}
          onDelete={onDeleteRow}
          locale={locale}
        />
      </div>

      {/* Bottom gutter: drag grip + add column + delete column. */}
      <div
        className={cn(
          TABLE_CHROME_REVEAL,
          tableChromeClass(state),
          "absolute inset-x-0 -bottom-7 flex items-center justify-end gap-1",
        )}
        data-table-column-gutter=""
        contentEditable={false}
        data-chrome-visible={visible ? "true" : "false"}
        style={gutterControlStyle()}
      >
        <TableDragGrip axis="column" />
        <TableGutterButton
          label={ADD_COLUMN_LABEL}
          testId="table-add-column"
          onClick={onAddColumn}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
        </TableGutterButton>
        <TableDeleteControl
          label={DELETE_COLUMN_LABEL}
          testId="table-delete-column"
          needsConfirm={needsConfirmColumn}
          onDelete={onDeleteColumn}
          locale={locale}
        />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Live node view + extension
 * -------------------------------------------------------------------------- */

/** Flatten a table node into its row-major text matrix (for emptiness + axes). */
function tableTextMatrix(node: NodeViewProps["node"]): string[][] {
  const rows: string[][] = [];
  node.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => cells.push(cell.textContent));
    rows.push(cells);
  });
  return rows;
}

function TableNodeView({ node, editor, selected, locale }: NodeViewProps & { locale: string }) {
  const editable = editor.isEditable;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const matrix = tableTextMatrix(node);
  const needsConfirm = deleteNeedsConfirm(matrix.flat());
  const state: TableChromeState = { hovered, focused, selected };

  return (
    <NodeViewWrapper
      className={cn("noema-table-wrap group relative", selected && "is-selected")}
      data-table-with-affordances=""
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={() => setFocused(false)}
    >
      <table>
        <NodeViewContent<"tbody"> as="tbody" />
      </table>

      {editable && (
        <>
          <div
            className={cn(
              TABLE_CHROME_REVEAL,
              tableChromeClass(state),
              "absolute inset-y-0 -end-7 flex flex-col justify-center gap-1",
            )}
            data-table-row-gutter=""
            contentEditable={false}
            style={gutterControlStyle()}
          >
            <TableDragGrip axis="row" />
            <TableGutterButton
              label={t(locale, "newRow")}
              testId="table-add-row"
              onClick={() => editor.chain().focus().addRowAfter().run()}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
            </TableGutterButton>
            <TableDeleteControl
              label={t(locale, "deleteRow")}
              testId="table-delete-row"
              needsConfirm={needsConfirm}
              onDelete={() => editor.chain().focus().deleteRow().run()}
              locale={locale}
            />
          </div>

          <div
            className={cn(
              TABLE_CHROME_REVEAL,
              tableChromeClass(state),
              "absolute inset-x-0 -bottom-7 flex items-center justify-end gap-1",
            )}
            data-table-column-gutter=""
            contentEditable={false}
            style={gutterControlStyle()}
          >
            <TableDragGrip axis="column" />
            <TableGutterButton
              label={ADD_COLUMN_LABEL}
              testId="table-add-column"
              onClick={() => editor.chain().focus().addColumnAfter().run()}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
            </TableGutterButton>
            <TableDeleteControl
              label={DELETE_COLUMN_LABEL}
              testId="table-delete-column"
              needsConfirm={needsConfirm}
              onDelete={() => editor.chain().focus().deleteColumn().run()}
              locale={locale}
            />
          </div>
        </>
      )}
    </NodeViewWrapper>
  );
}

/** `Table` options plus the locale threaded from the editor. */
type TableOptions = { locale: string };

/**
 * The stock `Table` node with the hover-affordance node view attached. Drop-in
 * for the `table` member of a table kit; serialization is unchanged because the
 * node view only replaces the editor DOM (export still uses `renderHTML`).
 */
export const TableWithAffordances = Table.extend<TableOptions>({
  addOptions() {
    return {
      ...this.parent?.(),
      locale: "en",
    } as TableOptions;
  },
  addNodeView() {
    const locale = this.options.locale;
    return ReactNodeViewRenderer((props: NodeViewProps) => (
      <TableNodeView {...props} locale={locale} />
    ));
  },
});
