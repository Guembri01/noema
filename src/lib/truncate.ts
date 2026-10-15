/**
 * Smart text truncation — pure, Unicode-surrogate-safe helpers for cropping
 * titles, previews, table cells and log/CLI output.
 *
 * DESIGN RULES (pinned by truncate.test.ts):
 *  - A limit (`max`, `maxWords`, `maxLines`) is a *maximum*; anything already at
 *    or under it is returned unchanged, so a trailing `…` always means a cut.
 *  - The ellipsis shares the `max` budget, so `truncateEnd`/`truncateMiddle`/
 *    `ellipsize` never return more than `max` code points.
 *  - Lengths are counted in Unicode code points (`Array.from`), so a surrogate
 *    pair — an emoji, a rare CJK glyph — is never sliced in half.
 *
 * This module is length-based/structural. It is deliberately *not* a word-
 * boundary teaser: `page-summary.ts` owns that product concern with
 * `truncateAtWord`. `truncateWords` here cuts by *word count*, a different axis.
 */

/** Default cut marker: a single `…` (U+2026 HORIZONTAL ELLIPSIS). */
export const DEFAULT_ELLIPSIS = "…";

export interface TruncateOptions {
  /**
   * Marker appended to signal a cut. Defaults to {@link DEFAULT_ELLIPSIS}.
   * Pass `""` for a bare hard cut. Shares the `max` budget.
   */
  ellipsis?: string;
}

/** Split into code points so surrogate pairs survive every slice. */
function codePoints(text: string): string[] {
  return Array.from(text ?? "");
}

/** Coerce a limit to a non-negative integer; `NaN`/`Infinity` collapse to `0`. */
function normalizeLimit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.floor(value);
}

/** The marker, truncated if it alone overflows a tiny limit. */
function markerFor(ellipsis: string, limit: number): string[] {
  return codePoints(ellipsis).slice(0, Math.max(0, limit));
}

/**
 * Core primitive: fit `text` into `max` code points, appending `ellipsis` only
 * when something had to be dropped. Text at or under `max` is returned as-is;
 * `max <= 0` yields `""`. No word or whitespace awareness — see
 * {@link truncateEnd} for the display-oriented end cut.
 */
export function ellipsize(text: string, max: number, options: TruncateOptions = {}): string {
  const input = text ?? "";
  const limit = normalizeLimit(max);
  if (limit <= 0) return "";

  const chars = codePoints(input);
  if (chars.length <= limit) return input;

  const ellipsis = options.ellipsis ?? DEFAULT_ELLIPSIS;
  const marker = markerFor(ellipsis, limit);
  const room = limit - marker.length;
  if (room <= 0) return marker.join("");

  return chars.slice(0, room).join("") + ellipsis;
}

/**
 * Keep the head of `text`, dropping the tail. Same budget rules as
 * {@link ellipsize}, but whitespace left dangling at the cut is collapsed so the
 * marker hugs the last visible glyph (`"a b  " → "a b…"`, not `"a b …"`).
 */
export function truncateEnd(text: string, max: number, options: TruncateOptions = {}): string {
  const input = text ?? "";
  const limit = normalizeLimit(max);
  if (limit <= 0) return "";

  const chars = codePoints(input);
  if (chars.length <= limit) return input;

  const ellipsis = options.ellipsis ?? DEFAULT_ELLIPSIS;
  const marker = markerFor(ellipsis, limit);
  const room = limit - marker.length;
  if (room <= 0) return marker.join("");

  const head = chars.slice(0, room).join("").replace(/\s+$/u, "");
  return head + ellipsis;
}

/**
 * Keep both ends of `text`, replacing the middle with a single marker. The
 * head takes the larger share of the budget (so more of the start survives);
 * whitespace at both sides of the seam is collapsed before the marker is
 * spliced in. Text at or under `max` is returned unchanged; `max <= 0` → `""`.
 */
export function truncateMiddle(text: string, max: number, options: TruncateOptions = {}): string {
  const input = text ?? "";
  const limit = normalizeLimit(max);
  if (limit <= 0) return "";

  const chars = codePoints(input);
  if (chars.length <= limit) return input;

  const ellipsis = options.ellipsis ?? DEFAULT_ELLIPSIS;
  const marker = markerFor(ellipsis, limit);
  const room = limit - marker.length;
  if (room <= 0) return marker.join("");

  const headLength = Math.ceil(room / 2);
  const tailLength = room - headLength;
  const head = chars.slice(0, headLength).join("").replace(/\s+$/u, "");
  const tail =
    tailLength > 0 ? chars.slice(chars.length - tailLength).join("").replace(/^\s+/u, "") : "";

  return head + ellipsis + tail;
}

/**
 * Keep the first `maxWords` whitespace-separated words and mark the cut with
 * {@link DEFAULT_ELLIPSIS}. Text with `maxWords` words or fewer is returned
 * unchanged (original line breaks preserved); when it cuts, the kept words are
 * re-joined with single spaces so runs of whitespace do not survive the seam.
 * `maxWords <= 0` → `""`.
 */
export function truncateWords(text: string, maxWords: number): string {
  const input = text ?? "";
  const limit = normalizeLimit(maxWords);
  if (limit <= 0) return "";

  const words = input.match(/\S+/gu);
  if (!words || words.length <= limit) return input;

  return words.slice(0, limit).join(" ") + DEFAULT_ELLIPSIS;
}

/**
 * Keep the first `maxLines` lines and append {@link DEFAULT_ELLIPSIS} to the
 * last one. Text with `maxLines` lines or fewer is returned unchanged. When it
 * cuts, CRLF seams are normalised to `\n` and a trailing newline counts as a
 * final empty line. `maxLines <= 0` → `""`.
 */
export function truncateLines(text: string, maxLines: number): string {
  const input = text ?? "";
  const limit = normalizeLimit(maxLines);
  if (limit <= 0) return "";

  const lines = input.split(/\r?\n/u);
  if (lines.length <= limit) return input;

  return lines.slice(0, limit).join("\n") + DEFAULT_ELLIPSIS;
}
