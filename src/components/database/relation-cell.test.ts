import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RelationCell } from "./relation-cell";

const options = [
  { id: "p1", title: "Alpha", icon: "📄" },
  { id: "p2", title: "Beta", icon: "🗂️" },
];

describe("RelationCell", () => {
  it("renders selected titles once and an add control for editors", () => {
    const html = renderToStaticMarkup(
      createElement(RelationCell, {
        propertyName: "Related",
        value: { pageIds: ["p1"] },
        editable: true,
        locale: "en",
        options,
        onChange: () => {},
      }),
    );
    expect(html.match(/title="Alpha"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Add relation"');
  });

  it("renders a read-only empty marker without a picker", () => {
    const html = renderToStaticMarkup(
      createElement(RelationCell, {
        propertyName: "Related",
        value: { pageIds: [] },
        editable: false,
        locale: "en",
        options,
        onChange: () => {},
      }),
    );
    expect(html).toContain("—");
    expect(html).not.toContain('aria-label="Add relation"');
  });
});
