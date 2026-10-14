/**
 * Math editor UX — the pure LaTeX symbol catalog behind the in-editor
 * "symbol palette" (`docs/MISSING_FEATURES` math editor).
 *
 * A picker wants a browsable, searchable set of common LaTeX commands grouped
 * into recognizable sections (Greek letters, operators, arrows, relations,
 * sets, big operators, accents). That behaviour is defined here as data — a
 * categorized `MathSymbol` catalog plus the small pure API the palette needs:
 * `searchMathSymbols` for the query box, `isMathSymbol` to validate a stored
 * command against the allow-list, and `insertSnippet` to turn a picked command
 * into the text to insert plus the caret offset to leave behind.
 *
 * Pure and DB-free: no React, no TipTap, no I/O.
 */

/** Picker sections, in display order. `MATH_SYMBOLS` is grouped to match. */
export const MATH_CATEGORIES = [
  "greek",
  "operators",
  "arrows",
  "relations",
  "sets",
  "big-ops",
  "accents",
] as const;

/** One section of the palette. */
export type MathCategory = (typeof MATH_CATEGORIES)[number];

/** One palette entry. */
export type MathSymbol = {
  /** The LaTeX command inserted into the editor, e.g. `\alpha` or `<`. */
  latex: string;
  /** Human-readable name shown under the glyph, e.g. `alpha`. */
  label: string;
  /** Picker section this symbol belongs to. */
  category: MathCategory;
  /** Curated search keywords/aliases (at least one). */
  keywords: string[];
};

/** A catalog entry before its category is stamped on by the builder. */
type SymbolSeed = {
  latex: string;
  label: string;
  keywords: string[];
};

/**
 * The curated catalog, one block per category. Kept as seeds so the same list
 * drives both `MATH_SYMBOLS` and (indirectly) `isMathSymbol`, with the category
 * assigned once at build time rather than repeated on every row.
 */
