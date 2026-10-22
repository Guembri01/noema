import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DateCell } from "./date-cell";
import type { DBProperty } from "./database-types";

describe("DateCell", () => {
  const base = {
    property: { id: "due", name: "Due", type: "DATE", config: null } as DBProperty,
    value: { start: "2026-01-02" },
    editable: true,
    errorMessage: "",
    locale: "en",
    editing: false,
    onEditingChange: () => {},
    onChange: () => {},
  };

  it("renders the legacy single-date input", () => {
    const html = renderToStaticMarkup(createElement(DateCell, base));
    expect(html).toContain('type="date"');
    expect(html).toContain('aria-label="Due"');
  });

  it("renders both date inputs and the all-day control in range mode", () => {
    const html = renderToStaticMarkup(
      createElement(DateCell, {
        ...base,
        property: {
          id: "due",
          name: "Due",
          type: "DATE",
          config: { date: { allowRange: true } },
        } as DBProperty,
        value: { start: "2026-01-02", end: "2026-01-03", allDay: true },
        editing: true,
      }),
    );
    expect(html.match(/type="date"/g)).toHaveLength(2);
    expect(html).toContain("All day");
    expect(html).toContain('aria-label="Due end"');
  });

  it("shows a read-only range as text, not an editor", () => {
    const html = renderToStaticMarkup(
      createElement(DateCell, {
        ...base,
        property: {
          id: "due",
          name: "Due",
          type: "DATE",
          config: { date: { allowRange: true } },
        } as DBProperty,
        value: { start: "2026-01-02", end: "2026-01-03" },
        editable: false,
      }),
    );
    expect(html).not.toContain("<input");
    expect(html).toContain('aria-label="Due"');
  });
});
