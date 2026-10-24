/**
 * dz01 — design-system adoption for the database container.
 *
 * `database-view.tsx` is a client component that pulls in server actions and
 * `next/navigation`, so both are stubbed here (the same pattern
 * `view-renderers.wiring.test.ts` uses). Two things are then proven without a
 * DOM:
 *
 *  1. the pure wiring maps the container added —
 *       view type → skeleton count      (`viewSkeletonCount`)
 *       view config → table props       (`tableViewWiring`, incl. rowHeight→class)
 *       property type → chip label      (`propertyTypeLabel`)
 *       view type → owns-its-skeleton   (`viewSupportsLoading`)
 *  2. that the loading and empty states actually reach the markup, via
 *     `react-dom/server` (`renderToStaticMarkup`).
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("sonner", () => {
  const toast = Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
  });
  return { toast };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/server/actions/database", () => {
  const names = [
    "createPropertyAction",
    "createRowAction",
    "createViewAction",
    "deletePropertyAction",
    "deleteRowAction",
    "duplicateDatabaseAction",
    "duplicateViewAction",
    "importCsvAction",
    "createRowFromTemplateAction",
    "deleteTemplateAction",
    "listDeletedRowsAction",
    "loadMoreDatabaseRowsAction",
    "reorderPropertiesAction",
    "saveRowAsTemplateAction",
    "setPropertyValueAction",
    "setRelationTwoWayAction",
    "setSubItemParentAction",
    "submitFormAction",
    "setTemplateRecurrenceAction",
    "updatePropertyAction",
    "updateViewAction",
    "reorderRowsAction",
    "reorderTemplatesAction",
    "setDefaultTemplateAction",
  ];
  return Object.fromEntries(names.map((name) => [name, vi.fn()]));
});

vi.mock("@/server/actions/pages", () => ({
  restorePageAction: vi.fn(),
  toggleSchemaLockAction: vi.fn(),
  updatePageAction: vi.fn(),
}));

import {
  PROPERTY_TYPE_LABELS,
  TABLE_ROW_HEIGHT_OPTIONS,
  VIEW_SKELETON_KIND,
  DatabaseView,
  propertyTypeLabel,
  tableViewWiring,
  viewSkeletonCount,
  viewSupportsLoading,
} from "./database-view";
import { SKELETON_COUNTS, tableRowCellClass } from "./view-renderers";
import type { DBProperty, DBRow, DBView } from "./database-types";

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

const property = (
  id: string,
  type: string,
  config: DBProperty["config"] = null,
): DBProperty => ({ id, name: id, type, config }) as unknown as DBProperty;

const properties: DBProperty[] = [
  property("title", "TEXT", { primary: true }),
  property("est", "NUMBER"),
  property("status", "SELECT"),
];

const view = (id: string, type: string, config: DBView["config"]): DBView => ({
  id,
  name: id,
  type,
  config,
});

const baseProps = {
  locale: "en",
  databasePageId: "db1",
  workspaceId: "ws1",
  workspaceSlug: "acme",
  templates: [],
  relationData: {},
  databases: [],
  properties,
  editable: true,
};

const render = (overrides: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(DatabaseView, {
      ...baseProps,
      views: [view("v1", "TABLE", null)],
      rows: [] as DBRow[],
      ...overrides,
    } as never),
  );

/* -------------------------------------------------------------------------- *
 * Pure mappings
 * -------------------------------------------------------------------------- */

describe("viewSkeletonCount — view type → skeleton rows", () => {
  it("maps each known view type onto its renderer's skeleton family", () => {
    expect(viewSkeletonCount("TABLE")).toBe(SKELETON_COUNTS.table);
    expect(viewSkeletonCount("BOARD")).toBe(SKELETON_COUNTS.boardCards);
    expect(viewSkeletonCount("LIST")).toBe(SKELETON_COUNTS.list);
    expect(viewSkeletonCount("GALLERY")).toBe(SKELETON_COUNTS.gallery);
    expect(viewSkeletonCount("CALENDAR")).toBe(SKELETON_COUNTS.calendar);
    expect(viewSkeletonCount("TIMELINE")).toBe(SKELETON_COUNTS.timeline);
    expect(viewSkeletonCount("CHART")).toBe(SKELETON_COUNTS.chart);
    expect(viewSkeletonCount("FORM")).toBe(SKELETON_COUNTS.form);
  });

  it("falls back to the table count for an unknown view type", () => {
    expect(viewSkeletonCount("MYSTERY")).toBe(SKELETON_COUNTS.table);
    expect(Object.keys(VIEW_SKELETON_KIND)).toHaveLength(8);
  });
});

