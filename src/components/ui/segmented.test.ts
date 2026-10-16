import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SEGMENTED_MAX,
  SEGMENTED_MIN,
  Segmented,
  clampSegmentIndex,
  isValidSegmentCount,
  nextSegmentIndex,
  resolveSegmentKey,
  type SegmentedOption,
} from "./segmented";

/**
 * ds08 — Segmented control maths + static render.
 *
 * The roving-tabindex model is a rotation over the option indexes; the selected
 * indicator is positioned by percent. Both are pure, so they are pinned here,
 * and every variant is statically rendered.
 */

/* -------------------------------------------------------------------------- */
/* Index rotation                                                              */
/* -------------------------------------------------------------------------- */

describe("segmented index rotation", () => {
  it("clamps an index into range", () => {
    expect(clampSegmentIndex(-1, 3)).toBe(0);
    expect(clampSegmentIndex(1, 3)).toBe(1);
    expect(clampSegmentIndex(5, 3)).toBe(2);
    expect(clampSegmentIndex(0, 0)).toBe(0);
  });

  it("rotates with wrap-around", () => {
    expect(nextSegmentIndex(0, 3, 1)).toBe(1);
    expect(nextSegmentIndex(2, 3, 1)).toBe(0); // last → first
    expect(nextSegmentIndex(0, 3, -1)).toBe(2); // first → last
    expect(nextSegmentIndex(1, 3, 5)).toBe(0); // 1 + 5 = 6 → 0
    expect(nextSegmentIndex(1, 3, -5)).toBe(2);
  });

  it("clamps instead of wrapping when wrap is off", () => {
    expect(nextSegmentIndex(2, 3, 1, false)).toBe(2);
    expect(nextSegmentIndex(0, 3, -1, false)).toBe(0);
  });

  it("is stable for a single option", () => {
    expect(nextSegmentIndex(0, 1, 1)).toBe(0);
    expect(nextSegmentIndex(0, 1, -1)).toBe(0);
  });

  it("guards the 2–6 contract", () => {
    expect(SEGMENTED_MIN).toBe(2);
    expect(SEGMENTED_MAX).toBe(6);
    expect(isValidSegmentCount(2)).toBe(true);
    expect(isValidSegmentCount(6)).toBe(true);
    expect(isValidSegmentCount(1)).toBe(false);
    expect(isValidSegmentCount(7)).toBe(false);
    expect(isValidSegmentCount(2.5)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Keyboard model                                                              */
/* -------------------------------------------------------------------------- */

describe("segmented keyboard model", () => {
  it("moves with arrows, wrapping at the ends", () => {
    expect(resolveSegmentKey(3, 0, "ArrowRight")).toBe(1);
    expect(resolveSegmentKey(3, 2, "ArrowRight")).toBe(0);
    expect(resolveSegmentKey(3, 0, "ArrowLeft")).toBe(2);
    expect(resolveSegmentKey(3, 1, "ArrowDown")).toBe(2);
    expect(resolveSegmentKey(3, 1, "ArrowUp")).toBe(0);
  });

  it("jumps to the ends with Home/End", () => {
    expect(resolveSegmentKey(4, 2, "Home")).toBe(0);
    expect(resolveSegmentKey(4, 1, "End")).toBe(3);
  });

  it("skips disabled segments while rotating", () => {
    const disabledMiddle = (i: number) => i === 1;
    expect(resolveSegmentKey(3, 0, "ArrowRight", disabledMiddle)).toBe(2);
    expect(resolveSegmentKey(3, 2, "ArrowLeft", disabledMiddle)).toBe(0);
    // Home/End land on an enabled segment.
    const disabledFirst = (i: number) => i === 0;
    expect(resolveSegmentKey(3, 0, "Home", disabledFirst)).toBe(1);
  });

  it("returns null for keys it does not own", () => {
    expect(resolveSegmentKey(3, 0, "Enter")).toBeNull();
    expect(resolveSegmentKey(3, 0, " ")).toBeNull();
    expect(resolveSegmentKey(3, 0, "Tab")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Render                                                                      */
/* -------------------------------------------------------------------------- */

const OPTIONS: SegmentedOption[] = [
  { value: "all", label: "All" },
  { value: "mine", label: "Mine" },
  { value: "shared", label: "Shared", disabled: true },
];

describe("Segmented render", () => {
  it("renders a radiogroup with one checked segment and roving tabindex", () => {
    const html = renderToStaticMarkup(
      createElement(Segmented, {
        options: OPTIONS,
        defaultValue: "mine",
        ariaLabel: "Filter",
      }),
    );
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Filter"');
    expect(html).toContain('data-count="3"');
    expect((html.match(/role="radio"/g) ?? []).length).toBe(3);
    // Exactly one segment is checked and exactly one is a tab stop.
    expect((html.match(/aria-checked="true"/g) ?? []).length).toBe(1);
    expect((html.match(/aria-checked="false"/g) ?? []).length).toBe(2);
    expect((html.match(/tabindex="0"/g) ?? []).length).toBe(1);
    expect((html.match(/tabindex="-1"/g) ?? []).length).toBe(2);
  });

  it("places the animated indicator on the selected segment", () => {
    const html = renderToStaticMarkup(
      createElement(Segmented, { options: OPTIONS, defaultValue: "mine" }),
    );
    expect(html).toContain('data-testid="segmented-indicator"');
    // Motion rides on the design tokens, not ad-hoc values.
    expect(html).toContain("var(--dur-2)");
    expect(html).toContain("var(--ease-spring)");
    expect(html).toContain("inset-inline-start");
    // Segment 1 of 3 sits one third along.
    expect(html).toContain("inset-inline-start:33.333333333333336%");
    expect(html).toContain("inline-size:33.333333333333336%");
  });

  it("puts the indicator on the first segment by default", () => {
    const html = renderToStaticMarkup(
      createElement(Segmented, { options: OPTIONS }),
    );
    expect(html).toContain("inset-inline-start:0%");
    expect(html).toContain('data-testid="segmented-option-all"');
  });

  it("renders icons and equal-width segments", () => {
    const withIcons: SegmentedOption[] = [
      {
        value: "list",
        label: "List",
        icon: createElement("span", { "data-icon": "list" }, "★"),
      },
      { value: "board", label: "Board", icon: createElement("span", { "data-icon": "board" }, "▦") },
    ];
    const html = renderToStaticMarkup(
      createElement(Segmented, { options: withIcons, size: "sm" }),
    );
    expect(html).toContain('data-icon="list"');
    expect(html).toContain('data-icon="board"');
    // Equal widths come from flex-1 basis-0.
    expect(html).toContain("basis-0");
    expect(html).toContain("h-7");
  });

  it("disables the whole control when asked", () => {
    const html = renderToStaticMarkup(
      createElement(Segmented, { options: OPTIONS, disabled: true }),
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('data-testid="segmented-option-shared"');
  });

  it("marks a single disabled option while the control stays enabled", () => {
    const html = renderToStaticMarkup(
      createElement(Segmented, { options: OPTIONS, defaultValue: "mine" }),
    );
    // The disabled attribute is emitted before the test id in JSX order.
    expect(
      /disabled=""[^>]*data-testid="segmented-option-shared"/.test(html),
    ).toBe(true);
  });
});
