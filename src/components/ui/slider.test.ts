import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RangeSlider,
  Slider,
  applyKeyMove,
  clamp,
  formatSliderValue,
  keyMove,
  nearestThumbIndex,
  orderRange,
  percentFromValue,
  setRangeThumb,
  snapToStep,
  stepDecimals,
  tickValues,
  valueFromPercent,
} from "./slider";

/**
 * ds08 — Slider maths + static render.
 *
 * The geometry lives in pure helpers (clamped/stepped values, percent ↔
 * position, range-thumb ordering, keyboard deltas). These node tests pin that
 * maths and statically render every variant so a regression in the wiring shows
 * up without a DOM.
 */

/* -------------------------------------------------------------------------- */
/* Value clamping / stepping maths                                             */
/* -------------------------------------------------------------------------- */

describe("slider value clamping and stepping", () => {
  it("clamps into the bounds and tolerates an inverted range", () => {
    expect(clamp(150, 0, 100)).toBe(100);
    expect(clamp(-5, 0, 100)).toBe(0);
    expect(clamp(50, 0, 100)).toBe(50);
    // A reversed min/max is normalised rather than producing NaN.
    expect(clamp(5, 10, 0)).toBe(5);
    expect(clamp(Number.NaN, 3, 9)).toBe(3);
  });

  it("snaps onto the step lattice, cleaning float noise", () => {
    expect(snapToStep(37, 0, 10)).toBe(40);
    expect(snapToStep(32, 0, 10)).toBe(30);
    expect(snapToStep(0.2 + 0.1, 0, 0.1)).toBe(0.3);
    expect(snapToStep(3.14159, 0, 0.25)).toBe(3.25);
    // A zero/invalid step is a no-op rather than a divide-by-zero.
    expect(snapToStep(3.7, 0, 0)).toBe(3.7);
  });

  it("counts the decimals of a step", () => {
    expect(stepDecimals(1)).toBe(0);
    expect(stepDecimals(0.1)).toBe(1);
    expect(stepDecimals(0.25)).toBe(2);
  });

  it("formats a value with an optional unit", () => {
    expect(formatSliderValue(30)).toBe("30");
    expect(formatSliderValue(30, "px")).toBe("30 px");
  });
});

/* -------------------------------------------------------------------------- */
/* Percent → position mapping                                                  */
/* -------------------------------------------------------------------------- */

