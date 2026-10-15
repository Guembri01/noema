/**
 * Text width estimation — pure, deterministic, editor-agnostic.
 *
 * Answers "how wide is this text?" without a canvas or the DOM, so layout
 * code (table column auto-fit, wrapping previews, truncation budgets) can run
 * in a unit sandbox / on the server. Widths are expressed in "em" units: the
 * width of one ordinary glyph at `fontScale` 1. A caller multiplies by the
 * font size to get pixels, or by `fontScale` to model a different size.
 *
 * CHAR-CLASS MODEL (deliberately simple, pinned by text-measure.test.ts):
 *  - `narrow` (0.5 em): whitespace and thin glyphs — `i`, `l`, `.`, `,` etc.
 *  - `wide`   (1.0 em): ordinary letters and digits;
 *  - `cjk`    (2.0 em): Han/Hiragana/Katakana/Hangul — full-width glyphs;
 *  - `emoji`  (2.0 em): pictographic code points.
 * Classification is per Unicode code point, so an astral emoji is one `emoji`
 * unit, never two. `charWidths` overrides any class; `fontScale` scales the
 * result. Non-finite / out-of-range options fall back to the defaults rather
 * than propagating `NaN` — the same fail-safe contract as the rest of lib/.
 */

/** The four glyph classes the estimator understands. */
export type CharClass = "narrow" | "wide" | "cjk" | "emoji";

/** Per-class width in em units at `fontScale` 1. */
export type CharWidths = Record<CharClass, number>;

/** The class order used for iterating/validating overrides. */
const CHAR_CLASSES: readonly CharClass[] = ["narrow", "wide", "cjk", "emoji"];

/** Default per-class widths (em): narrow 0.5, wide 1, CJK 2, emoji 2. */
export const DEFAULT_CHAR_WIDTHS: CharWidths = {
  narrow: 0.5,
  wide: 1,
  cjk: 2,
  emoji: 2,
};

/** Options shared by every measurement entry point. */
export interface TextMeasureOptions {
  /**
   * Multiplies the summed width. Defaults to 1; a non-finite or non-positive
   * value falls back to 1 so a bad scale never yields `NaN`.
   */
  fontScale?: number;
  /**
   * Per-class width overrides in em units. Missing classes keep their default;
   * a non-finite or negative override is ignored.
   */
  charWidths?: Partial<CharWidths>;
}

/** Options for {@link wrapText}: a measurement plus the line budget. */
export interface WrapTextOptions extends TextMeasureOptions {
  /**
   * Maximum line width in em units. Defaults to `Infinity` (no wrapping);
   * absent/non-finite means "never break".
   */
  maxWidth?: number;
}

/** Han, Hiragana, Katakana and Hangul — the full-width scripts. */
const CJK_CHAR =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Pictographic code points: a single emoji is one indivisible unit. */
const EMOJI_CHAR = /[\p{Extended_Pictographic}\p{Emoji_Presentation}]/u;

/** Glyphs that read as roughly half an ordinary letter in a proportional font. */
const NARROW_CHARS = new Set(
  "ilIJjtfr.,;:!|'\"()[]{}/\\^~-`<>".split(""),
);

/**
 * Classify one Unicode code point. Whitespace and the fixed thin-glyph set are
 * `narrow`; pictographs are `emoji`; CJK scripts are `cjk`; everything else
 * (ordinary letters, digits, unknown symbols) is `wide`.
 */
export function classifyChar(char: string): CharClass {
  if (char === "") return "wide";
  if (EMOJI_CHAR.test(char)) return "emoji";
  if (CJK_CHAR.test(char)) return "cjk";
  if (/\s/.test(char) || NARROW_CHARS.has(char)) return "narrow";
  return "wide";
}

/** Resolve `fontScale`, defaulting to 1 for non-finite / non-positive input. */
function resolveFontScale(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 1;
}

/** Merge caller overrides onto {@link DEFAULT_CHAR_WIDTHS}, dropping bad values. */
function resolveCharWidths(overrides: Partial<CharWidths> | undefined): CharWidths {
  const widths: CharWidths = { ...DEFAULT_CHAR_WIDTHS };
  if (!overrides || typeof overrides !== "object") return widths;
  for (const key of CHAR_CLASSES) {
    const value = overrides[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      widths[key] = value;
    }
  }
  return widths;
}

/**
 * Estimate the render width of `text` in em units.
 *
 * Sums one class weight per code point, then multiplies by `fontScale`. An
 * empty (or non-string) input measures 0.
 */
export function estimateTextWidth(
  text: string,
  options: TextMeasureOptions = {},
): number {
  if (typeof text !== "string" || text === "") return 0;
  const widths = resolveCharWidths(options.charWidths);
  const scale = resolveFontScale(options.fontScale);

  let total = 0;
  for (const char of text) {
    total += widths[classifyChar(char)];
  }
  return total * scale;
}

/**
 * Greedy word wrap: split on whitespace, fill each line while it fits within
 * `maxWidth`, and start a new line otherwise.
 *
 * A word wider than `maxWidth` is kept intact on its own line (no mid-word
 * breaking). Explicit `\n` breaks are honoured, and a blank source line yields
 * an empty line. Empty input yields a single empty line, so the result is
 * always non-empty. Whitespace within a line is collapsed to single spaces.
 */
export function wrapText(text: string, options: WrapTextOptions = {}): string[] {
  const source = typeof text === "string" ? text : "";
  const limit =
    typeof options.maxWidth === "number" && Number.isFinite(options.maxWidth)
      ? options.maxWidth
      : Number.POSITIVE_INFINITY;

  const lines: string[] = [];
  for (const paragraph of source.split("\n")) {
    const words = paragraph.split(/\s+/).filter((word) => word !== "");
    if (words.length === 0) {
      lines.push("");
      continue;
    }

    let current = "";
    for (const word of words) {
      if (current === "") {
        current = word;
        continue;
      }
      const candidate = `${current} ${word}`;
      if (estimateTextWidth(candidate, options) <= limit) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current !== "") lines.push(current);
  }
  return lines;
}

/**
 * Width of the widest single visual line of `text`, in em units. Lines are
 * split on `\n`; empty text measures 0. Shares {@link estimateTextWidth}'s
 * class model and options.
 */
export function maxLineWidth(text: string, options: TextMeasureOptions = {}): number {
  const source = typeof text === "string" ? text : "";
  let widest = 0;
  for (const line of source.split("\n")) {
    const width = estimateTextWidth(line, options);
    if (width > widest) widest = width;
  }
  return widest;
}
