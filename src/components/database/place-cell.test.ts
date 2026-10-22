import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlaceCell } from "./place-cell";

describe("PlaceCell", () => {
  it("renders a stored place read-only", () => {
    const html = renderToStaticMarkup(
      createElement(PlaceCell, {
        propertyName: "Place",
        value: { lat: 48.8566, lng: 2.3522, label: "Paris" },
        editable: false,
        locale: "en",
        onChange: () => {},
      }),
    );
    expect(html).toContain("Paris");
    expect(html).not.toContain("<input");
  });

  it("opens the three-field editor for editors", () => {
    const html = renderToStaticMarkup(
      createElement(PlaceCell, {
        propertyName: "Place",
        value: null,
        editable: true,
        locale: "en",
        onChange: () => {},
      }),
    );
    expect(html).toContain('aria-label="Place"');
  });
});
