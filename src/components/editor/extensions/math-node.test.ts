import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EquationNodeSurface } from "./math-node";

/**
 * Render tests for the inline and block equation node views. The surfaces are
 * deliberately editor-free so `renderToStaticMarkup` can pin the exact DOM
 * contract (data attributes, KaTeX markup, inline error, no raw HTML).
 */

const render = (kind: "inline" | "block", latex: string, onEdit?: () => void) =>
  renderToStaticMarkup(createElement(EquationNodeSurface, { kind, latex, onEdit }));

describe("EquationNodeSurface — inline", () => {
  it("renders inline KaTeX with the data contract used by the editor/e2e", () => {
    const html = render("inline", "a^2 + b^2 = c^2");
    expect(html).toContain('role="math"');
    expect(html).toContain('data-equation-kind="inline"');
    expect(html).toContain('data-equation-state="ready"');
    expect(html).toContain('data-latex="a^2 + b^2 = c^2"');
    expect(html).toContain("katex");
    expect(html).not.toContain("katex-display");
    expect(html).not.toContain('role="alert"');
  });

  it("renders a visible inline error for invalid LaTeX and never throws", () => {
    const html = render("inline", "\\frac{1}{");
    expect(html).toContain('data-equation-state="error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("noema-math-error");
    expect(html).toContain("\\frac{1}{");
    expect(html).not.toContain("katex");
  });

  it("renders a click/keyboard edit affordance when onEdit is supplied", () => {
    const html = render("inline", "x", () => {});
    expect(html).toContain('tabindex="0"');
  });
});

describe("EquationNodeSurface — block", () => {
  it("renders display KaTeX inside a block element", () => {
    const html = render("block", "\\int_0^1 x^2 \\, dx");
    expect(html).toContain('data-equation-kind="block"');
    expect(html).toContain('data-equation-state="ready"');
    expect(html).toContain("<div");
    expect(html).toContain("katex-display");
    expect(html).not.toContain('role="alert"');
  });

  it("renders an inline error for a broken block equation", () => {
    const html = render("block", "\\begin{matrix} a & b");
    expect(html).toContain('data-equation-state="error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("noema-math-error");
  });

  it("renders an empty-state affordance instead of a blank atom", () => {
    const html = render("block", "");
    expect(html).toContain('data-equation-state="empty"');
    expect(html).toContain("Empty equation");
    expect(html).not.toContain('role="alert"');
  });

  it("never injects authored HTML into the output", () => {
    const html = render("inline", "\\text{<img src=x onerror=alert(1)>}");
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/<img\b/i);
    expect(html).toContain("&lt;img");
  });
});
