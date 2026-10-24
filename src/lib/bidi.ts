/**
 * Bidi / RTL engine — the pure engine behind §16 RTL support
 * (docs/MISSING_FEATURES.md §16, *"Right-to-left layouts"*, matrix row *RTL
 * support*: Arabic sets `dir="rtl"` and logical CSS; mixed-direction blocks
 * untested).
 *
 * The app already switches the document direction for the `ar` locale (see
 * `i18n.ts` / `app/layout.tsx`). What was untested is *content*: a Latin
 * paragraph that quotes Arabic, or an Arabic line that embeds a Latin path.
 * This module classifies such a string without touching the DOM:
 *
 *  - {@link detectDirection} — the first-strong-character heuristic, with an
 *    explicit `"auto"` result when a string has no strong character at all
 *    (digits, punctuation, emoji).
 *  - {@link resolveDir} — the precedence between a block's declared direction
 *    and the content's own direction.
 *  - {@link splitBidiRuns} — an ordered list of runs, each with a direction and
 *    an embedding level, following a *simplified* subset of UAX#9 (see the note
 *    on {@link splitBidiRuns} for exactly which weak/neutral rules apply).
 *  - {@link mirrorChar} — the mirrored form of brackets and quotes.
 *  - {@link toVisual} / {@link toLogical} — a display round-trip that reorders
 *    runs and reverses RTL runs, mirroring their bracket characters.
 *  - {@link isMixed}, {@link normalizeMarks}, {@link applyDirAttr},
 *    {@link contentDirProps}, {@link inlineBidiProps},
 *    {@link describeDirection} — the small predicates and descriptors an
 *    editor or block renderer needs.
 *
 * Pure and dependency-free: no React, no DOM, no I/O, no Unicode tables beyond
 * the script property escapes the JavaScript engine already ships. Every
 * function is deterministic.
 */

/** A resolved text direction. */
export type Direction = "ltr" | "rtl";

/** A declared/hinted direction: an explicit direction or `"auto"` detection. */
export type DirectionHint = Direction | "auto";

/**
 * The UAX#9 explicit formatting characters plus the implicit marks. They are
 * invisible, carry no glyph, and only steer rendering, so the engine removes
 * them with {@link normalizeMarks} rather than trying to reason about them.
 */
export const BIDI_CONTROL_CHARS: readonly string[] = [
  "\u061C", // ARABIC LETTER MARK
  "\u200E", // LEFT-TO-RIGHT MARK
  "\u200F", // RIGHT-TO-LEFT MARK
  "\u202A", // LEFT-TO-RIGHT EMBEDDING
  "\u202B", // RIGHT-TO-LEFT EMBEDDING
  "\u202C", // POP DIRECTIONAL FORMATTING
  "\u202D", // LEFT-TO-RIGHT OVERRIDE
  "\u202E", // RIGHT-TO-LEFT OVERRIDE
  "\u2066", // LEFT-TO-RIGHT ISOLATE
  "\u2067", // RIGHT-TO-LEFT ISOLATE
  "\u2068", // FIRST STRONG ISOLATE
  "\u2069", // POP DIRECTIONAL ISOLATE
  "\uFEFF", // ZERO WIDTH NO-BREAK SPACE / BOM
];

const BIDI_CONTROL_SET: ReadonlySet<string> = new Set(BIDI_CONTROL_CHARS);

/** True when `char` is a bidi formatting control character. */
export function isBidiControl(char: string): boolean {
  return BIDI_CONTROL_SET.has(char);
}

/**
 * Strong right-to-left scripts. Matching on the script property keeps this
 * honest: it covers Hebrew (incl. presentation forms), Arabic (incl. its
 * presentation forms and the Arabic Supplement/Extended blocks), Syriac,
 * Thaana, N'Ko, Samaritan, Mandaic and Adlam.
 */
const RTL_CHAR =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u;

