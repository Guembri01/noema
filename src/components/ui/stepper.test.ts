import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Stepper,
  clampNumber,
  isOutOfRange,
  isValidNumber,
  parseNumberInput,
  stepDecimals,
  stepNumber,
} from "./stepper";

/**
 * ds08 — Stepper maths + static render.
 *
 * The field is a clamped numeric input with − / + buttons; the clamp/step/parse
 * maths and the invalid-state wiring are pinned here without a DOM.
 */

/* -------------------------------------------------------------------------- */
/* Clamping / stepping maths                                                   */
/* -------------------------------------------------------------------------- */

describe("stepper clamping and stepping", () => {
  it("clamps to the bounds, open when a bound is absent", () => {
    expect(clampNumber(150, 0, 100)).toBe(100);
    expect(clampNumber(-5, 0, 100)).toBe(0);
    expect(clampNumber(42, undefined, undefined)).toBe(42);
    expect(clampNumber(42, 50, undefined)).toBe(50);
    expect(clampNumber(42, undefined, 10)).toBe(10);
  });

  it("steps by the step, cleans float noise and clamps", () => {
    expect(stepNumber(9, 1, { min: 0, max: 10, step: 1 })).toBe(10);
    expect(stepNumber(10, 1, { min: 0, max: 10, step: 1 })).toBe(10);
    expect(stepNumber(0, -1, { min: 0, max: 10, step: 1 })).toBe(0);
    expect(stepNumber(0.2, 1, { step: 0.1 })).toBe(0.3);
    expect(stepNumber(0.3, -1, { step: 0.1 })).toBe(0.2);
    expect(stepNumber(95, 1, { min: 0, max: 100, step: 10 })).toBe(100);
    expect(stepNumber(3, 1, {})).toBe(4);
  });

  it("counts the decimals of a step", () => {
    expect(stepDecimals(1)).toBe(0);
    expect(stepDecimals(0.5)).toBe(1);
  });

  it("parses typed text, rejecting blank and junk", () => {
    expect(parseNumberInput(" 42 ")).toBe(42);
    expect(parseNumberInput("-3.5")).toBe(-3.5);
    expect(parseNumberInput("1e3")).toBe(1000);
    expect(parseNumberInput("")).toBeNull();
    expect(parseNumberInput("   ")).toBeNull();
    expect(parseNumberInput("abc")).toBeNull();
  });

  it("validates a value against the bounds", () => {
    expect(isValidNumber(5, 0, 10)).toBe(true);
    expect(isValidNumber(5, undefined, undefined)).toBe(true);
    expect(isValidNumber(11, 0, 10)).toBe(false);
    expect(isValidNumber(-1, 0, 10)).toBe(false);
    expect(isValidNumber(null, 0, 10)).toBe(false);
    expect(isOutOfRange(11, 0, 10)).toBe(true);
    expect(isOutOfRange(5, 0, 10)).toBe(false);
    expect(isOutOfRange(5, undefined, undefined)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Render                                                                      */
/* -------------------------------------------------------------------------- */

describe("Stepper render", () => {
  it("renders a labelled spinbutton with − / + and a unit suffix", () => {
    const html = renderToStaticMarkup(
      createElement(Stepper, {
        defaultValue: 5,
        min: 0,
        max: 10,
        label: "Count",
        unit: "%",
      }),
    );
    expect(html).toContain('data-testid="stepper"');
    expect(html).toContain('role="spinbutton"');
    expect(html).toContain('aria-valuenow="5"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="10"');
    expect(html).toContain('aria-label="Decrease"');
    expect(html).toContain('aria-label="Increase"');
    expect(html).toContain("Count");
    expect(html).toContain("%");
  });

  it("disables − at the lower bound and + at the upper bound", () => {
    const atMin = renderToStaticMarkup(
      createElement(Stepper, { defaultValue: 0, min: 0, max: 10 }),
    );
    expect(/aria-label="Decrease"[^>]*disabled=""/.test(atMin)).toBe(true);
    expect(/aria-label="Increase"[^>]*disabled=""/.test(atMin)).toBe(false);

    const atMax = renderToStaticMarkup(
      createElement(Stepper, { defaultValue: 10, min: 0, max: 10 }),
    );
    expect(/aria-label="Increase"[^>]*disabled=""/.test(atMax)).toBe(true);
  });

  it("wires the invalid state to a danger ring and a message", () => {
    const html = renderToStaticMarkup(
      createElement(Stepper, {
        defaultValue: 5,
        min: 0,
        max: 10,
        invalid: true,
        errorMessage: "Too small",
      }),
    );
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("aria-describedby=");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Too small");
    expect(html).toContain("text-danger");
    expect(html).toContain("border-danger");
  });

  it("does not announce an error when the field is valid", () => {
    const html = renderToStaticMarkup(
      createElement(Stepper, { defaultValue: 5, min: 0, max: 10 }),
    );
    expect(html).not.toContain('aria-invalid="true"');
    expect(html).not.toContain('role="alert"');
  });

  it("renders a disabled field with disabled buttons", () => {
    const html = renderToStaticMarkup(
      createElement(Stepper, { defaultValue: 5, disabled: true }),
    );
    expect(html).toContain('aria-label="Decrease"');
    expect(/aria-label="Decrease"[^>]*disabled=""/.test(html)).toBe(true);
    expect(/aria-label="Increase"[^>]*disabled=""/.test(html)).toBe(true);
  });
});
