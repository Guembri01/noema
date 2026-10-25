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

import { PropertyPanel } from "./property-panel";
import type { DBProperty } from "./database-types";

const properties: DBProperty[] = [
  { id: "title", name: "Title", type: "TEXT", config: { primary: true } },
  { id: "status", name: "Status", type: "SELECT", config: null },
  { id: "owner", name: "Owner", type: "PEOPLE", config: null },
  { id: "due", name: "Due", type: "DATE", config: null },
];

const values: Record<string, unknown> = {
  title: { text: "Alpha" },
  status: { text: "Doing" },
  owner: { text: "Ada" },
  due: { text: "2026-10-25" },
};

function render(extra: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(PropertyPanel, {
      properties,
      values: (propertyId: string) => values[propertyId],
      ...extra,
    }),
  );
}

describe("PropertyPanel — layout render wiring", () => {
  it("renders the persisted engine order in two columns", () => {
    const html = render({
      layout: {
        columns: 2,
        order: ["status", "title", "owner"],
        spans: { owner: 2 },
        dividers: true,
      },
      availableWidth: 900,
    });
    expect(html).toContain('data-columns="2"');
    expect(html).toContain('data-column="1"');
    expect(html.indexOf("Status")).toBeLessThan(html.indexOf("Title"));
    expect(html.indexOf("Title")).toBeLessThan(html.indexOf("Owner"));
    // A schema property the saved layout never listed is still rendered.
    expect(html).toContain('data-testid="property-Due"');
  });

  it("keeps every property when collapsing a narrow two-column layout", () => {
    const html = render({
      layout: { columns: 2, order: ["status", "title", "owner", "due"] },
      availableWidth: 320,
      onLayoutChange: vi.fn(),
    });
    expect(html).toContain('data-columns="1"');
    expect(html).toContain('data-collapsed="true"');
    expect(html).not.toContain('data-column="1"');
    for (const name of ["Status", "Title", "Owner", "Due"]) {
      expect(html).toContain(`data-testid="property-${name}"`);
    }
    // The persisted two-column choice is still what the control shows, even
    // while the panel renders it as one column for the narrow width.
    expect(html).toMatch(
      /data-testid="property-layout-two-columns"[^>]*aria-pressed="true"/,
    );
  });

  it("still accepts the legacy array-of-columns shape", () => {
    const html = render({
      layout: { columns: [["title"], ["status", "owner"]] },
      availableWidth: 900,
    });
    expect(html).toContain('data-columns="2"');
    expect(html).toContain('data-testid="property-Status"');
    expect(html).toContain("Alpha");
  });

  it("shows the layout control only when the caller can persist it", () => {
    const without = render({ layout: { columns: 1, order: [] } });
    expect(without).not.toContain('data-testid="property-layout-control"');

    const withControl = render({
      layout: { columns: 2, order: ["title", "status", "owner", "due"] },
      onLayoutChange: vi.fn(),
    });
    expect(withControl).toContain('data-testid="property-layout-control"');
    expect(withControl).toContain('data-testid="property-layout-one-column"');
    expect(withControl).toContain('data-testid="property-layout-two-columns"');
    expect(withControl).toContain('aria-pressed="true"');
  });
});
