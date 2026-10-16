import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Radio,
  RadioGroup,
  isRadioNavKey,
  nextRadioIndex,
  radioAriaChecked,
  radioTabIndex,
} from "./radio";

/**
 * ds02 — Radio + RadioGroup. These node tests pin the selection mapping, the
 * roving-tabindex index maths (the only logic), and the static markup for the
 * selected/unselected/disabled states.
 */

const group = (
  groupProps: Parameters<typeof RadioGroup>[0],
  radios: Array<Parameters<typeof Radio>[0]>,
): string =>
  renderToStaticMarkup(
    createElement(RadioGroup, groupProps, radios.map((r) => createElement(Radio, r))),
  );

describe("radio state mapping", () => {
  it("maps selection to aria-checked", () => {
    expect(radioAriaChecked(true)).toBe("true");
    expect(radioAriaChecked(false)).toBe("false");
  });

  it("keeps exactly one roving tab stop", () => {
    expect(radioTabIndex(true)).toBe(0);
    expect(radioTabIndex(false)).toBe(-1);
  });

  it("recognises only the group's navigation keys", () => {
    for (const key of [
      "ArrowDown",
      "ArrowRight",
      "ArrowUp",
      "ArrowLeft",
      "Home",
      "End",
    ]) {
      expect(isRadioNavKey(key)).toBe(true);
    }
    expect(isRadioNavKey("Enter")).toBe(false);
    expect(isRadioNavKey("a")).toBe(false);
  });

  it("moves with arrow keys, wrapping at both ends", () => {
    expect(nextRadioIndex(0, 3, "ArrowRight")).toBe(1);
    expect(nextRadioIndex(2, 3, "ArrowRight")).toBe(0);
    expect(nextRadioIndex(0, 3, "ArrowDown")).toBe(1);
    expect(nextRadioIndex(0, 3, "ArrowLeft")).toBe(2);
    expect(nextRadioIndex(2, 3, "ArrowUp")).toBe(1);
    expect(nextRadioIndex(1, 3, "Home")).toBe(0);
    expect(nextRadioIndex(1, 3, "End")).toBe(2);
    expect(nextRadioIndex(5, 3, "ArrowRight")).toBe(0);
  });

  it("returns -1 for an empty group", () => {
    expect(nextRadioIndex(0, 0, "ArrowRight")).toBe(-1);
  });
});

describe("radio render states", () => {
  const radios: Array<Parameters<typeof Radio>[0]> = [
    { value: "free", label: "Free" },
    { value: "pro", label: "Pro" },
    { value: "team", label: "Team", disabled: true },
  ];

  it("renders a radiogroup with the selected radio tabbable", () => {
    const html = group({ value: "free", "aria-label": "Plan" }, radios);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Plan"');
    expect(html).toContain('aria-orientation="vertical"');
    // Selected radio: checked + the single Tab stop.
    expect(html).toContain('data-value="free"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('tabindex="0"');
    // Everything else is one stop behind.
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("focus-ring");
    expect(html).toContain("min-h-11");
  });

  it("renders unselected radios with aria-checked=false", () => {
    const html = group({ value: "pro", "aria-label": "Plan" }, radios);
    expect(html).toContain('data-value="pro"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('aria-checked="true"');
  });

  it("renders a disabled radio as disabled with reduced opacity", () => {
    const html = group({ value: "free", "aria-label": "Plan" }, radios);
    expect(html).toContain('data-value="team"');
    expect(html).toContain("disabled");
    expect(html).toContain("opacity-50");
  });

  it("wires each label to its radio", () => {
    const html = group({ "aria-label": "Plan" }, [
      { value: "a", id: "radio-a", label: "A", description: "First" },
    ]);
    expect(html).toContain('id="radio-a"');
    expect(html).toContain('for="radio-a"');
    expect(html).toContain('id="radio-a-description"');
    expect(html).toContain("First");
  });

  it("supports a horizontal orientation and a visible group label", () => {
    const html = group({ label: "Pick one", orientation: "horizontal" }, radios);
    expect(html).toContain('aria-orientation="horizontal"');
    expect(html).toContain('aria-labelledby=');
    expect(html).toContain("Pick one");
  });
});
