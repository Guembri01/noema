import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/server/actions/database", () => ({
  setRowDependencyAction: vi.fn(),
}));

import { RowDependencies } from "./row-dependencies";

/**
 * The dependency editor is rendered inside the row peek. The server action owns
 * the graph invariants; this markup test pins the two direct lists, the
 * current-row exclusion, and the already-linked option filtering.
 */
describe("RowDependencies", () => {
  it("renders direct blocked-by and blocks lists with pickers", () => {
    const html = renderToStaticMarkup(
      createElement(RowDependencies, {
        locale: "en",
        databasePageId: "db-1",
        currentRowId: "b",
        rows: [
          { id: "a", title: "Design" },
          { id: "b", title: "Build" },
          { id: "c", title: "Ship" },
          { id: "d", title: "Retro" },
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "c" },
        ],
      }),
    );

    expect(html).toContain('data-testid="row-dependencies"');
    expect(html).toContain("Dependencies");
    expect(html).toContain("blocked by");
    expect(html).toContain("blocks");
    expect(html).toContain("Design");
    expect(html).toContain("Ship");
    expect(html).toContain("Add blocker");
    expect(html).toContain("Add blocked row");
    // The current row is never offered as its own blocker.
    expect(html).not.toContain('value="b"');
    // Already-linked rows do not show up again in the same direction.
    expect(html.match(/value="a"/g)).toHaveLength(1);
    expect(html.match(/value="c"/g)).toHaveLength(1);
    expect(html).toContain("Retro");
  });

  it("renders no editor noise when a row has no dependencies", () => {
    const html = renderToStaticMarkup(
      createElement(RowDependencies, {
        locale: "en",
        databasePageId: "db-1",
        currentRowId: "a",
        rows: [
          { id: "a", title: "Only" },
          { id: "b", title: "Other" },
        ],
        edges: [],
      }),
    );

    expect(html).toContain('data-testid="row-dependencies"');
    expect(html).toContain("Add blocker");
    expect(html).toContain("Add blocked row");
    expect(html).not.toContain("<li");
  });
});