const CATALOG: Record<MathCategory, readonly SymbolSeed[]> = {
  greek: [
    { latex: "\\alpha", label: "alpha", keywords: ["greek", "letter"] },
    { latex: "\\beta", label: "beta", keywords: ["greek", "letter"] },
    { latex: "\\gamma", label: "gamma", keywords: ["greek", "letter"] },
    { latex: "\\delta", label: "delta", keywords: ["greek", "letter"] },
    { latex: "\\epsilon", label: "epsilon", keywords: ["greek", "letter", "lunate"] },
    { latex: "\\varepsilon", label: "epsilon variant", keywords: ["greek", "variant"] },
    { latex: "\\zeta", label: "zeta", keywords: ["greek", "letter"] },
    { latex: "\\eta", label: "eta", keywords: ["greek", "letter"] },
    { latex: "\\theta", label: "theta", keywords: ["greek", "letter"] },
    { latex: "\\vartheta", label: "theta variant", keywords: ["greek", "variant"] },
    { latex: "\\iota", label: "iota", keywords: ["greek", "letter"] },
    { latex: "\\kappa", label: "kappa", keywords: ["greek", "letter"] },
    { latex: "\\lambda", label: "lambda", keywords: ["greek", "letter"] },
    { latex: "\\mu", label: "mu", keywords: ["greek", "letter"] },
    { latex: "\\nu", label: "nu", keywords: ["greek", "letter"] },
    { latex: "\\xi", label: "xi", keywords: ["greek", "letter"] },
    { latex: "\\pi", label: "pi", keywords: ["greek", "letter"] },
    { latex: "\\rho", label: "rho", keywords: ["greek", "letter"] },
    { latex: "\\sigma", label: "sigma", keywords: ["greek", "letter"] },
    { latex: "\\varsigma", label: "sigma variant", keywords: ["greek", "variant"] },
    { latex: "\\tau", label: "tau", keywords: ["greek", "letter"] },
    { latex: "\\upsilon", label: "upsilon", keywords: ["greek", "letter"] },
    { latex: "\\phi", label: "phi", keywords: ["greek", "letter"] },
    { latex: "\\varphi", label: "phi variant", keywords: ["greek", "variant"] },
    { latex: "\\chi", label: "chi", keywords: ["greek", "letter"] },
    { latex: "\\psi", label: "psi", keywords: ["greek", "letter"] },
    { latex: "\\omega", label: "omega", keywords: ["greek", "letter"] },
    { latex: "\\Gamma", label: "Gamma", keywords: ["greek", "uppercase"] },
    { latex: "\\Delta", label: "Delta", keywords: ["greek", "uppercase"] },
    { latex: "\\Theta", label: "Theta", keywords: ["greek", "uppercase"] },
    { latex: "\\Lambda", label: "Lambda", keywords: ["greek", "uppercase"] },
    { latex: "\\Xi", label: "Xi", keywords: ["greek", "uppercase"] },
    { latex: "\\Pi", label: "Pi", keywords: ["greek", "uppercase"] },
    { latex: "\\Sigma", label: "Sigma", keywords: ["greek", "uppercase"] },
    { latex: "\\Upsilon", label: "Upsilon", keywords: ["greek", "uppercase"] },
    { latex: "\\Phi", label: "Phi", keywords: ["greek", "uppercase"] },
    { latex: "\\Psi", label: "Psi", keywords: ["greek", "uppercase"] },
    { latex: "\\Omega", label: "Omega", keywords: ["greek", "uppercase"] },
  ],
  operators: [
    { latex: "+", label: "plus", keywords: ["add", "addition", "sum"] },
    { latex: "-", label: "minus", keywords: ["subtract", "subtraction", "difference"] },
    { latex: "\\pm", label: "plus-minus", keywords: ["plusminus", "pm"] },
    { latex: "\\mp", label: "minus-plus", keywords: ["minusplus", "mp"] },
    { latex: "\\times", label: "times", keywords: ["multiply", "multiplication", "cross"] },
    { latex: "\\div", label: "divide", keywords: ["division", "obelus"] },
    { latex: "\\cdot", label: "dot", keywords: ["multiply", "product", "inner product"] },
    { latex: "\\ast", label: "asterisk", keywords: ["star", "times"] },
    { latex: "\\star", label: "star", keywords: ["asterisk", "convolution"] },
    { latex: "\\circ", label: "composition", keywords: ["circle", "function composition"] },
    { latex: "\\bullet", label: "bullet", keywords: ["dot", "list"] },
    { latex: "\\oplus", label: "circled plus", keywords: ["direct sum", "xor"] },
    { latex: "\\otimes", label: "circled times", keywords: ["tensor", "kronecker"] },
    { latex: "\\odot", label: "circled dot", keywords: ["hadamard"] },
    { latex: "\\dagger", label: "dagger", keywords: ["obelos"] },
    { latex: "\\ddagger", label: "double dagger", keywords: ["ddagger"] },
    { latex: "\\sqrt", label: "square root", keywords: ["sqrt", "root", "radical"] },
    { latex: "\\partial", label: "partial derivative", keywords: ["partial", "derivative", "del"] },
    { latex: "\\nabla", label: "nabla", keywords: ["gradient", "del", "operator"] },
    { latex: "\\infty", label: "infinity", keywords: ["infinity", "infinite", "infty"] },
    { latex: "\\prime", label: "prime", keywords: ["prime", "derivative", "feet"] },
  ],
  arrows: [
    { latex: "\\rightarrow", label: "right arrow", keywords: ["to", "arrow", "implies"] },
    { latex: "\\leftarrow", label: "left arrow", keywords: ["arrow", "back"] },
    { latex: "\\leftrightarrow", label: "left right arrow", keywords: ["arrow", "biconditional"] },
    { latex: "\\Rightarrow", label: "right double arrow", keywords: ["implies", "logic"] },
    { latex: "\\Leftarrow", label: "left double arrow", keywords: ["logic", "back"] },
    { latex: "\\Leftrightarrow", label: "left right double arrow", keywords: ["iff", "equivalent", "logic"] },
    { latex: "\\uparrow", label: "up arrow", keywords: ["arrow", "up"] },
    { latex: "\\downarrow", label: "down arrow", keywords: ["arrow", "down"] },
    { latex: "\\updownarrow", label: "up down arrow", keywords: ["arrow", "vertical"] },
    { latex: "\\mapsto", label: "maps to", keywords: ["maps", "function"] },
    { latex: "\\to", label: "to", keywords: ["rightarrow", "arrow", "tends", "limit"] },
    { latex: "\\longrightarrow", label: "long right arrow", keywords: ["long", "arrow", "tends"] },
    { latex: "\\hookrightarrow", label: "hook right arrow", keywords: ["injection", "embedding"] },
    { latex: "\\nearrow", label: "north east arrow", keywords: ["diagonal", "trend", "up"] },
    { latex: "\\searrow", label: "south east arrow", keywords: ["diagonal", "trend", "down"] },
  ],
  relations: [
    { latex: "=", label: "equals", keywords: ["equal", "equality", "is"] },
    { latex: "\\neq", label: "not equal", keywords: ["inequality", "notequal"] },
    { latex: "\\approx", label: "approximately", keywords: ["approx", "about", "tilde"] },
    { latex: "\\equiv", label: "equivalent", keywords: ["congruent", "identical"] },
    { latex: "\\sim", label: "similar", keywords: ["tilde", "distributed"] },
    { latex: "\\simeq", label: "similar or equal", keywords: ["asymptotic"] },
    { latex: "\\cong", label: "congruent", keywords: ["isomorphic"] },
    { latex: "\\propto", label: "proportional", keywords: ["proportionality"] },
    { latex: "<", label: "less than", keywords: ["less", "lt"] },
    { latex: ">", label: "greater than", keywords: ["greater", "gt"] },
    { latex: "\\leq", label: "less than or equal", keywords: ["less", "le", "leq"] },
    { latex: "\\geq", label: "greater than or equal", keywords: ["greater", "ge", "geq"] },
    { latex: "\\ll", label: "much less than", keywords: ["less"] },
    { latex: "\\gg", label: "much greater than", keywords: ["greater"] },
    { latex: "\\prec", label: "precedes", keywords: ["preorder"] },
    { latex: "\\succ", label: "succeeds", keywords: ["preorder"] },
    { latex: "\\parallel", label: "parallel", keywords: ["independent"] },
    { latex: "\\perp", label: "perpendicular", keywords: ["orthogonal"] },
  ],
  sets: [
    { latex: "\\in", label: "element of", keywords: ["member", "belongs"] },
    { latex: "\\notin", label: "not an element of", keywords: ["member", "notin"] },
    { latex: "\\ni", label: "contains as element", keywords: ["contains", "owns"] },
    { latex: "\\subset", label: "subset", keywords: ["proper", "contained"] },
    { latex: "\\subseteq", label: "subset or equal", keywords: ["subset", "contained"] },
    { latex: "\\supset", label: "superset", keywords: ["proper", "contains"] },
    { latex: "\\supseteq", label: "superset or equal", keywords: ["superset", "contains"] },
    { latex: "\\cup", label: "union", keywords: ["cup", "or"] },
    { latex: "\\cap", label: "intersection", keywords: ["cap", "and"] },
    { latex: "\\emptyset", label: "empty set", keywords: ["null", "empty", "void"] },
    { latex: "\\varnothing", label: "empty set variant", keywords: ["null", "empty", "void"] },
    { latex: "\\setminus", label: "set minus", keywords: ["difference", "complement"] },
    { latex: "\\forall", label: "for all", keywords: ["universal", "quantifier"] },
    { latex: "\\exists", label: "there exists", keywords: ["existential", "quantifier"] },
    { latex: "\\nexists", label: "there does not exist", keywords: ["notexists", "quantifier"] },
  ],
  "big-ops": [
    { latex: "\\sum", label: "summation", keywords: ["sum", "sigma", "total"] },
    { latex: "\\prod", label: "product", keywords: ["prod", "pi", "product"] },
    { latex: "\\coprod", label: "coproduct", keywords: ["coprod"] },
    { latex: "\\int", label: "integral", keywords: ["int", "integrate"] },
    { latex: "\\iint", label: "double integral", keywords: ["integral", "double"] },
    { latex: "\\iiint", label: "triple integral", keywords: ["integral", "triple"] },
    { latex: "\\oint", label: "contour integral", keywords: ["integral", "contour", "closed"] },
    { latex: "\\bigcup", label: "big union", keywords: ["union", "cup"] },
    { latex: "\\bigcap", label: "big intersection", keywords: ["intersection", "cap"] },
    { latex: "\\bigoplus", label: "big circled plus", keywords: ["direct sum"] },
    { latex: "\\lim", label: "limit", keywords: ["lim", "approaches"] },
    { latex: "\\limsup", label: "limit superior", keywords: ["limit", "superior"] },
    { latex: "\\liminf", label: "limit inferior", keywords: ["limit", "inferior"] },
    { latex: "\\max", label: "maximum", keywords: ["max", "largest"] },
    { latex: "\\min", label: "minimum", keywords: ["min", "smallest"] },
  ],
  accents: [
    { latex: "\\hat", label: "hat", keywords: ["circumflex", "accent"] },
    { latex: "\\bar", label: "bar", keywords: ["overline", "accent", "mean"] },
    { latex: "\\vec", label: "vector", keywords: ["arrow", "accent"] },
    { latex: "\\dot", label: "dot accent", keywords: ["derivative", "accent"] },
    { latex: "\\ddot", label: "double dot accent", keywords: ["second derivative", "accent"] },
    { latex: "\\tilde", label: "tilde", keywords: ["accent", "approximate"] },
    { latex: "\\widehat", label: "wide hat", keywords: ["hat", "accent"] },
    { latex: "\\widetilde", label: "wide tilde", keywords: ["tilde", "accent"] },
    { latex: "\\overline", label: "overline", keywords: ["bar", "accent"] },
    { latex: "\\underline", label: "underline", keywords: ["accent"] },
    { latex: "\\overbrace", label: "overbrace", keywords: ["accent", "group"] },
    { latex: "\\underbrace", label: "underbrace", keywords: ["accent", "group"] },
    { latex: "\\overrightarrow", label: "over right arrow", keywords: ["vector", "arrow"] },
    { latex: "\\overleftarrow", label: "over left arrow", keywords: ["vector", "arrow"] },
  ],
};

