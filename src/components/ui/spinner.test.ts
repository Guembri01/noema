import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SPINNER_SIZE_CLASS,
  SPINNER_SIZES,
  Spinner,
  spinnerA11y,
  type SpinnerProps,
  type SpinnerSize,
} from "./spinner";

/**
 * ds04 — the spinner's size→class map and its aria contract, plus a render
 * check for every size.
 */

const render = (props: SpinnerProps = {}) =>
  renderToStaticMarkup(createElement(Spinner, props));

const SIZES = Object.keys(SPINNER_SIZES) as SpinnerSize[];

describe("spinner size map", () => {
  it("covers every size, ordered and distinct", () => {
    expect(Object.keys(SPINNER_SIZE_CLASS).sort()).toEqual([...SIZES].sort());
    const px = SIZES.map((size) => SPINNER_SIZES[size]);
    for (let i = 1; i < px.length; i += 1) {
      expect(px[i]).toBeGreaterThan(px[i - 1]);
    }
    expect(new Set(Object.values(SPINNER_SIZE_CLASS)).size).toBe(SIZES.length);
  });
});

describe("spinnerA11y", () => {
  it("hides an unlabelled spinner", () => {
    expect(spinnerA11y()).toEqual({ "aria-hidden": true });
  });

  it("promotes a labelled spinner to a status region", () => {
    expect(spinnerA11y("Loading")).toEqual({
      role: "status",
      "aria-label": "Loading",
    });
  });
});

describe("Spinner markup", () => {
  it.each(SIZES)("renders the %s size in currentColor", (size) => {
    const html = render({ size });
    expect(html).toContain(SPINNER_SIZE_CLASS[size]);
    expect(html).toContain("animate-spin");
    expect(html).toContain("stroke-current");
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("role=");
  });

  it("exposes a labelled spinner and drops aria-hidden", () => {
    const html = render({ label: "Uploading" });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Uploading"');
    expect(html).not.toContain('aria-hidden="true"');
  });
});
