import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SECTION_HEADING_CLASS, SECTION_TONES, Section } from "./section";

/**
 * DS07 Section — pin the tone map and render the settings-section shape
 * (heading + description + action + `gap-6` rhythm) for both tones and levels.
 */

const h = createElement;

describe("Section maps", () => {
  it("keeps a neutral heading by default and danger only for the danger tone", () => {
    expect(SECTION_TONES.default).toBe("text-fg");
    expect(SECTION_TONES.danger).toBe("text-danger");
    expect(SECTION_TONES.danger).not.toContain("bg-");
  });

  it("uses the canonical section-title ramp", () => {
    expect(SECTION_HEADING_CLASS).toContain("text-xl");
    expect(SECTION_HEADING_CLASS).toContain("font-semibold");
    expect(SECTION_HEADING_CLASS).toContain("tracking-[-0.01em]");
  });
});

describe("Section render", () => {
  it("renders a section with the shared vertical rhythm", () => {
    const html = renderToStaticMarkup(
      h(Section, { title: "General" }, h("div", null, "body")),
    );
    expect(html).toContain("<section");
    expect(html).toContain("gap-6");
    expect(html).toContain("text-xl font-semibold tracking-[-0.01em]");
    expect(html).toContain("General");
    expect(html).toContain("body");
  });

  it("renders description and right-side action", () => {
    const html = renderToStaticMarkup(
      h(Section, {
        title: "Members",
        description: "People with access",
        action: h("button", null, "Invite"),
      }),
    );
    expect(html).toContain("People with access");
    expect(html).toContain("text-muted");
    expect(html).toContain("Invite");
    expect(html).toContain("justify-between");
  });

  it("renders the danger tone", () => {
    const html = renderToStaticMarkup(h(Section, { title: "Delete", tone: "danger" }));
    expect(html).toContain("text-danger");
    expect(html).not.toContain("text-fg");
  });

  it.each([2, 3, 4] as const)("renders a semantic h%s heading", (level) => {
    const html = renderToStaticMarkup(h(Section, { title: "X", level }));
    expect(html).toContain(`<h${level}`);
    // styling is identical regardless of the semantic level
    expect(html).toContain("text-xl font-semibold tracking-[-0.01em]");
  });

  it("omits the action row when no action is given", () => {
    const html = renderToStaticMarkup(h(Section, { title: "X" }));
    expect(html).not.toContain("shrink-0");
  });
});