/** Any letter — the left-to-right strong class, once RTL is excluded. */
const LETTER_CHAR = /\p{L}/u;

/** Arabic-Indic and extended Arabic-Indic digits (UAX#9 class AN). */
const ARABIC_DIGIT = /[\u0660-\u0669\u06F0-\u06F9]/;

/** ASCII digits are UAX#9 class EN. */
function isEuropeanDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isRtlChar(char: string): boolean {
  return RTL_CHAR.test(char);
}

function isLtrChar(char: string): boolean {
  return LETTER_CHAR.test(char);
}

/**
 * Determine a string's direction from its first strong character.
 *
 * The scan skips bidi controls and every weak/neutral character — digits,
 * punctuation, whitespace, symbols and emoji — looking for the first letter.
 * Hebrew/Arabic (and the other RTL scripts) yield `"rtl"`; any other letter
 * yields `"ltr"`. When nothing strong is found the result is `"auto"`, which
 * lets a caller defer to the block or document direction.
 */
export function detectDirection(text: string): DirectionHint {
  for (const char of text) {
    if (isBidiControl(char)) continue;
    if (isRtlChar(char)) return "rtl";
    if (isLtrChar(char)) return "ltr";
  }
  return "auto";
}

/**
 * Resolve the direction to actually apply to a block of text.
 *
 * Precedence, most specific first:
 *  1. `textDir`, when it is an explicit `"ltr"`/`"rtl"` — the element's own
 *     direction (or a detection derived from its content) is the most specific
 *     signal and wins.
 *  2. `blockDir`, when it is explicit — the inherited direction from the block
 *     or document.
 *  3. `fallback` (default `"ltr"`) — the document default.
 */
export function resolveDir(
  blockDir: DirectionHint,
  textDir: DirectionHint,
  fallback: Direction = "ltr",
): Direction {
  if (textDir === "ltr" || textDir === "rtl") return textDir;
  if (blockDir === "ltr" || blockDir === "rtl") return blockDir;
  return fallback;
}

/** One ordered bidi run: its text, direction and embedding level. */
export interface BidiRun {
  text: string;
  dir: Direction;
  level: number;
}

type BidiClass = "L" | "R" | "EN" | "AN" | "N";

function classifyChar(char: string): BidiClass {
  if (isRtlChar(char)) return "R";
  if (ARABIC_DIGIT.test(char)) return "AN";
  if (isEuropeanDigit(char)) return "EN";
  if (isLtrChar(char)) return "L";
  return "N";
}

/** Level 1 is RTL; even levels (0 and 2) are LTR. */
function levelDirection(level: number): Direction {
  return level % 2 === 0 ? "ltr" : "rtl";
}

/**
 * Split `text` into ordered runs, each carrying a direction and an embedding
 * level, using a deliberately *simplified* subset of UAX#9:
 *
 *  - The base level is 0 for an LTR paragraph and 1 for an RTL paragraph,
 *    derived from {@link detectDirection} unless `baseDir` is supplied.
 *  - Strong letters are the only level drivers: R (Hebrew/Arabic) is always
 *    level 1; L (Latin/Greek/Cyrillic/…) is level 0 in an LTR base and level 2
 *    in an RTL base, i.e. the paragraph level for the base direction.
 *  - European digits (EN) are weak and take the paragraph base level, so
 *    `abc 123` stays a single LTR run while `אבג 123` stays a single RTL run.
 *    Using the base level (rather than the nearest preceding strong level)
 *    keeps the assignment stable under {@link toVisual}'s reordering, which is
 *    what lets the display round-trip.
 *  - Arabic-Indic digits (AN) are treated as RTL (level 1).
 *  - Neutrals (whitespace, punctuation, symbols, emoji, controls) adopt a
 *    neighbour's level when both resolved neighbours agree, and the base level
 *    otherwise.
 *
 * The corresponding UAX#9 rules (W1–W7, N0–N2, I1–I2) are *not* implemented in
 * full — the level cap, the isolate/override stack and the L1 reset at line
 * boundaries are out of scope. Runs are emitted as `{ text, dir, level }` with
 * `dir` taken from the level's parity, so a level-2 run inside an RTL paragraph
 * reports `dir: "ltr"`.
 */
