/**
 * The single safe bridge between authored LaTeX and KaTeX.
 *
 * Every equation surface (editor node views, the equation dialog, previews)
 * goes through {@link renderEquation}:
 *  - the shared, bounded macro table in `math-macros.ts` is applied first;
 *  - banned TeX commands (`\input`, `\include`, `\write18`) are rejected;
 *  - KaTeX runs with `throwOnError: true` so the caller gets a message instead
 *    of a half-rendered tree;
 *  - `trust: false` keeps `\href`, `\htmlClass`, `\includegraphics` and other
 *    file/URL commands out of the output;
 *  - `maxExpand`/`maxSize` and the input-length cap bound the work KaTeX does.
 *
 * The function never throws. Callers may inject `html` as markup because it is
 * KaTeX's own escaped output for a trusted, non-HTML subset — never the user's
 * raw source.
 */

import katex from "katex";
import { expandMacros, validateLatex, type MathMacroMap } from "./math-render";
import {
  MATH_MACRO_MAX_DEPTH,
  MATH_MACRO_MAX_LENGTH,
  mathMacroTable,
} from "./math-macros";

/** Hard cap on authored source length (characters). */
export const MAX_EQUATION_LENGTH = 10_000;

/** KaTeX's own macro-expansion cap, independent of our table bounds. */
export const KATEX_MAX_EXPAND = 1_000;

/** Largest user-specified size (in em) KaTeX may produce. */
export const KATEX_MAX_SIZE = 50;

/** The result of rendering an equation. Always safe to inspect. */
export type RenderedEquation = {
  /** Prepared LaTeX (delimiters/macros/banned commands resolved). */
  latex: string;
  /** Whether the output is display (block) math. */
  displayMode: boolean;
  /** KaTeX markup, empty when `error` is set. */
  html: string;
  /** A short human-readable parse message, or `null` when valid/empty. */
  error: string | null;
  /** Whether the authored source was empty after trimming. */
  empty: boolean;
};

export type RenderEquationOptions = {
  /**
   * Force inline (`false`) or display (`true`) output. Node views own their
   * kind, so a stray `$$…$$` pasted into an inline node stays inline. Omit to
   * let `$…$`/`$$…$$`/`\[…\]` delimiters decide.
   */
  displayMode?: boolean;
  /** Extra macros layered over {@link MATH_MACROS}. */
  macros?: MathMacroMap;
};

/** Strip KaTeX's noisy prefix and keep an inline-sized message. */
function normalizeKatexError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cleaned = message.replace(/^KaTeX parse error:\s*/i, "").replace(/\s+/g, " ").trim();
  const fallback = cleaned || "Invalid LaTeX";
  return fallback.length > 240 ? `${fallback.slice(0, 237)}…` : fallback;
}

function stripModeDelimiters(source: string): { body: string; displayMode: boolean } {
  if (source.length >= 4 && source.startsWith("$$") && source.endsWith("$$")) {
    return { body: source.slice(2, -2), displayMode: true };
  }
  if (source.length >= 4 && source.startsWith("\\[") && source.endsWith("\\]")) {
    return { body: source.slice(2, -2), displayMode: true };
  }
  if (source.length >= 4 && source.startsWith("\\(") && source.endsWith("\\)")) {
    return { body: source.slice(2, -2), displayMode: false };
  }
  if (source.length >= 2 && source.startsWith("$") && source.endsWith("$")) {
    return { body: source.slice(1, -1), displayMode: false };
  }
  return { body: source, displayMode: false };
}

/**
 * Validate + render a LaTeX fragment with the shared macro set. Never throws.
 */