describe("slider percent ↔ position", () => {
  it("maps a value to a 0..100 track percent", () => {
    expect(percentFromValue(50, 0, 100)).toBe(50);
    expect(percentFromValue(25, 0, 100)).toBe(25);
    expect(percentFromValue(-10, 0, 100)).toBe(0);
    expect(percentFromValue(200, 0, 200)).toBe(100);
    // A degenerate range never divides by zero.
    expect(percentFromValue(5, 5, 5)).toBe(0);
  });

  it("maps a percent back to a snapped value", () => {
    expect(valueFromPercent(50, 0, 100, 5)).toBe(50);
    expect(valueFromPercent(33, 0, 100, 5)).toBe(35);
    expect(valueFromPercent(100, 0, 100, 5)).toBe(100);
    expect(valueFromPercent(-20, 0, 100, 5, false)).toBe(0);
  });

  it("keeps the raw position when snapping is off (1:1 drag)", () => {
    expect(valueFromPercent(33, 0, 100, 5, false)).toBe(33);
    expect(valueFromPercent(33, 0, 100, 5)).toBe(35);
  });

  it("round-trips value → percent → value on the lattice", () => {
    for (const value of [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
      expect(valueFromPercent(percentFromValue(value, 0, 100), 0, 100, 10)).toBe(
        value,
      );
    }
  });

  it("lists ticks for a range and refuses an absurd count", () => {
    expect(tickValues(0, 10, 2)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(tickValues(0, 1, 0.5)).toEqual([0, 0.5, 1]);
    // 101 ticks is past the safety limit.
    expect(tickValues(0, 100, 1)).toEqual([]);
    expect(tickValues(5, 5, 1)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Range-thumb ordering                                                        */
/* -------------------------------------------------------------------------- */

describe("range-thumb ordering", () => {
  it("normalises a pair into ascending order", () => {
    expect(orderRange(80, 20)).toEqual([20, 80]);
    expect(orderRange(20, 80)).toEqual([20, 80]);
    expect(orderRange(40, 40)).toEqual([40, 40]);
  });

  it("picks the nearer thumb (ties favour the low one)", () => {
    expect(nearestThumbIndex(10, [20, 80])).toBe(0);
    expect(nearestThumbIndex(90, [20, 80])).toBe(1);
    expect(nearestThumbIndex(50, [20, 80])).toBe(0);
  });

  it("moves one thumb without crossing its sibling", () => {
    const opts = { min: 0, max: 100, step: 1 };
    expect(setRangeThumb([20, 80], 0, 35, opts)).toEqual([35, 80]);
    expect(setRangeThumb([20, 80], 1, 65, opts)).toEqual([20, 65]);
    // Drag past the sibling: it stops at the sibling, order preserved.
    expect(setRangeThumb([20, 80], 0, 90, opts)).toEqual([80, 80]);
    expect(setRangeThumb([20, 80], 1, 5, opts)).toEqual([20, 20]);
    // Bounds are respected and the new value snaps.
    expect(setRangeThumb([20, 80], 1, 999, opts)).toEqual([20, 100]);
    expect(setRangeThumb([20, 80], 0, -999, opts)).toEqual([0, 80]);
    expect(setRangeThumb([20, 80], 0, 33, { min: 0, max: 100, step: 5 })).toEqual(
      [35, 80],
    );
  });

  it("re-orders a pair handed in reversed", () => {
    expect(setRangeThumb([80, 20], 1, 40, { min: 0, max: 100, step: 1 })).toEqual([
      20, 40,
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Keyboard deltas                                                             */
/* -------------------------------------------------------------------------- */

describe("slider keyboard deltas", () => {
  it("maps arrows to one step and Shift to ten", () => {
    expect(keyMove("ArrowRight", false, 5)).toEqual({ kind: "delta", amount: 5 });
    expect(keyMove("ArrowUp", false, 5)).toEqual({ kind: "delta", amount: 5 });
    expect(keyMove("ArrowLeft", false, 5)).toEqual({ kind: "delta", amount: -5 });
    expect(keyMove("ArrowDown", true, 5)).toEqual({ kind: "delta", amount: -50 });
    expect(keyMove("ArrowRight", true, 1)).toEqual({ kind: "delta", amount: 10 });
  });

  it("maps PageUp/PageDown to ten steps and Home/End to bounds", () => {
    expect(keyMove("PageUp", false, 2)).toEqual({ kind: "delta", amount: 20 });
    expect(keyMove("PageDown", false, 2)).toEqual({ kind: "delta", amount: -20 });
    expect(keyMove("Home", false, 1)).toEqual({ kind: "bound", bound: "min" });
    expect(keyMove("End", false, 1)).toEqual({ kind: "bound", bound: "max" });
    expect(keyMove("Enter", false, 1)).toBeNull();
  });

  it("applies a key, snapping and clamping the result", () => {
    const bounds = { min: 0, max: 100, step: 5, shift: false };
    expect(applyKeyMove(50, "ArrowRight", bounds)).toBe(55);
    expect(applyKeyMove(50, "ArrowLeft", bounds)).toBe(45);
    expect(applyKeyMove(95, "ArrowRight", { ...bounds, shift: true })).toBe(100);
    expect(applyKeyMove(5, "ArrowLeft", { ...bounds, shift: true })).toBe(0);
    expect(applyKeyMove(50, "Home", bounds)).toBe(0);
    expect(applyKeyMove(50, "End", bounds)).toBe(100);
    expect(applyKeyMove(50, "Tab", bounds)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Render                                                                      */
/* -------------------------------------------------------------------------- */

describe("Slider render", () => {
  it("renders a labelled single slider with a value bubble and ticks", () => {
    const html = renderToStaticMarkup(
      createElement(Slider, {
        defaultValue: 30,
        min: 0,
        max: 100,
        step: 10,
        label: "Opacity",
        showBubble: true,
        showTicks: true,
      }),
    );
    expect(html).toContain('data-testid="slider"');
    expect(html).toContain('data-testid="slider-thumb"');
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-valuenow="30"');
    expect(html).toContain('aria-valuetext="30"');
    expect(html).toContain('aria-orientation="horizontal"');
    expect(html).toContain("Opacity");
    expect(html).toContain("tabular-nums");
  });

  it("renders a unit-suffixed readout", () => {
    const html = renderToStaticMarkup(
      createElement(Slider, { defaultValue: 12, unit: "px", showBubble: true }),
    );
    expect(html).toContain("12 px");
    expect(html).toContain('aria-valuetext="12 px"');
  });

  it("renders a disabled slider as an untabbable control", () => {
    const html = renderToStaticMarkup(
      createElement(Slider, { defaultValue: 50, disabled: true }),
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('tabindex="-1"');
  });
});

describe("RangeSlider render", () => {
  it("renders two labelled thumbs and a range bubble", () => {
    const html = renderToStaticMarkup(
      createElement(RangeSlider, {
        defaultValue: [20, 80],
        unit: "px",
        label: "Width",
        showBubble: true,
      }),
    );
    expect(html).toContain('data-testid="range-slider"');
    expect((html.match(/role="slider"/g) ?? []).length).toBe(2);
    expect(html).toContain('aria-valuenow="20"');
    expect(html).toContain('aria-valuenow="80"');
    expect(html).toContain('aria-label="Width minimum"');
    expect(html).toContain('aria-label="Width maximum"');
    expect(html).toContain("20 px – 80 px");
  });

  it("normalises a reversed defaultValue on first render", () => {
    const html = renderToStaticMarkup(
      createElement(RangeSlider, { defaultValue: [90, 10] }),
    );
    // The low thumb (10) is rendered before the high thumb (90).
    expect(html.indexOf('aria-valuenow="10"')).toBeLessThan(
      html.indexOf('aria-valuenow="90"'),
    );
  });
});
