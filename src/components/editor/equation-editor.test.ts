import { describe, expect, it } from "vitest";
import {
  EQUATION_VIEW_OPTIONS,
  equationError,
  toggleEquationView,
} from "./equation-editor";

/**
 * ds05 — equation editor. The dialog chrome is React + a portal, so the pure
 * mappings are pinned here: the LaTeX/Preview switch and the KaTeX error
 * report that drives the inline danger state.
 */

describe("equation view switch", () => {
  it("flips between source and preview", () => {
    expect(toggleEquationView("source")).toBe("preview");
    expect(toggleEquationView("preview")).toBe("source");
    expect(toggleEquationView(toggleEquationView("source"))).toBe("source");
  });

  it("offers exactly LaTeX then Preview", () => {
    expect(EQUATION_VIEW_OPTIONS.map((option) => option.value)).toEqual([
      "source",
      "preview",
    ]);
    expect(EQUATION_VIEW_OPTIONS.map((option) => option.label)).toEqual([
      "LaTeX",
      "Preview",
    ]);
  });
});

describe("equationError", () => {
  it("accepts valid LaTeX (including empty source)", () => {
    expect(equationError("")).toBeNull();
    expect(equationError("   ")).toBeNull();
    expect(equationError("\\frac{a}{b}")).toBeNull();
    expect(equationError("c = \\sqrt{a^2 + b^2}")).toBeNull();
  });

  it("returns a message for broken LaTeX", () => {
    const message = equationError("\\frac{1}{");
    expect(typeof message).toBe("string");
    expect(message && message.length).toBeGreaterThan(0);
    // The KaTeX prefix is stripped for the inline message.
    expect(message).not.toMatch(/^KaTeX parse error:/);
  });

  it("does not throw on unknown commands", () => {
    expect(() => equationError("\\notarealcommand{x}")).not.toThrow();
    expect(equationError("\\notarealcommand{x}")).not.toBeNull();
  });
});
