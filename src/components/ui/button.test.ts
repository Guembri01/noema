import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BUTTON_BASE,
  BUTTON_SIZES,
  BUTTON_SOFT_VARIANTS,
  BUTTON_VARIANTS,
  Button,
  buttonClasses,
  buttonDisabled,
  loadingContentClass,
} from "./button";

/**
 * Node tests for the Button primitive: the variant/size class maps, the
 * loading width-preservation rule (content hidden, never removed) and a static
 * render for every variant / tone / size / state. No DOM.
 */

const VARIANTS = ["primary", "secondary", "ghost", "subtle", "danger"] as const;
const SIZES = ["xs", "sm", "md", "lg", "icon", "iconOnly"] as const;

describe("button class maps", () => {
  it("exposes every documented variant on a token", () => {
    expect(Object.keys(BUTTON_VARIANTS).sort()).toEqual(
      [...VARIANTS].sort(),
    );
    expect(Object.keys(BUTTON_SOFT_VARIANTS).sort()).toEqual(
      [...VARIANTS].sort(),
    );
    // Colour comes from a token, never a raw palette class.
    expect(BUTTON_VARIANTS.primary).toContain("bg-action");
    expect(BUTTON_VARIANTS.secondary).toContain("border-border");
    expect(BUTTON_VARIANTS.ghost).toContain("hover:bg-surface-2");
    expect(BUTTON_VARIANTS.subtle).toContain("bg-surface-2");
    expect(BUTTON_VARIANTS.danger).toContain("bg-danger");
  });

  it("gives danger both a solid and a soft spelling", () => {
    expect(BUTTON_VARIANTS.danger).toContain("bg-danger ");
    expect(BUTTON_SOFT_VARIANTS.danger).toContain("bg-danger-soft");
    expect(buttonClasses({ variant: "danger" })).toContain("bg-danger");
    expect(buttonClasses({ variant: "danger", tone: "soft" })).toContain(
      "bg-danger-soft",
    );
  });

  it("exposes xs–lg plus icon and iconOnly", () => {
    for (const size of SIZES) {
      expect(BUTTON_SIZES[size]).toBeTruthy();
    }
    expect(BUTTON_SIZES.xs).toContain("h-6");
    expect(BUTTON_SIZES.lg).toContain("h-11");
    expect(BUTTON_SIZES.icon).toContain("w-7");
    expect(BUTTON_SIZES.iconOnly).toContain("w-9");
  });

  it("always carries the shared focus + press + disabled vocabulary", () => {
    const classes = buttonClasses({});
    expect(classes).toContain("focus-ring");
    expect(classes).toContain("u-interactive");
    expect(classes).toContain("disabled:opacity-50");
    expect(BUTTON_BASE).toContain("disabled:cursor-not-allowed");
  });

  it("merges a caller className", () => {
    expect(buttonClasses({ className: "w-full" })).toContain("w-full");
  });
});

describe("loading width-preservation rule", () => {
  it("hides the content with visibility, never display:none", () => {
    expect(loadingContentClass(true)).toBe("invisible");
    expect(loadingContentClass(false)).toBe("");
    expect(loadingContentClass(true)).not.toContain("hidden");
  });

  it("disables the button while loading (no double submit)", () => {
    expect(buttonDisabled({ loading: true })).toBe(true);
    expect(buttonDisabled({ disabled: true })).toBe(true);
    expect(buttonDisabled({ loading: true, disabled: false })).toBe(true);
    expect(buttonDisabled({})).toBe(false);
  });

  it("keeps the label in the DOM (so the width does not change)", () => {
    const html = renderToStaticMarkup(
      createElement(Button, { loading: true }, "Save"),
    );
    expect(html).toContain("Save"); // still present → width preserved
    expect(html).toContain("invisible"); // hidden by visibility
    expect(html).toContain("aria-busy=\"true\"");
    expect(html).toContain("disabled");
    expect(html).toMatch(/<svg[^>]*animate-spin/); // spinner replaces content
  });
});

describe("renderToStaticMarkup — every variant and tone", () => {
  for (const variant of VARIANTS) {
    it(`renders ${variant}`, () => {
      const html = renderToStaticMarkup(
        createElement(Button, { variant }, variant),
      );
      expect(html).toContain(`>${variant}<`);
      expect(html).toContain(BUTTON_VARIANTS[variant].split(" ")[0]);
    });
    it(`renders soft ${variant}`, () => {
      const html = renderToStaticMarkup(
        createElement(Button, { variant, tone: "soft" }, variant),
      );
      expect(html).toContain(`>${variant}<`);
    });
  }
});

describe("renderToStaticMarkup — sizes and states", () => {
  for (const size of SIZES) {
    it(`renders size ${size}`, () => {
      const html = renderToStaticMarkup(
        createElement(Button, { size }, "x"),
      );
      expect(html).toContain(BUTTON_SIZES[size].split(" ")[0]);
    });
  }

  it("renders disabled", () => {
    const html = renderToStaticMarkup(
      createElement(Button, { disabled: true }, "x"),
    );
    expect(html).toContain("disabled");
  });

  it("renders leftIcon and rightIcon", () => {
    const html = renderToStaticMarkup(
      createElement(
        Button,
        { leftIcon: createElement("i", null, "L"), rightIcon: createElement("i", null, "R") },
        "Label",
      ),
    );
    expect(html).toContain(">L<");
    expect(html).toContain(">Label<");
    expect(html).toContain(">R<");
    expect(html).toContain('aria-hidden="true"');
  });

  it("renders an asChild link with the button classes", () => {
    const html = renderToStaticMarkup(
      createElement(
        Button,
        { asChild: true },
        createElement("a", { href: "/x" }, "Go"),
      ),
    );
    expect(html).toContain("<a");
    expect(html).toContain('href="/x"');
    expect(html).toContain(">Go<");
    expect(html).toContain("focus-ring");
  });

  it("renders an asChild link as aria-disabled while loading", () => {
    const html = renderToStaticMarkup(
      createElement(
        Button,
        { asChild: true, loading: true },
        createElement("a", { href: "/x" }, "Go"),
      ),
    );
    expect(html).toContain("aria-disabled=\"true\"");
    expect(html).toContain("aria-busy=\"true\"");
    expect(html).toContain("invisible");
  });
});
