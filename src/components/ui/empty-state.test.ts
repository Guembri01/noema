import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EMPTY_STATE_VARIANTS,
  EmptyState,
  type EmptyStateProps,
  type EmptyStateVariant,
} from "./empty-state";

/**
 * ds04 — the empty-state densities and the full render contract: icon, title,
 * description, both actions and the tip/keyboard-hint row.
 */

const render = (props: EmptyStateProps) =>
  renderToStaticMarkup(createElement(EmptyState, props));

const VARIANTS = Object.keys(EMPTY_STATE_VARIANTS) as EmptyStateVariant[];

describe("EMPTY_STATE_VARIANTS", () => {
  it("ships every density, each with the full slot set", () => {
    expect(VARIANTS).toEqual(["full", "compact", "inline"]);
    for (const variant of VARIANTS) {
      expect(Object.keys(EMPTY_STATE_VARIANTS[variant]).sort()).toEqual([
        "actions",
        "description",
        "icon",
        "root",
        "tip",
        "title",
      ]);
    }
  });

  it("makes compact denser than full, and inline denser still", () => {
    const compact = EMPTY_STATE_VARIANTS.compact;
    const full = EMPTY_STATE_VARIANTS.full;
    const inline = EMPTY_STATE_VARIANTS.inline;
    expect(compact.root).toContain("py-6");
    expect(full.root).toContain("py-12");
    expect(inline.root).toContain("py-1.5");
    expect(inline.root).toContain("flex-row");
    expect(compact.icon).toContain("size-8");
    expect(full.icon).toContain("size-10");
    expect(inline.icon).toBe("size-6");
  });
});

describe("EmptyState markup", () => {
  it("renders title, description, both actions and the tip shortcut", () => {
    const html = render({
      variant: "full",
      icon: createElement("span", null, "★"),
      title: "No pages yet",
      description: "Create your first page to get started.",
      primaryAction: createElement("button", null, "New page"),
      secondaryAction: createElement("button", null, "Import"),
      tip: "or press",
      shortcut: "N",
    });

    expect(html).toContain('data-empty-state="full"');
    expect(html).toContain("No pages yet");
    expect(html).toContain("Create your first page to get started.");
    expect(html).toContain("New page");
    expect(html).toContain("Import");
    expect(html).toContain("or press");
    expect(html).toContain("<kbd"); // the shortcut renders as a Kbd
    expect(html).toContain(">N</kbd>");
  });

  it("renders a bare compact state without empty chrome", () => {
    const html = render({ variant: "compact", title: "Nothing here" });
    expect(html).toContain('data-empty-state="compact"');
    expect(html).toContain("Nothing here");
    expect(html).not.toContain("<kbd");
    expect(html).not.toContain("<button");
  });

  it("merges caller classes and props", () => {
    const html = render({
      variant: "compact",
      title: "Empty column",
      className: "h-full",
      "data-testid": "column-empty",
    } as EmptyStateProps);
    expect(html).toContain("h-full");
    expect(html).toContain('data-testid="column-empty"');
  });
});