/**
 * The curated catalog, flattened in `MATH_CATEGORIES` order so each section is
 * a contiguous block and search results keep a stable, predictable ordering.
 */
export const MATH_SYMBOLS: readonly MathSymbol[] = MATH_CATEGORIES.flatMap(
  (category) =>
    CATALOG[category].map((seed) => ({ ...seed, category })),
);

const LATEX_ALLOW_LIST = new Set(MATH_SYMBOLS.map((symbol) => symbol.latex));

/** `undefined` (or a non-integer) means "no cap"; otherwise clamp to `>= 0`. */
function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return MATH_SYMBOLS.length;
  return Number.isInteger(limit) ? Math.max(0, limit) : MATH_SYMBOLS.length;
}

/**
 * Search the catalog for the palette's query box.
 *
 * Matching is a case-insensitive substring test against the `label` and every
 * `keywords` entry — so `"union"` finds `\cup`, `"del"` finds `\nabla`, and
 * `"not equal"` finds `\neq`. Results keep the catalog's stable order. A
 * blank query returns the catalog top-N. `limit` defaults to the whole catalog;
 * `0` (or less) returns nothing and a non-integer limit is ignored.
 */
export function searchMathSymbols(
  query: string,
  options: { limit?: number } = {},
): MathSymbol[] {
  const limit = resolveLimit(options.limit);
  if (limit <= 0) return [];
  const q = (query ?? "").trim().toLowerCase();
  if (q === "") return MATH_SYMBOLS.slice(0, limit);

  const results: MathSymbol[] = [];
  for (const symbol of MATH_SYMBOLS) {
    if (
      symbol.label.toLowerCase().includes(q) ||
      symbol.keywords.some((keyword) => keyword.toLowerCase().includes(q))
    ) {
      results.push(symbol);
    }
  }
  return results.slice(0, limit);
}