export function splitBidiRuns(text: string, baseDir?: Direction): BidiRun[] {
  const chars = Array.from(text);
  if (chars.length === 0) return [];

  const detected = detectDirection(text);
  const base: Direction = baseDir ?? (detected === "rtl" ? "rtl" : "ltr");
  const baseLevel = base === "rtl" ? 1 : 0;
  const ltrStrongLevel = baseLevel === 0 ? 0 : 2;

  const classes = chars.map(classifyChar);
  const levels = new Array<number>(chars.length).fill(baseLevel);

  // Strong letters: the only level drivers.
  for (let i = 0; i < chars.length; i += 1) {
    if (classes[i] === "L") levels[i] = ltrStrongLevel;
    else if (classes[i] === "R") levels[i] = 1;
  }

  // European digits are weak and take the paragraph base level; Arabic digits
  // are RTL.
  for (let i = 0; i < chars.length; i += 1) {
    const cls = classes[i];
    if (cls === "EN") levels[i] = baseLevel;
    else if (cls === "AN") levels[i] = 1;
  }

  // Neutrals: agree with both resolved neighbours, else fall to the base level.
  for (let i = 0; i < chars.length; i += 1) {
    if (classes[i] !== "N") continue;
    let left: number | null = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (classes[j] !== "N") {
        left = levels[j];
        break;
      }
    }
    let right: number | null = null;
    for (let j = i + 1; j < chars.length; j += 1) {
      if (classes[j] !== "N") {
        right = levels[j];
        break;
      }
    }
    if (left !== null && right !== null) {
      levels[i] = left === right ? left : baseLevel;
    } else {
      levels[i] = left ?? right ?? baseLevel;
    }
  }

  const runs: BidiRun[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    const level = levels[i];
    const last = runs[runs.length - 1];
    if (last !== undefined && last.level === level) {
      last.text += chars[i];
    } else {
      runs.push({ text: chars[i], dir: levelDirection(level), level });
    }
  }
  return runs;
}

/**
 * Mirrored pairs (UAX#9 `Bidi_Mirrored`), each listed once. Covers ASCII,
 * guillemets and single-angle quotes, curly quotes, mathematical angle
 * brackets, CJK brackets and fullwidth forms.
 */
const MIRROR_PAIRS: readonly (readonly [string, string])[] = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ["<", ">"],
  ["\u00AB", "\u00BB"],
  ["\u2039", "\u203A"],
  ["\u2018", "\u2019"],
  ["\u201C", "\u201D"],
  ["\u2035", "\u2032"],
  ["\u2308", "\u2309"],
  ["\u230A", "\u230B"],
  ["\u2329", "\u232A"],
  ["\u27E8", "\u27E9"],
  ["\u27EA", "\u27EB"],
  ["\u3008", "\u3009"],
  ["\u300A", "\u300B"],
  ["\u300C", "\u300D"],
  ["\u300E", "\u300F"],
  ["\u3010", "\u3011"],
  ["\u3014", "\u3015"],
  ["\u3016", "\u3017"],
  ["\u3018", "\u3019"],
  ["\u301A", "\u301B"],
  ["\uFF08", "\uFF09"],
  ["\uFF3B", "\uFF3D"],
  ["\uFF5B", "\uFF5D"],
  ["\uFF1C", "\uFF1E"],
  ["\uFF5F", "\uFF60"],
  ["\uFF62", "\uFF63"],
];

const MIRROR_MAP: ReadonlyMap<string, string> = new Map(
  MIRROR_PAIRS.flatMap(([open, close]): [string, string][] => [
    [open, close],
    [close, open],
  ]),
);