export function renderEquation(
  latex: string,
  options: RenderEquationOptions = {},
): RenderedEquation {
  const source = typeof latex === "string" ? latex.trim() : "";

  if (source.length === 0) {
    return {
      latex: "",
      displayMode: options.displayMode ?? false,
      html: "",
      error: null,
      empty: true,
    };
  }

  if (source.length > MAX_EQUATION_LENGTH) {
    return {
      latex: source.slice(0, MAX_EQUATION_LENGTH),
      displayMode: options.displayMode ?? false,
      html: "",
      error: `Equation is longer than ${MAX_EQUATION_LENGTH.toLocaleString("en-US")} characters`,
      empty: false,
    };
  }

  // Reject banned commands instead of silently stripping them to an empty
  // equation. The editor's document guard strips them on write; this catches
  // imported/legacy source on the read path.
  const banned = validateLatex(source).find((issue) => issue.code === "banned-command");
  if (banned !== undefined) {
    return {
      latex: source,
      displayMode: options.displayMode ?? false,
      html: "",
      error: banned.message,
      empty: false,
    };
  }

  const macros = mathMacroTable(options.macros);
  const delimited = stripModeDelimiters(source);

  // Expand under the same bounds the editor's safety guard documents. If the
  // expansion hits the output budget, show an error rather than a partial
  // equation that looks valid.
  const expansion = expandMacros(delimited.body, {
    macros,
    maxDepth: MATH_MACRO_MAX_DEPTH,
    maxLength: MATH_MACRO_MAX_LENGTH,
  });
  if (expansion.truncated === true) {
    return {
      latex: source,
      displayMode: options.displayMode ?? delimited.displayMode,
      html: "",
      error: "Equation expands to too much LaTeX",
      empty: false,
    };
  }

  const body = expansion.latex;
  for (const issue of validateLatex(body)) {
    if (issue.code === "banned-command") {
      return {
        latex: body,
        displayMode: options.displayMode ?? delimited.displayMode,
        html: "",
        error: issue.message,
        empty: false,
      };
    }
  }

  const unsafe = findUnsafeCommand(body);
  if (unsafe !== null) {
    return {
      latex: body,
      displayMode: options.displayMode ?? delimited.displayMode,
      html: "",
      error: `Command \\${unsafe} is not allowed`,
      empty: false,
    };
  }

  // Keep the node's kind authoritative: a block node always renders display
  // math, an inline node always renders inline math.
  const displayMode = options.displayMode ?? delimited.displayMode;

  if (body.trim().length === 0) {
    return {
      latex: body,
      displayMode,
      html: "",
      error: null,
      empty: true,
    };
  }

  try {
    const html = katex.renderToString(body, {
      displayMode,
      throwOnError: true,
      strict: "ignore",
      trust: false,
      maxExpand: KATEX_MAX_EXPAND,
      maxSize: KATEX_MAX_SIZE,
      macros,
    });
    return { latex: body, displayMode, html, error: null, empty: false };
  } catch (error) {
    return {
      latex: body,
      displayMode,
      html: "",
      error: normalizeKatexError(error),
      empty: false,
    };
  }
}

/**
 * Commands that need KaTeX's `trust` and can reach the network, the DOM, or
 * the filesystem. `trust: false` makes them inert but does not throw, so we
 * reject them explicitly: a saved equation must never depend on a permissive
 * KaTeX flag later.
 */
export const UNSAFE_RENDER_COMMANDS: readonly string[] = [
  "href",
  "url",
  "includegraphics",
  "htmlClass",
  "htmlId",
  "htmlStyle",
  "htmlData",
  "class",
  "style",
  "data",
  "aria",
];

function findUnsafeCommand(source: string): string | null {
  for (const name of UNSAFE_RENDER_COMMANDS) {
    const matcher = new RegExp(`\\\\${name}(?![A-Za-z])`);
    if (matcher.test(source)) return name;
  }
  return null;
}

/**
 * Backwards-compatible validation helper. Returns `null` for valid or empty
 * source and a short KaTeX message otherwise.
 */
export function equationError(latex: string): string | null {
  return renderEquation(latex, { displayMode: false }).error;
}
