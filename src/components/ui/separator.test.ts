import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SEPARATOR_VARIANTS, Separator } from "./separator";

/**
 * DS07 Separator — pin the variant map and render horizontal/vertical, plain,
 * labelled, hairline and semantic/decorative forms.
 */

const h = createElement;

describe("Separator maps", () => {
  it("draws the default line from the --border token", () => {
    expect(SEPARATOR_VARIANTS.default).toBe("bg-border");
  });

  it("keeps the hairline variant lighter for dense lists", () => {
    expect(SEPARATOR_VARIANTS.hairline).toBe("bg-border/60");
    expect(SEPARATOR_VARIANTS.hairline).not.toBe(SEPARATOR_VARIANTS.default);
  });
});

describe("Separator render", () => {
  it("renders a horizontal rule, decorative and inert by default", () => {
    const html = renderToStaticMarkup(h(Separator));
    expect(html).toContain("h-px w-full bg-border");
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("role=");
    // never a keyboard stop
    expect(html).not.toMatch(/tabindex/i);
  });

  it("renders a vertical rule", () => {
    const html = renderToStaticMarkup(h(Separator, { orientation: "vertical" }));
    expect(html).toContain("w-px self-stretch");
  });

  it("renders the hairline variant", () => {
    const html = renderToStaticMarkup(h(Separator, { variant: "hairline" }));
    expect(html).toContain("bg-border/60");
  });

  it("renders an optional centred label between two lines", () => {
    const html = renderToStaticMarkup(h(Separator, { label: "or" }));
    expect(html).toContain("or");
    expect(html).toContain("text-muted");
    expect((html.match(/bg-border/g) ?? []).length).toBe(2);
  });

  it.each(["horizontal", "vertical"] as const)(
    "exposes a semantic separator when decorative=false (%s)",
    (orientation) => {
      const html = renderToStaticMarkup(
        h(Separator, { orientation, decorative: false }),
      );
      expect(html).toContain('role="separator"');
      expect(html).toContain(`aria-orientation="${orientation}"`);
      expect(html).not.toContain('aria-hidden="true"');
    },
  );

  it("labels the semantic separator from a string label", () => {
    const html = renderToStaticMarkup(
      h(Separator, { decorative: false, label: "or" }),
    );
    expect(html).toContain('aria-label="or"');
  });
});
