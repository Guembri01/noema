import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IconCell } from "./icon-cell";

describe("IconCell", () => {
  it("renders a stored glyph and a remove control for editors", () => {
    const html = renderToStaticMarkup(
      createElement(IconCell, {
        propertyName: "Icon",
        value: { emoji: "🚀" },
        editable: true,
        locale: "en",
        onChange: () => {},
      }),
    );
    expect(html).toContain("🚀");
    expect(html).toContain('aria-label="Remove Icon"');
  });

  it("falls back to the legacy text value read-only", () => {
    const html = renderToStaticMarkup(
      createElement(IconCell, {
        propertyName: "Icon",
        value: { text: "★" },
        editable: false,
        locale: "en",
        onChange: () => {},
      }),
    );
    expect(html).toContain("★");
    expect(html).not.toContain("<button");
  });
});
