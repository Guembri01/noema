/**
 * Live render check: a persisted view config actually reaches the DOM.
 *
 * Renders the real `TableView` / `GalleryView` / `FormView` components with
 * `react-dom/server` (the node test environment has no DOM) and asserts the
 * outputs the newly wired engines produce — a footer total, a gallery badge
 * strip / cover and the stored-form chrome — are present in the markup.
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

import { FormView, GalleryView, TableView } from "./view-renderers";
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
  {
    id: "r2",
    title: "Beta",
    icon: null,
    propertyValues: [
      { propertyId: "est", value: { number: 5 } },
      { propertyId: "status", value: { optionId: "done" } },
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
  onSetRelationMulti: () => {},
  onToggleTwoWay: () => {},
};

const noop = () => {};

describe("TableView renders a persisted footer config", () => {
  const render = (footer?: { propertyId: string; fn: "sum" | "count" }[]) =>
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
        footer,
      }),
    );

  it("draws a footer total for a saved calculation", () => {
    const html = render([{ propertyId: "est", fn: "sum" }]);
    expect(html).toContain('data-testid="table-footer-Estimate"');
    expect(html).toContain("8");
  });

  it("omits the footer when nothing is configured", () => {
    expect(render(undefined)).not.toContain("table-footer-Estimate");
  });
});

describe("GalleryView renders the preview engine output for a saved config", () => {
  const render = (previewPropertyId?: string) =>
    renderToStaticMarkup(
      createElement(GalleryView, {
        locale: "en",
        workspaceSlug: "w",
        properties,
        rows,
        primary: properties[0],
        valueFor,
        cardSize: "medium",
        previewPropertyId,
      }),
    );

  it("renders the cover and badge strip from the persisted preview property", () => {
    const html = render("cover");
    expect(html).toContain('src="https://x.test/a.png"');
    expect(html).toContain('data-testid="gallery-badges"');
    expect(html).toContain('data-testid="gallery-badge-status"');
  });

  it("keeps the legacy card (no badge strip) without a saved preview config", () => {
    expect(render(undefined)).not.toContain('data-testid="gallery-badges"');
  });
});

describe("FormView renders the stored schema chrome", () => {
  it("shows the stored title and submit label", () => {
    const html = renderToStaticMarkup(
      createElement(FormView, {
        locale: "en",
        properties,
        config: {
          id: "f1",
          databaseId: "db",
          title: "Contact us",
          submitLabel: "Send",
          accepting: true,
          fields: [
            { propertyId: "title", label: "Your name", required: true },
            { propertyId: "est", label: "Estimate", type: "NUMBER" },
          ],
        },
        onSubmit: noop,
      }),
    );
    expect(html).toContain('data-testid="form-title"');
    expect(html).toContain("Contact us");
    expect(html).toContain('data-testid="form-submit"');
    expect(html).toContain("Send");
    expect(html).toContain("Your name");
  });
});
