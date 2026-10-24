/**
 * The documented, bounded KaTeX macro set.
 *
 * Equations are authored in a sandboxed subset of TeX: we only ever hand KaTeX
 * a finite macro table defined here (plus any inline `\newcommand` the author
 * writes). The set is deliberately small and every entry is a pure visual
 * abbreviation — none of them can read files, execute code, or expand into
 * another unbounded macro.
 *
 * Bounds (enforced by `expandMacros` in `math-render.ts`):
 *  - at most {@link MATH_MACRO_MAX_DEPTH} nested expansions,
 *  - at most {@link MATH_MACRO_MAX_LENGTH} characters emitted,
 *  - cycles (`\a -> \a`, `\a -> \b -> \a`) stop and keep the source token.
 *
 * The same table is passed to the editor node views, the equation dialog and
 * the KaTeX preview, so `\RR` renders in exactly the same way in all three.
 */

import { expandMacros, type MacroExpansion, type MathMacroMap } from "./math-render";

/**
 * Common notation macros. Keys keep their leading backslash so the table can be
 * handed to KaTeX's `macros` option verbatim; `expandMacros` normalizes them.
 *
 * Documented additions must stay visual-only and must not reference commands
 * that KaTeX cannot expand on its own.
 */
export const MATH_MACROS: MathMacroMap = Object.freeze({
  // Number sets.
  "\\RR": "\\mathbb{R}",
  "\\NN": "\\mathbb{N}",
  "\\ZZ": "\\mathbb{Z}",
  "\\QQ": "\\mathbb{Q}",
  "\\CC": "\\mathbb{C}",
  "\\PP": "\\mathbb{P}",

  // Delimiters and operators.
  "\\abs": "\\left|#1\\right|",
  "\\norm": "\\left\\lVert #1\\right\\rVert",
  "\\inner": "\\left\\langle #1,#2\\right\\rangle",
  "\\dd": "\\mathrm{d}",
  "\\pd": "\\partial",
  "\\degree": "^{\\circ}",
  "\\half": "\\frac{1}{2}",
  "\\qed": "\\blacksquare",
});

/** Maximum macro-expansion depth used by every equation surface. */
export const MATH_MACRO_MAX_DEPTH = 8;

/**
 * Maximum expanded output length. `expandMacros` uses a character budget so a
 * deny-of-service definition such as `\a -> \b\b` cannot grow without bound.
 */
export const MATH_MACRO_MAX_LENGTH = 20_000;

/** Stable, sorted list of the macro names (without the leading backslash). */
export const MATH_MACRO_NAMES: readonly string[] = Object.freeze(
  Object.keys(MATH_MACROS)
    .map((name) => name.replace(/^\\/, ""))
    .sort(),
);

/**
 * A fresh macro table for KaTeX. KaTeX mutates the `macros` option object when
 * it encounters `\def`/`\newcommand`, so callers must never share a frozen
 * table between renders.
 */
export function mathMacroTable(extra?: MathMacroMap): Record<string, string> {
  return { ...MATH_MACROS, ...(extra ?? {}) };
}

/**
 * Expand the shared macro set in `latex` under the documented bounds. Never
 * throws and never returns an unbounded string.
 */
export function expandMathMacros(latex: string, extra?: MathMacroMap): MacroExpansion {
  return expandMacros(latex, {
    macros: mathMacroTable(extra),
    maxDepth: MATH_MACRO_MAX_DEPTH,
    maxLength: MATH_MACRO_MAX_LENGTH,
  });
}