/**
 * Return the mirrored form of `char` — `(` → `)`, `«` → `»`, `“` → `”` — or the
 * character itself when it has no mirror. The empty string maps to itself.
 */
export function mirrorChar(char: string): string {
  return MIRROR_MAP.get(char) ?? char;
}

/** True when `text` contains both strong LTR and strong RTL characters. */
export function isMixed(text: string): boolean {
  let hasLtr = false;
  let hasRtl = false;
  for (const char of text) {
    if (isBidiControl(char)) continue;
    if (isRtlChar(char)) hasRtl = true;
    else if (isLtrChar(char)) hasLtr = true;
    if (hasLtr && hasRtl) return true;
  }
  return false;
}

/**
 * Strip every bidi control character (see {@link BIDI_CONTROL_CHARS}), leaving
 * all visible text — including Hebrew, Arabic and digits — untouched. Use it
 * before storing or comparing user text that may carry paste-borne marks.
 */
export function normalizeMarks(text: string): string {
  let out = "";
  for (const char of text) {
    if (!isBidiControl(char)) out += char;
  }
  return out;
}

/** Reverse a run's characters and mirror each one, for display. */
function reverseRun(run: BidiRun): string {
  return Array.from(run.text).reverse().map(mirrorChar).join("");
}

/**
 * Render `text` in visual order for a single line, as a simplified bidi
 * layout would: for an RTL base the runs are reversed, and every RTL run is
 * character-reversed with its brackets mirrored (`toLogical` undoes this).
 *
 * `baseDir` defaults to the text's {@link detectDirection} (an `"auto"` result
 * becomes LTR). Because the visual string's own detected direction can differ
 * from the logical one — a reordered RTL line may begin with a Latin word —
 * pass the intended base direction explicitly when round-tripping RTL text.
 *
 * Limitations, by design: this is a display helper, not a full UAX#9
 * implementation. Arabic letter shaping, digit grouping (a run's digits are
 * reversed with the rest of the run) and line-boundary resets are out of scope.
 */
export function toVisual(text: string, baseDir?: Direction): string {
  const detected = detectDirection(text);
  const base: Direction = baseDir ?? (detected === "rtl" ? "rtl" : "ltr");
  const runs = splitBidiRuns(text, base);
  const ordered = base === "rtl" ? [...runs].reverse() : runs;
  return ordered
    .map((run) => (run.dir === "rtl" ? reverseRun(run) : run.text))
    .join("");
}

/**
 * The inverse of {@link toVisual}: turn a visually ordered string back into
 * logical order. In practice the reorder-and-reverse transform is its own
 * inverse, so this delegates to {@link toVisual} with the same `baseDir`.
 */
export function toLogical(text: string, baseDir?: Direction): string {
  return toVisual(text, baseDir);
}

/** An element-ish source: a raw string, or an object with a `dir` and text. */
export interface DirAttrSource {
  /** A `dir` attribute value (`"ltr"`, `"rtl"`, `"auto"`, or anything else). */
  dir?: string | null;
  /** The element's text content. */
  textContent?: string | null;
}

/** The attribute values {@link applyDirAttr} resolves for an element. */
export interface DirAttr {
  dir: Direction;
  className: string;
}

function normalizeDirHint(value: string | null | undefined): DirectionHint {
  return value === "ltr" || value === "rtl" || value === "auto" ? value : "auto";
}

/**
 * Resolve the `dir` value and class names a block element should carry.
 *
 * The explicit `dir` attribute wins over content detection, which in turn wins
 * over the LTR default; detection is derived from the element's text content.
 * The returned `className` always carries `dir-ltr`/`dir-rtl`, and adds
 * `dir-mixed` when both strong directions appear and `dir-auto` when no strong
 * character was found. Passing a bare string is shorthand for
 * `{ textContent: string }`.
 */
