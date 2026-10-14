/**
 * Page text statistics — word/character counts and a reading-time estimate.
 *
 * Pure, editor-agnostic logic for the "Updates & analytics" / footer stats
 * surfaces (see docs/FEATURE_MATRIX.md: word count, reading time). It operates
 * on a minimal block tree rather than the ProseMirror document so both the
 * editor and read-only viewers can share it.
 *
 * COUNTING RULES (deliberate product decisions, pinned by text-stats.test.ts):
 *  - A "word" is a run of Unicode letters/digits with optional *internal*
 *    apostrophes: `don't` and `café` are one word each. Hyphens split, so
 *    `well-known` is two words.
 *  - CJK ideographs, kana and hangul count one-by-one — they have no spaces to
 *    split on, so `你好世界` is four words.
 *  - Characters are counted as Unicode code points, so an emoji is one.
 *  - Reading time is computed at 200 wpm by default and rounded up to whole
 *    minutes; sub-one-minute content is described as "less than a minute".
 */

/** Rich inline text: a string, a marks-bearing object, or a list of those. */
export type RichText =
  | string
  | { text?: string; content?: RichText[]; marks?: unknown[] }
  | Array<string | { text?: string; content?: RichText[]; marks?: unknown[] }>;

/** Minimal block shape shared by the editor, readers and exporters. */
export interface TextBlock {
  type: string;
  text?: RichText;
  children?: TextBlock[];
}

export interface CollectTextOptions {
  /**
   * Block types whose own text is ignored (children are still visited).
   * Defaults to `["code"]` so fenced source does not inflate prose stats.
   */
  skipTypes?: string[];
}

export interface ComputeStatsOptions {
  /** Reading speed used for the estimate. Defaults to 200. */
  wordsPerMinute?: number;
}

export interface PageStats {
  words: number;
  characters: number;
  charactersNoSpaces: number;
  readingTimeMinutes: number;
  readingTimeLabel: string;
}

interface CharacterCountOptions {
  /** Count whitespace too (default). Pass `false` to measure glyphs only. */
  includeSpaces?: boolean;
}

/** Han, Hiragana, Katakana and Hangul — scripts written without word spaces. */
const CJK_CHAR =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/** A non-CJK word: one or more letters/digits, apostrophes allowed inside. */
const WORD_RUN = /[\p{L}\p{N}]+(?:['\u2019][\p{L}\p{N}]+)*/gu;

const DEFAULT_SKIP_TYPES = ["code"];
const DEFAULT_WORDS_PER_MINUTE = 200;

/** Flatten a `RichText` value to its plain string, dropping marks/attrs. */
function flattenText(value: RichText | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenText).join(" ");
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (Array.isArray(value.content)) return value.content.map(flattenText).join(" ");
  }
  return "";
}

/**
 * Walk a block tree and join the plain text of every non-skipped block with
 * spaces. Recurses into `children`; whitespace is collapsed and trimmed.
 */
export function collectText(
  blocks: readonly TextBlock[],
  { skipTypes = DEFAULT_SKIP_TYPES }: CollectTextOptions = {},
): string {
  const skipped = new Set(skipTypes);
  const parts: string[] = [];

  const walk = (list: readonly TextBlock[] | undefined): void => {
    if (!Array.isArray(list)) return;
    for (const block of list) {
      if (!block || typeof block !== "object") continue;
      if (!skipped.has(block.type)) {
        const text = flattenText(block.text).trim();
        if (text) parts.push(text);
      }
      walk(block.children);
    }
  };

  walk(blocks);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Count words in a plain string using the rules documented at the top of the
 * file: Unicode letter/digit runs (apostrophes internal), plus each CJK
 * character individually.
 */
export function wordCount(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  const withoutCjk = text.replace(CJK_CHAR, () => {
    cjk += 1;
    return " ";
  });
  const runs = withoutCjk.match(WORD_RUN);
  return cjk + (runs ? runs.length : 0);
}

/**
 * Count characters as Unicode code points. By default whitespace counts;
 * pass `{ includeSpaces: false }` for a glyph-only count.
 */
export function characterCount(
  text: string,
  { includeSpaces = true }: CharacterCountOptions = {},
): number {
  if (!text) return 0;
  const source = includeSpaces ? text : text.replace(/\s+/g, "");
  return Array.from(source).length;
}

/**
 * Human label for a reading-time estimate. Below one minute is described
 * rather than rounded down to zero; one minute and up rounds to the nearest.
 */
export function formatReadingTime(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) return "less than a minute";
  return `${Math.round(minutes)} min read`;
}

/**
 * Whole-page statistics derived from a block tree. Text is collected with
 * {@link collectText} (so code blocks are excluded by default); reading time is
 * rounded up to whole minutes at the configured words-per-minute.
 */
export function computeStats(
  blocks: readonly TextBlock[],
  { wordsPerMinute = DEFAULT_WORDS_PER_MINUTE }: ComputeStatsOptions = {},
): PageStats {
  const wpm =
    Number.isFinite(wordsPerMinute) && wordsPerMinute > 0
      ? wordsPerMinute
      : DEFAULT_WORDS_PER_MINUTE;

  const text = collectText(blocks);
  const words = wordCount(text);
  const readingTimeMinutes =
    words === 0 ? 0 : Math.max(1, Math.ceil(words / wpm));

  return {
    words,
    characters: characterCount(text, { includeSpaces: true }),
    charactersNoSpaces: characterCount(text, { includeSpaces: false }),
    readingTimeMinutes,
    readingTimeLabel: formatReadingTime(readingTimeMinutes),
  };
}

/**
 * Tally blocks by `type`, including nested descendants. Blocks without a
 * string type are grouped under `"unknown"`.
 */
export function countBlocksByType(
  blocks: readonly TextBlock[],
): Record<string, number> {
  const counts: Record<string, number> = {};

  const walk = (list: readonly TextBlock[] | undefined): void => {
    if (!Array.isArray(list)) return;
    for (const block of list) {
      if (!block || typeof block !== "object") continue;
      const type = typeof block.type === "string" ? block.type : "unknown";
      counts[type] = (counts[type] ?? 0) + 1;
      walk(block.children);
    }
  };

  walk(blocks);
  return counts;
}
