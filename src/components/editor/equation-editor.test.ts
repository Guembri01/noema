import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderEquation } from "@/lib/math-tex";
import {
  EQUATION_VIEW_OPTIONS,
  EquationDialogSurface,
  equationDirection,
  equationError,
  toggleEquationView,
  type EquationDialogSurfaceProps,
} from "./equation-editor";

/**
 * ds05 — equation editor. The dialog chrome is React + a portal, so the pure
 * mappings are pinned here: the LaTeX/Preview switch and the KaTeX error
 * report that drives the inline danger state. The presentational surface is
 * split out so the valid/invalid source and preview panes can be rendered with
 * `renderToStaticMarkup` (a portal would need a live DOM).
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

/* -------------------------------------------------------------------------- */
/* Static render                                                               */
/* -------------------------------------------------------------------------- */

/** The surface props for a given source, with everything else stubbed. */
function dialogProps(
  overrides: Partial<EquationDialogSurfaceProps> = {},
): EquationDialogSurfaceProps {
  const latex = overrides.latex ?? "\\frac{a}{b}";
  const rendered = renderEquation(latex, { displayMode: true });
  const error = rendered.error;
  return {
    kind: "block",
    latex,
    view: "source",
    error,
    preview: error ? "" : rendered.html,
    direction: equationDirection(latex),
    symbolQuery: "",
    symbolGroups: [],
    locale: "en",
    errorId: "eq-error",
    inputRef: { current: null },
    onLatexChange: () => {},
    onViewChange: () => {},
    onSymbolQueryChange: () => {},
    onInsertSymbol: () => {},
    onCommit: () => {},
    onClose: () => {},
    onBlur: () => {},
    onKeyDown: () => {},
    ...overrides,
  };
}

const renderDialog = (overrides: Partial<EquationDialogSurfaceProps> = {}): string =>
  renderToStaticMarkup(createElement(EquationDialogSurface, dialogProps(overrides)));

describe("EquationDialogSurface — source", () => {
  it("renders the valid pane with the LaTeX/Preview switch and Z.modal", () => {
    const html = renderDialog({ view: "source" });
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("surface-raised-strong");
    expect(html).toContain("animate-scale-in");
    expect(html).toContain("z-index:60");
    expect(html).toContain('data-testid="segmented"');
    expect(html).toContain('data-testid="segmented-option-source"');
    expect(html).toContain('data-testid="segmented-option-preview"');
    expect(html).toContain("\\frac{a}{b}");
    // The literal sample is a plain string, never an `&#123;`-style entity.
    expect(html).toContain("\\sqrt{a^2 + b^2}");
    // A clean source carries neither the danger ring nor the alert.
    expect(html).not.toContain("border-danger");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });

  it("renders the danger-ring error state for broken LaTeX", () => {
    const html = renderDialog({ latex: "\\frac{1}{" });
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("border-danger");
    expect(html).toContain('role="alert"');
    expect(html).toContain("text-danger");
    expect(html).toContain('aria-describedby="eq-error"');
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });

  it("lists the symbol palette and the empty search state", () => {
    const empty = renderDialog({ symbolQuery: "zzz", symbolGroups: [] });
    expect(empty).toContain("No matching symbols");

    const withSymbols = renderDialog({
      symbolGroups: [
        {
          category: "greek",
          symbols: [
            { latex: "\\alpha", label: "alpha", category: "greek", keywords: ["greek"] },
          ],
        },
      ],
    });
    expect(withSymbols).toContain("Greek letters");
    expect(withSymbols).toContain('aria-label="alpha (\\alpha)"');
    expect(withSymbols).not.toContain("No matching symbols");
  });
});

describe("EquationDialogSurface — preview", () => {
  it("renders the KaTeX preview for valid LaTeX", () => {
    const html = renderDialog({ view: "preview", latex: "x^2 + y^2" });
    expect(html).toContain("katex");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-equation-view="preview"');
    // The source textarea stays mounted (hidden) so its caret/undo history
    // survive a round-trip through Preview.
    expect(html).toContain('aria-label="LaTeX source"');
    expect(html).toContain("hidden");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });

  it("renders an inline error in the preview pane when the LaTeX does not parse", () => {
    const html = renderDialog({ view: "preview", latex: "\\frac{1}{" });
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("text-danger");
    expect(html).not.toContain("katex");
  });
});

describe("EquationDialogSurface — live editing", () => {
  it("shows the live KaTeX preview while the source box is still editable", () => {
    const html = renderDialog({ view: "source", latex: "\\RR" });
    expect(html).toContain('data-testid="equation-live-preview"');
    expect(html).toContain("katex");
    expect(html).toContain('aria-label="LaTeX source"');
    expect(html).not.toContain('aria-invalid="true"');
  });

  it("uses the shared macro table in the live preview", () => {
    // `\RR` is part of the documented macro set, so the source is valid and
    // renders rather than failing with "Undefined control sequence".
    expect(equationError("\\RR")).toBeNull();
    expect(equationError("\\abs{x}")).toBeNull();
    expect(renderEquation("\\RR").html).toContain("katex");
  });

  it("keeps the error message in the source pane, not just the preview", () => {
    const html = renderDialog({ view: "source", latex: "\\frac{1}{" });
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-describedby="eq-error"');
  });
});

describe("tokens-only guard", () => {
  const source = readFileSync(new URL("./equation-editor.tsx", import.meta.url), "utf8");
  // Mirror `scripts/check-design-system.mjs`: comment lines (which may quote a
  // URL fragment like `#123`) are not code.
  const code = source
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

  it("carries no raw hex and no legacy palette class", () => {
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(code).not.toMatch(
      /\b(?:bg|text|border|ring)-(?:red|blue|green|amber|orange|yellow|purple|pink|teal|emerald|slate|gray|zinc|neutral)-\d{2,3}\b/,
    );
  });
});