export function applyDirAttr(source: DirAttrSource | string): DirAttr {
  const text = typeof source === "string" ? source : source.textContent ?? "";
  const explicit = typeof source === "string" ? "auto" : normalizeDirHint(source.dir);
  const detected = detectDirection(text);
  const dir = resolveDir(detected, explicit);
  const classNames = [`dir-${dir}`];
  if (isMixed(text)) classNames.push("dir-mixed");
  if (detected === "auto") classNames.push("dir-auto");
  return { dir, className: classNames.join(" ") };
}

/** Props for a user-authored text surface: its `dir` value and CSS classes. */
export interface BidiTextProps {
  /**
   * Value for the HTML `dir` attribute. `"auto"` when the text has no strong
   * character, so an empty/numeric field inherits the surrounding document
   * direction instead of forcing LTR.
   */
  dir: DirectionHint;
  /** Matching CSS classes (`dir-ltr`/`dir-rtl`/`dir-auto`, plus `dir-mixed`). */
  className: string;
}

/**
 * Resolve the `dir` attribute and classes for a **block** of user-authored
 * text (a paragraph, heading, page title, comment body, search result).
 *
 * This is the content-facing counterpart to {@link applyDirAttr}: it keeps
 * `"auto"` instead of resolving it to LTR, because a blank or number-only
 * field must still follow the page/document direction. Strong text gets its
 * own explicit direction, which is what stops a `Hello مرحبا!` line inside an
 * Arabic layout from flipping the trailing punctuation to the left edge.
 * Mixed text additionally carries `dir-mixed` (`unicode-bidi: isolate`), so
 * the block's internal runs cannot reorder its neighbours.
 */
export function contentDirProps(text: string): BidiTextProps {
  const hint = detectDirection(text);
  if (hint === "auto") return { dir: "auto", className: "dir-auto" };
  const classNames = [`dir-${hint}`];
  if (isMixed(text)) classNames.push("dir-mixed");
  return { dir: hint, className: classNames.join(" ") };
}

/**
 * Resolve the `dir` attribute and classes for an **inline** user-authored
 * fragment (a page title inside a breadcrumb, a mention, a link, a screenshot
 * caption). The fragment is always isolated — the same effect as `<bdi>` —
 * so its punctuation and strong characters cannot reorder the surrounding
 * sentence. `"auto"` keeps an empty/number-only fragment on the parent's
 * direction.
 */
export function inlineBidiProps(text: string): BidiTextProps {
  const hint = detectDirection(text);
  if (hint === "auto") return { dir: "auto", className: "bidi-isolate" };
  const classNames = [`dir-${hint}`, "bidi-isolate"];
  if (isMixed(text)) classNames.push("dir-mixed");
  return { dir: hint, className: classNames.join(" ") };
}

/** A structured summary of a string's bidi shape. */
export interface DirectionDescription {
  /** The raw {@link detectDirection} result (`"auto"` when unresolved). */
  hint: DirectionHint;
  /** The direction to apply, treating `"auto"` as `"ltr"`. */
  dir: Direction;
  /** Whether both strong directions occur. */
  mixed: boolean;
  /** Whether any strong character was found. */
  strong: boolean;
  /** Whether the text contains digits of either numbering system. */
  hasNumbers: boolean;
  /** How many runs {@link splitBidiRuns} produces. */
  runCount: number;
}

/**
 * Summarise `text` for a debug panel or a renderer deciding how to lay a block
 * out: the detection hint, the resolved direction, whether it is mixed, whether
 * it has numbers, and the run count.
 */
export function describeDirection(text: string): DirectionDescription {
  const hint = detectDirection(text);
  return {
    hint,
    dir: hint === "rtl" ? "rtl" : "ltr",
    mixed: isMixed(text),
    strong: hint !== "auto",
    hasNumbers: Array.from(text).some(
      (char) => isEuropeanDigit(char) || ARABIC_DIGIT.test(char),
    ),
    runCount: splitBidiRuns(text).length,
  };
}
