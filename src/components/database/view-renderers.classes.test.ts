/**
 * Node acceptance for the database views' *class & motion maps* plus the live
 * empty/loading states.
 *
 * The visual contracts the design system pins — table row-height modes, the
 * board card lift, the gallery badge palette, the list indent guides and the
 * skeleton counts — are exported as pure mappings, so they are asserted here
 * without a DOM. Each view's empty and loading states are then rendered with
 * `react-dom/server` (the node test environment has no DOM) to prove the
 * markup actually carries the state.
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

import { TAG_HUES } from "@/lib/design-tokens";
import {
  CARD_LIFT,
  SKELETON_COUNTS,
  TABLE_ROW_HEIGHT_MODES,
  boardCardClass,
  boardDropValue,
  collapsedListIds,
  galleryBadgeHue,
  gallerySkeletonCards,
  listIndentGuides,
  resolveTableRowHeight,
  skeletonCount,
  tableRowCellClass,
  tableRowHeight,
} from "./view-renderers";
import {
  BoardView,
  FormView,
  GalleryView,
  ListView,
  TableView,
} from "./view-renderers";
import type { DBProperty, DBRow, HeaderConfig } from "./database-types";

const properties: DBProperty[] = [
  { id: "title", name: "Title", type: "TEXT", config: { primary: true } },
  { id: "est", name: "Estimate", type: "NUMBER", config: null },
  {
    id: "status",
    name: "Status",
    type: "SELECT",
    config: {
      options: [
        { id: "todo", name: "To do", color: "gray" },
        { id: "done", name: "Done", color: "green" },
      ],
    },
  },
  { id: "cover", name: "Cover", type: "FILES", config: null },
];

const rows: DBRow[] = [
  {
    id: "r1",
    title: "Alpha",
    icon: null,
    propertyValues: [
      { propertyId: "est", value: { number: 3 } },
      { propertyId: "status", value: { optionId: "todo" } },
      {
        propertyId: "cover",
        value: { files: [{ name: "a.png", url: "https://x.test/a.png" }] },
      },
    ],
  },
];

const valueFor = (row: DBRow, propertyId: string): unknown =>
  row.propertyValues.find((entry) => entry.propertyId === propertyId)?.value ?? null;

const headerConfig: HeaderConfig = {
  databases: [],
  relations: [],
  relationData: {},
  onLinkDatabase: () => {},
  onConfigureRollup: () => {},
};

const noop = () => {};

describe("table row-height modes", () => {
  it("coerces an unknown mode to medium and keeps the three known modes", () => {
    expect(resolveTableRowHeight("short")).toBe("short");
    expect(resolveTableRowHeight("tall")).toBe("tall");
    expect(resolveTableRowHeight("medium")).toBe("medium");
    expect(resolveTableRowHeight(undefined)).toBe("medium");
    expect(resolveTableRowHeight("gigantic")).toBe("medium");
  });

  it("maps each mode to a taller px height and a distinct cell class", () => {
    const px = [
      tableRowHeight("short"),
      tableRowHeight("medium"),
      tableRowHeight("tall"),
    ];
    expect(px[0]).toBeLessThan(px[1]);
    expect(px[1]).toBeLessThan(px[2]);
    const classes = new Set([
      tableRowCellClass("short"),
      tableRowCellClass("medium"),
      tableRowCellClass("tall"),
    ]);
    expect(classes.size).toBe(3);
    // The height the scroll anchor measures is the same one the mode declares.
    expect(tableRowHeight("short")).toBe(TABLE_ROW_HEIGHT_MODES.short.px);
  });
});

describe("board card lift & drag motion", () => {
  it("lifts on hover and presses without layout shift", () => {
    const base = boardCardClass();
    expect(base).toContain(CARD_LIFT.base);
    expect(base).toContain(CARD_LIFT.hover);
    expect(base).toContain(CARD_LIFT.press);
    expect(base).not.toContain("u-no-transition");
  });

  it("never transitions while dragging and settles with the spring", () => {
    expect(boardCardClass({ dragging: true })).toContain("u-no-transition");
    expect(boardCardClass({ settling: true })).toContain(CARD_LIFT.settling);
    expect(boardCardClass({ dragging: true, settling: false })).not.toContain(
      CARD_LIFT.settling,
    );
  });

  it("maps a drop target to the cell value it writes", () => {
    expect(boardDropValue("todo")).toEqual({ optionId: "todo" });
    expect(boardDropValue(null)).toBeNull();
    // A status-bucket column is not an option id — the drop writes nothing.
    expect(boardDropValue(undefined)).toBeUndefined();
  });
});

describe("gallery badges & skeletons", () => {
  it("picks a deterministic hue from the tag palette", () => {
    const hue = galleryBadgeHue("status");
    expect(TAG_HUES).toContain(hue);
    expect(galleryBadgeHue("status")).toBe(hue);
    expect(galleryBadgeHue("")).toBe(galleryBadgeHue(""));
  });

  it("sizes the skeleton grid to the responsive column count", () => {
    expect(gallerySkeletonCards("small")).toBe(8);
    expect(gallerySkeletonCards("medium")).toBe(6);
    expect(gallerySkeletonCards("large")).toBe(4);
  });

  it("exposes a positive skeleton count for every view", () => {
    for (const count of Object.values(SKELETON_COUNTS)) {
      expect(count).toBeGreaterThan(0);
    }
    expect(skeletonCount("table")).toBe(SKELETON_COUNTS.table);
  });
});

describe("list indent guides & collapse", () => {
  it("draws one 1px guide per ancestor level", () => {
    expect(listIndentGuides(0)).toEqual([]);
    expect(listIndentGuides(1)).toEqual([8]);
    expect(listIndentGuides(3)).toEqual([8, 24, 40]);
    expect(listIndentGuides(-1)).toEqual([]);
    expect(listIndentGuides(Number.NaN)).toEqual([]);
  });

  it("hides the descendants of a collapsed row and nothing else", () => {
    const outline = [
      { id: "a", level: 0, text: "" },
      { id: "b", level: 1, text: "" },
      { id: "c", level: 1, text: "" },
      { id: "d", level: 0, text: "" },
    ];
    expect([...collapsedListIds(outline, { a: true })]).toEqual(["b", "c"]);
    expect([...collapsedListIds(outline, { b: true })]).toEqual([]);
    expect([...collapsedListIds(outline, {})]).toEqual([]);
  });
});

const renderTable = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(TableView, {
      locale: "en",
      workspaceSlug: "w",
      workspaceId: "ws",
      properties,
      rows,
      primary: properties[0],
      editable: false,
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
      ...props,
    }),
  );

const renderList = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(ListView, {
      locale: "en",
      workspaceSlug: "w",
      properties,
      rows,
      valueFor,
      editable: false,
      ...props,
    }),
  );

const renderBoard = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(BoardView, {
      locale: "en",
      workspaceSlug: "w",
      workspaceId: "ws",
      properties,
      rows,
      colorOf: () => null,
      groupBy: "status",
      primary: properties[0],
      valueFor,
      setValue: noop,
      editable: false,
      ...props,
    }),
  );

const renderGallery = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(GalleryView, {
      locale: "en",
      workspaceSlug: "w",
      properties,
      rows,
      primary: properties[0],
      valueFor,
      cardSize: "medium",
      ...props,
    }),
  );

describe("table view states", () => {
  it("renders an actionable empty state", () => {
    const html = renderTable({ rows: [], onAddRow: noop });
    expect(html).toContain('data-testid="table-empty"');
    expect(html).toContain('data-testid="table-add-row"');
  });

  it("renders the hint without a button when no action is wired", () => {
    const html = renderTable({ rows: [] });
    expect(html).toContain('data-testid="table-empty"');
    expect(html).not.toContain('data-testid="table-add-row"');
  });

  it("renders a loading skeleton matching the layout", () => {
    const html = renderTable({ loading: true });
    expect(html).toContain('data-testid="table-skeleton"');
    expect(html).not.toContain('data-testid="property-header-Title"');
  });

  it("marks the sticky header unscrolled by default", () => {
    expect(renderTable()).toContain('data-scrolled="false"');
  });

  it("renders the footer aggregate distinctly (surface-2 + tabular-nums)", () => {
    const html = renderTable({ footer: [{ propertyId: "est", fn: "sum" }] });
    expect(html).toContain('data-testid="table-footer-Estimate"');
    expect(html).toContain("bg-surface-2");
    expect(html).toContain("tabular-nums");
  });

  it("applies the row-height mode's cell class", () => {
    expect(renderTable({ rowHeight: "tall" })).toContain("py-3");
    expect(renderTable({ rowHeight: "short" })).toContain("py-0.5");
  });
});

describe("list view states", () => {
  it("renders an actionable empty state", () => {
    const html = renderList({ rows: [], onAddRow: noop });
    expect(html).toContain('data-testid="list-empty"');
    expect(html).toContain('data-testid="list-add-row"');
  });

  it("renders a loading skeleton", () => {
    expect(renderList({ loading: true })).toContain('data-testid="list-skeleton"');
  });

  it("draws indent guides for a nested outline", () => {
    const nested: DBRow[] = [
      { ...rows[0], id: "a" },
      { ...rows[0], id: "b" },
    ];
    const html = renderList({ rows: nested, levels: { a: 0, b: 1 } });
    expect(html).toContain('data-testid="list-guide-b-8"');
    expect(html).not.toContain('data-testid="list-guide-a-8"');
  });
});

describe("board view states", () => {
  it("renders an actionable empty state when there are no rows", () => {
    const html = renderBoard({ rows: [], onAddRow: noop });
    expect(html).toContain('data-testid="board-empty"');
    expect(html).toContain('data-testid="board-add-row"');
  });

  it("renders its grouped column with a count chip", () => {
    const html = renderBoard();
    expect(html).toContain('data-testid="board-count-todo"');
    expect(html).toContain('data-testid="board-column-todo"');
    expect(html).toContain("shadow-1");
  });

  it("renders a loading skeleton of columns and cards", () => {
    expect(renderBoard({ loading: true })).toContain('data-testid="board-skeleton"');
  });

  it("paints an over-limit WIP badge with the danger-soft token", () => {
    const twoTodo: DBRow[] = [
      { ...rows[0], id: "r1" },
      { ...rows[0], id: "r2" },
    ];
    const html = renderBoard({ rows: twoTodo, wipLimits: { todo: 1 } });
    expect(html).toContain('data-wip-status="over"');
    expect(html).toContain("bg-danger-soft");
  });
});

describe("gallery view states", () => {
  it("renders an actionable empty state", () => {
    const html = renderGallery({ rows: [], onAddRow: noop });
    expect(html).toContain('data-testid="gallery-empty"');
    expect(html).toContain('data-testid="gallery-add-row"');
  });

  it("renders a skeleton grid while loading", () => {
    expect(renderGallery({ loading: true })).toContain('data-testid="gallery-skeleton"');
  });

  it("zooms the cover without a layout shift and tags the badges", () => {
    const html = renderGallery({ previewConfig: { coverPropertyId: "cover" } });
    expect(html).toContain("group-hover:scale-[1.02]");
    expect(html).toContain("object-cover");
  });
});

describe("form view states", () => {
  it("renders an empty state when there are no questions", () => {
    const html = renderToStaticMarkup(
      createElement(FormView, { locale: "en", properties: [] }),
    );
    expect(html).toContain('data-testid="form-empty"');
  });

  it("renders a loading skeleton", () => {
    const html = renderToStaticMarkup(
      createElement(FormView, { locale: "en", properties, loading: true }),
    );
    expect(html).toContain('data-testid="form-skeleton"');
  });

  it("wraps each answer in the focus ring", () => {
    const html = renderToStaticMarkup(
      createElement(FormView, { locale: "en", properties }),
    );
    expect(html).toContain("focus-within:shadow-[var(--shadow-focus)]");
  });
});
