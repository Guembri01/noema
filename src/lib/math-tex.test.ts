import { describe, expect, it } from "vitest";
import {
  KATEX_MAX_EXPAND,
  MAX_EQUATION_LENGTH,
  equationError,
  renderEquation,
} from "./math-tex";
import {
  MATH_MACRO_MAX_DEPTH,
  MATH_MACRO_MAX_LENGTH,
  MATH_MACRO_NAMES,
  MATH_MACROS,
  expandMathMacros,
  mathMacroTable,
} from "./math-macros";

/**
 * The safe render bridge is the one place where authored LaTeX meets KaTeX.
 * These tests pin the pure behaviour the editor node views depend on:
 * documented macros, inline/block mode, bounded expansion, inline errors, and
 * the "never inject raw HTML" policy.
 */

describe("documented macro set", () => {
  it("exposes a stable, non-empty list of visual-only macros", () => {
    expect(MATH_MACRO_NAMES.length).toBeGreaterThan(0);
    expect(MATH_MACRO_NAMES).toEqual([...MATH_MACRO_NAMES].sort());
    for (const name of MATH_MACRO_NAMES) {
      expect(MATH_MACROS[`\\${name}`]).toMatch(/\\/);
    }
  });

  it("renders common notation instead of failing with an undefined command", () => {
    for (const source of [
      "\\RR^n",
      "\\NN \\subset \\ZZ",
      "\\abs{x - y}",
      "\\norm{v}",
      "\\inner{u}{v}",
      "\\dd x",
      "\\half\\degree",
    ]) {
      const rendered = renderEquation(source);
      expect(rendered.error, source).toBeNull();
      expect(rendered.html, source).toContain("katex");
    }
  });

  it("does not share a mutable table with KaTeX", () => {
    const first = mathMacroTable();
    first["\\RR"] = "mutated";
    expect(MATH_MACROS["\\RR"]).toBe("\\mathbb{R}");
    expect(mathMacroTable()["\\RR"]).toBe("\\mathbb{R}");
  });

  it("stops macro expansion at the documented depth", () => {
    const result = expandMathMacros("\\newcommand{\\a}{\\b}\\newcommand{\\b}{\\a}\\a");
    expect(result.cycles).toContain("a");
    expect(result.latex).toContain("\\a");
  });

  it("bounds huge macro bodies by output length", () => {
    const result = expandMathMacros(
      `\\newcommand{\\boom}{${"x".repeat(MATH_MACRO_MAX_LENGTH + 1)}}$\\boom$`,
    );
    expect(result.latex.length).toBeLessThanOrEqual(MATH_MACRO_MAX_LENGTH);
    expect(result.truncated).toBe(true);
  });

  it("keeps the depth and length limits small enough to be a bound", () => {
    expect(MATH_MACRO_MAX_DEPTH).toBeLessThanOrEqual(20);
    expect(MATH_MACRO_MAX_LENGTH).toBeLessThanOrEqual(100_000);
    expect(KATEX_MAX_EXPAND).toBeLessThanOrEqual(1_000);
  });
});

describe("renderEquation", () => {
  it("renders inline math without a display wrapper", () => {
    const rendered = renderEquation("x^2 + y^2", { displayMode: false });
    expect(rendered.error).toBeNull();
    expect(rendered.empty).toBe(false);
    expect(rendered.displayMode).toBe(false);
    expect(rendered.html).toContain("katex");
    expect(rendered.html).not.toContain("katex-display");
  });

  it("renders block math with the display wrapper", () => {
    const rendered = renderEquation("\\int_0^1 x^2 \\, dx", { displayMode: true });
    expect(rendered.error).toBeNull();
    expect(rendered.displayMode).toBe(true);
    expect(rendered.html).toContain("katex-display");
  });

  it("treats empty source as empty rather than an error", () => {
    expect(renderEquation("")).toMatchObject({ empty: true, error: null, html: "" });
    expect(renderEquation("   ")).toMatchObject({ empty: true, error: null });
    expect(equationError("")).toBeNull();
  });

  it("reports invalid LaTeX without throwing or emitting markup", () => {
    const rendered = renderEquation("\\frac{1}{");
    expect(rendered.error).toBeTruthy();
    expect(rendered.error).not.toMatch(/^KaTeX parse error:/);
    expect(rendered.html).toBe("");
    expect(() => renderEquation("\\notarealcommand{x}")).not.toThrow();
    expect(renderEquation("\\notarealcommand{x}").error).toBeTruthy();
  });

  it("rejects banned commands instead of silently stripping them", () => {
    const rendered = renderEquation("\\input{secret} x");
    expect(rendered.error).toContain("input");
    expect(rendered.html).toBe("");
  });

  it("rejects oversized source before handing it to KaTeX", () => {
    const rendered = renderEquation("x".repeat(MAX_EQUATION_LENGTH + 1));
    expect(rendered.error).toContain("longer than");
    expect(rendered.html).toBe("");
  });

  it("never trusts URL/HTML commands", () => {
    const href = renderEquation("\\href{javascript:alert(1)}{x}");
    expect(href.error).toBeTruthy();
    expect(href.html).toBe("");

    const htmlClass = renderEquation("\\htmlClass{evil}{x}");
    expect(htmlClass.error).toBeTruthy();
    expect(htmlClass.html).toBe("");
  });

  it("escapes literal HTML-like text rather than injecting it", () => {
    const rendered = renderEquation("\\text{<script>alert(1)</script>}");
    expect(rendered.error).toBeNull();
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;");
  });

  it("keeps a node's kind authoritative over pasted delimiters", () => {
    const inline = renderEquation("$$x^2$$", { displayMode: false });
    expect(inline.error).toBeNull();
    expect(inline.html).not.toContain("katex-display");

    const block = renderEquation("$x^2$", { displayMode: true });
    expect(block.error).toBeNull();
    expect(block.html).toContain("katex-display");
  });
});
