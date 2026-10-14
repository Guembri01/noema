/**
 * Case display transforms — the pure engine behind "Small caps / all caps"
 * (docs/MISSING_FEATURES.md §1, *"Display transforms for text."*). Notion-style
 * text keeps its stored characters; these helpers produce the *display* string
 * for a block or selection without touching the document.
 *
 * Pure and Unicode-aware: no React, no I/O. Two transforms are offered, exposed
 * both as functions and as a small data catalog so a menu/state model can drive
 * them:
 *
 *  - {@link toAllCaps} upper-cases letters with JavaScript's locale-independent
 *    `toUpperCase`. Digits, punctuation, symbols and emoji are untouched.
 *  - {@link toSmallCaps} maps Latin letters to their Unicode *small capital*
 *    figures (`a` → `ᴀ`). Genuine small capitals have gaps in Unicode — there
 *    is no SMALL CAPITAL Q or X — so those code points, and every non-Latin
 *    character, pass through unchanged (see the note on {@link toSmallCaps}).
 *
 * The module is deterministic and side-effect free so an editor can apply a
 * transform to a selection, a block, or a whole page identically.
 */

/** The transforms a text block can display under. */
export type TextTransformKind = "none" | "uppercase" | "smallcaps";

/** Options accepted by {@link toSmallCaps} / {@link applyTextTransform}. */
export interface SmallCapsOptions {
  /**
   * When `true`, map ASCII digits `0`–`9` to superscript figures (`1` → `¹`).
   * Unicode has no true small-capital digits, so the superscript forms are the
   * conventional stand-in used by small-caps generators. Defaults to `false`.
   */
  digits?: boolean;
}

/** A labeled entry in {@link TEXT_TRANSFORMS}, ready for a menu or picker. */
export interface TextTransformDescriptor {
  kind: TextTransformKind;
  /** Short, user-facing name. */
  label: string;
  /** One-line explanation shown as a hint/tooltip. */
  description: string;
}

/** The persisted/editor state selecting how text is displayed. */
export interface TextTransformState {
  transform: TextTransformKind;
}

/** The initial state: text is shown exactly as stored. */
export const DEFAULT_TEXT_TRANSFORM_STATE: TextTransformState = {
  transform: "none",
};

/**
 * Latin letters to their Unicode small-capital figures.
 *
 * Deliberately keyed by lowercase ASCII letters; an uppercase input is folded
 * with `toLowerCase` first, so `A` and `a` both map to `ᴀ` (true small caps
 * render both cases at the same height). `q` and `x` are absent on purpose:
 * Unicode defines no SMALL CAPITAL Q or X, so they are left as-is instead of
 * being replaced by look-alike modifier letters.
 */
const SMALL_CAPITALS: Readonly<Record<string, string>> = {
  a: "\u1D00",
  b: "\u0299",
  c: "\u1D04",
  d: "\u1D05",
  e: "\u1D07",
  f: "\uA730",
  g: "\u0262",
  h: "\u029C",
  i: "\u026A",
  j: "\u1D0A",
  k: "\u1D0B",
  l: "\u029F",
  m: "\u1D0D",
  n: "\u0274",
  o: "\u1D0F",
  p: "\u1D18",
  r: "\u0280",
  s: "\uA731",
  t: "\u1D1B",
  u: "\u1D1C",
  v: "\u1D20",
  w: "\u1D21",
  y: "\u028F",
  z: "\u1D22",
};

/** Superscript digits used by {@link toSmallCaps} when `digits` is enabled. */
const SUPERSCRIPT_DIGITS: Readonly<Record<string, string>> = {
  "0": "\u2070",
  "1": "\u00B9",
  "2": "\u00B2",
  "3": "\u00B3",
  "4": "\u2074",
  "5": "\u2075",
  "6": "\u2076",
  "7": "\u2077",
  "8": "\u2078",
  "9": "\u2079",
};

function isAsciiDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

/**
 * Uppercase every letter, leaving digits, punctuation, symbols and emoji
 * untouched.
 *
 * Uses the locale-independent `String.prototype.toUpperCase`, so results are
 * stable across environments (`ß` → `SS`, `i` stays `i` rather than the Turkish
 * `İ`). Combining marks are preserved because uppercasing never drops them.
 */
export function toAllCaps(text: string): string {
  return text.toUpperCase();
}

/**
 * Map Latin letters to Unicode small-capital figures (`Hello` → `ʜᴇʟʟᴏ`).
 *
 * Rules, chosen so the result is stable and honest about Unicode's gaps:
 *  - The text is canonically decomposed (NFD) first, so a precomposed accented
 *    letter such as `é` splits into `e` + combining acute; the base letter maps
 *    and the combining mark is carried through. There are no precomposed
 *    small-capital accented forms, so an accent on a mapped letter necessarily
 *    stays a combining mark; the output is re-composed (NFC) to fold back
 *    accents on letters that were *not* mapped.
 *  - Non-mappable characters — `q`, `x`, all non-Latin scripts, digits (unless
 *    `digits` is set), punctuation, whitespace and emoji — pass through
 *    unchanged.
 *  - The transform is idempotent: small-capital figures are not ASCII letters,
 *    so re-applying it is a no-op.
 */
export function toSmallCaps(
  text: string,
  { digits = false }: SmallCapsOptions = {},
): string {
  const decomposed = text.normalize("NFD");
  let out = "";
  for (const char of decomposed) {
    const mapped = SMALL_CAPITALS[char] ?? SMALL_CAPITALS[char.toLowerCase()];
    if (mapped !== undefined) {
      out += mapped;
    } else if (digits && isAsciiDigit(char)) {
      out += SUPERSCRIPT_DIGITS[char];
    } else {
      out += char;
    }
  }
  return out.normalize("NFC");
}

/**
 * The transforms, in menu order, each with a user-facing label. `none` is the
 * default so a caller can drive a picker straight from this list.
 */
export const TEXT_TRANSFORMS: TextTransformDescriptor[] = [
  {
    kind: "none",
    label: "Default",
    description: "Show text exactly as typed.",
  },
  {
    kind: "uppercase",
    label: "Uppercase",
    description: "Show every letter as a capital (ALL CAPS).",
  },
  {
    kind: "smallcaps",
    label: "Small caps",
    description: "Show latin letters as small-capital figures.",
  },
];

/** True when `value` is one of the supported {@link TextTransformKind}s. */
export function isTextTransformKind(
  value: unknown,
): value is TextTransformKind {
  return value === "none" || value === "uppercase" || value === "smallcaps";
}

/** Build a state from a kind, defaulting to `"none"`. */
export function createTextTransformState(
  transform: TextTransformKind = "none",
): TextTransformState {
  return { transform };
}

/** Return a new state with the transform replaced (never mutates `state`). */
export function setTextTransform(
  state: TextTransformState,
  transform: TextTransformKind,
): TextTransformState {
  return { ...state, transform };
}

/**
 * Apply a transform kind to `text`. `none` returns the input untouched;
 * `uppercase` and `smallcaps` delegate to {@link toAllCaps} and
 * {@link toSmallCaps}.
 */
export function applyTextTransform(
  kind: TextTransformKind,
  text: string,
  options: SmallCapsOptions = {},
): string {
  switch (kind) {
    case "none":
      return text;
    case "uppercase":
      return toAllCaps(text);
    case "smallcaps":
      return toSmallCaps(text, options);
    default: {
      // Exhaustiveness guard: a new kind must be handled above.
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

/** Apply the transform held by `state` to `text`. */
export function applyTextTransformState(
  state: TextTransformState,
  text: string,
  options: SmallCapsOptions = {},
): string {
  return applyTextTransform(state.transform, text, options);
}
