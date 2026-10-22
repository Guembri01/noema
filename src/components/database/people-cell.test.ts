import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PeopleCell } from "./people-cell";

const members = [
  { id: "u1", name: "Amara Okafor" },
  { id: "u2", name: "Louis Marchand" },
];

describe("PeopleCell", () => {
  it("renders names once and the add control for editors", () => {
    const html = renderToStaticMarkup(
      createElement(PeopleCell, {
        propertyName: "Owner",
        value: { names: ["Amara Okafor", "Amara Okafor", ""] },
        editable: true,
        locale: "en",
        members,
        onChange: () => {},
      }),
    );
    expect(html.match(/title="Amara Okafor"/g)).toHaveLength(1);
    expect(html.match(/aria-label="Remove: Amara Okafor"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Add person"');
  });

  it("renders a read-only empty marker without a picker", () => {
    const html = renderToStaticMarkup(
      createElement(PeopleCell, {
        propertyName: "Owner",
        value: { names: [] },
        editable: false,
        locale: "en",
        members,
        onChange: () => {},
      }),
    );
    expect(html).toContain("—");
    expect(html).not.toContain('aria-label="Add person"');
  });
});
