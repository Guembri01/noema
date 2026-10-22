import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusCell } from "./status-cell";

/**
 * The status cell used to render the selected option twice: once as a tag and
 * once as the text of the native select sitting beside it. The cell now keeps
 * one visible label and overlays the native control.
 */
describe("StatusCell", () => {
  const options = [
    { id: "todo", name: "To do", color: "gray" },
    { id: "done", name: "Done", color: "green" },
  ];

  it("renders one visible chip and one native select", () => {
    const html = renderToStaticMarkup(
      createElement(StatusCell, {
        propertyName: "Status",
        options,
        value: { optionId: "done" },
        editable: true,
        onChange: () => {},
      }),
    );
    expect(html.match(/data-testid="option-chip"/g)).toHaveLength(1);
    expect(html.match(/<select/g)).toHaveLength(1);
    expect(html).toContain(">Done</span>");
    expect(html).toContain('aria-label="Status"');
  });

  it("uses the empty marker when no option is selected", () => {
    const html = renderToStaticMarkup(
      createElement(StatusCell, {
        propertyName: "Status",
        options,
        value: null,
        editable: true,
        onChange: () => {},
      }),
    );
    expect(html).toContain("—");
    expect(html).not.toContain("data-testid=\"option-chip\"");
  });

  it("is display-only when the caller cannot edit", () => {
    const html = renderToStaticMarkup(
      createElement(StatusCell, {
        propertyName: "Status",
        options,
        value: { optionId: "todo" },
        editable: false,
        onChange: () => {},
      }),
    );
    expect(html).not.toContain("<select");
    expect(html).toContain("To do");
  });
});