describe("viewSupportsLoading — who owns the loading skeleton", () => {
  it("is true for the renderers that render their own skeleton", () => {
    for (const type of ["TABLE", "LIST", "BOARD", "GALLERY", "FORM"]) {
      expect(viewSupportsLoading(type)).toBe(true);
    }
  });

  it("is false for calendar/timeline/chart and unknown types (container draws it)", () => {
    for (const type of ["CALENDAR", "TIMELINE", "CHART", "MYSTERY"]) {
      expect(viewSupportsLoading(type)).toBe(false);
    }
  });
});

describe("tableViewWiring — view config → TableView props", () => {
  it("defaults the row height to medium and leaves the footer undefined", () => {
    expect(tableViewWiring(undefined)).toEqual({
      rowHeight: "medium",
      footer: undefined,
    });
    expect(tableViewWiring({})).toEqual({ rowHeight: "medium", footer: undefined });
  });

  it("reads a persisted row height and coerces an unknown one", () => {
    expect(tableViewWiring({ rowHeight: "tall" }).rowHeight).toBe("tall");
    expect(tableViewWiring({ rowHeight: "short" }).rowHeight).toBe("short");
    expect(tableViewWiring({ rowHeight: "gigantic" }).rowHeight).toBe("medium");
  });

  it("keeps only the well-formed footer calculations", () => {
    expect(
      tableViewWiring({
        rowHeight: "tall",
        footer: [
          { propertyId: "est", fn: "sum" },
          { propertyId: "", fn: "sum" },
          { propertyId: "est", fn: "not-a-fn" },
          { propertyId: "est" },
        ],
      }),
    ).toEqual({
      rowHeight: "tall",
      footer: [{ propertyId: "est", fn: "sum" }],
    });
  });

  it("drives the renderer's row-height classes (rowHeight → cell class)", () => {
    expect(tableRowCellClass(tableViewWiring({ rowHeight: "tall" }).rowHeight)).toContain(
      "py-3",
    );
    expect(
      tableRowCellClass(tableViewWiring({ rowHeight: "short" }).rowHeight),
    ).toContain("py-0.5");
  });

  it("offers the three row-height modes, densest first", () => {
    expect(TABLE_ROW_HEIGHT_OPTIONS.map((option) => option.value)).toEqual([
      "short",
      "medium",
      "tall",
    ]);
  });
});

describe("propertyTypeLabel — property type → peek chip label", () => {
  it("labels the common types", () => {
    expect(propertyTypeLabel("TEXT")).toBe("Text");
    expect(propertyTypeLabel("MULTI_SELECT")).toBe("Multi-select");
    expect(propertyTypeLabel("AI_AUTOFILL")).toBe("AI autofill");
  });

  it("passes an unknown type through rather than rendering a blank chip", () => {
    expect(propertyTypeLabel("FUTURE_TYPE")).toBe("FUTURE_TYPE");
    expect(Object.keys(PROPERTY_TYPE_LABELS).length).toBeGreaterThan(20);
  });
});

/* -------------------------------------------------------------------------- *
 * Rendered states (react-dom/server)
 * -------------------------------------------------------------------------- */

describe("DatabaseView — loading and empty states reach the markup", () => {
  it("renders the table's layout-matching skeleton while loading", () => {
    const html = render({ loading: true });
    expect(html).toContain('data-testid="table-skeleton"');
  });

  it("renders the container skeleton for a view whose renderer has none", () => {
    const html = render({
      loading: true,
      views: [view("v1", "CALENDAR", null)],
    });
    expect(html).toContain('data-skeleton="table"');
    expect(html).not.toContain('data-testid="table-skeleton"');
  });

  it("renders the table empty state with a New row action for editors", () => {
    const html = render();
    expect(html).toContain('data-testid="table-empty"');
    expect(html).toContain('data-testid="table-add-row"');
  });

  it("omits the empty-state action for a read-only viewer", () => {
    const html = render({ editable: false });
    expect(html).toContain('data-testid="table-empty"');
    expect(html).not.toContain('data-testid="table-add-row"');
  });

  it("renders the no-views empty state when the database has no views", () => {
    const html = render({ views: [] });
    expect(html).toContain('data-empty-state="compact"');
  });
});
