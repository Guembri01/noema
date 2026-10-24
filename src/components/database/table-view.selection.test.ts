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

import type { DBProperty, DBRow, HeaderConfig } from "./database-types";
import { TableView } from "./view-renderers";

/**
 * The table's bulk-row selection wiring: when the caller passes the toggle
 * callbacks (the database view does for an editable table), the header gets a
 * select-all checkbox and every row gets one. Omitted callbacks keep the
 * table exactly as it was, which is what the static renderer tests rely on.
 */

const properties: DBProperty[] = [
  { id: "title", name: "Title", type: "TEXT", config: { primary: true } },
];
const rows: DBRow[] = [
  { id: "r1", title: "Alpha", icon: null, propertyValues: [] },
  { id: "r2", title: "Beta", icon: null, propertyValues: [] },
];

const valueFor = (row: DBRow, propertyId: string): unknown =>
  row.propertyValues.find((entry) => entry.propertyId === propertyId)?.value ?? null;

const headerConfig: HeaderConfig = {
  databases: [],
  relations: [],
  relationData: {},
  onLinkDatabase: () => {},
  onConfigureRollup: () => {},
  onSetRelationMulti: () => {},
  onToggleTwoWay: () => {},
};

const noop = () => {};

function renderTable(extra: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(TableView, {
      locale: "en",
      workspaceSlug: "w",
      workspaceId: "ws",
      properties,
      rows,
      primary: properties[0],
      editable: true,
      config: {},
      valueFor,
      setValue: noop,
      setPrimary: noop,
      removeRow: noop,
      onSaveTemplate: noop,
      computedFor: () => undefined,
      relationOptionsFor: () => [],
      peopleOptions: [],
      headerConfig,
      onRunButton: noop,
      onConfigureButton: noop,
      onOpenPeek: noop,
      onRunAi: noop,
      colorOf: () => null,
      onEditFormula: noop,
      onSetFormat: noop,
      onEditOptions: noop,
      editingProperty: null,
      setEditingProperty: noop,
      onDeleteProperty: noop,
      onRenameProperty: noop,
      onDuplicateProperty: noop,
      onReorderProperty: noop,
      ...extra,
    }),
  );
}

describe("TableView bulk selection", () => {
  it("renders no selection controls when the caller does not opt in", () => {
    const html = renderTable();
    expect(html).not.toContain('aria-label="Select all"');
    expect(html).not.toContain('aria-label="Select: Alpha"');
  });

  it("renders a select-all header and one checkbox per row when opted in", () => {
    const html = renderTable({
      selectedRowIds: ["r1"],
      onToggleRow: noop,
      onToggleAllRows: noop,
    });
    expect(html).toContain('aria-label="Select all"');
    expect(html).toContain('aria-label="Select: Alpha"');
    expect(html).toContain('aria-label="Select: Beta"');
  });

  it("marks a selected row and a partial selection honestly", () => {
    const html = renderTable({
      selectedRowIds: ["r1"],
      onToggleRow: noop,
      onToggleAllRows: noop,
    });
    expect(html).toContain('data-state="checked"');
    expect(html).toContain('data-state="indeterminate"');
    expect(html).toContain('aria-checked="mixed"');
  });
});