/**
 * Whether `value` is a curated LaTeX command. A strict allow-list: a
 * plausible-but-uncurated command (or any non-string) is rejected, so a stored
 * `inlineMath`/`blockMath` attrs value can be validated before re-injection.
 */
export function isMathSymbol(value: unknown): value is string {
  return typeof value === "string" && LATEX_ALLOW_LIST.has(value);
}

/** Placeholder marking where the caret should land inside a snippet. */
export const SNIPPET_CURSOR = "$0";

/** The text to insert, plus the caret offset to leave behind it. */
export type SnippetInsertion = {
  /** The snippet with any cursor placeholder removed. */
  text: string;
  /** Caret position within `text` (clamped to `[0, text.length]`). */
  cursor: number;
};

/**
 * Build the insertion for a picked symbol.
 *
 * A snippet may embed {@link SNIPPET_CURSOR} once to mark the caret — e.g.
 * `\frac{$0}{}` yields `{ text: "\\frac{}{}", cursor: 6 }` so typing continues
 * inside the first brace group. Without a placeholder the caret goes to the end
 * of the text. An explicit `cursor` always wins and is clamped to the text
 * bounds (a non-finite cursor falls back to the placeholder/end position).
 */
export function insertSnippet(
  latex: string,
  options: { cursor?: number } = {},
): SnippetInsertion {
  const source = latex ?? "";
  const markerIndex = source.indexOf(SNIPPET_CURSOR);
  const text =
    markerIndex === -1
      ? source
      : source.slice(0, markerIndex) + source.slice(markerIndex + SNIPPET_CURSOR.length);
  const placeholderCursor = markerIndex === -1 ? text.length : markerIndex;
  const requested = options.cursor;
  const cursor =
    typeof requested === "number" && Number.isFinite(requested)
      ? Math.min(text.length, Math.max(0, Math.floor(requested)))
      : placeholderCursor;
  return { text, cursor };
}
