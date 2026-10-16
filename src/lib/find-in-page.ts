/**
 * Find-in-page — the pure matcher behind the editor's Ctrl+F bar
 * (`src/components/editor/find-bar.tsx`).
 *
 * The editor flattens a page into an ordered list of blocks (`{ id, text }`);
 * this module turns a query plus the three find toggles into an ordered list of
 * matches, each carrying the block it belongs to, its character offsets and a
 * short display snippet. Everything here is side-effect free — no DOM, no
 * React, no I/O — so the whole surface is unit-testable in the node
 * environment and the bar is a thin adapter over it.
 *
 * ## Matching rules
 *
 * - **Literal** (default): the query is regex-escaped, so `a.b` matches the
 *   four characters `a`, `.`, `b` — never "a-then-any".
 * - **Regex**: the query is compiled as a pattern. It is **injection-safe**:
 *   an invalid pattern returns `{ ok: false }` and never throws.
 * - **Case**: case-insensitive by default; `caseSensitive` enables the `i`-less
 *   compile.
 * - **Whole word**: wraps the (literal or regex) body in Unicode-aware
 *   look-arounds, so `cat` matches `cat` but not `category` or `concatenate`.
 * - Unicode mode (`u`) is always on, so astral characters and `\p{…}` classes
 *   behave; matches are non-overlapping, in block order, then by offset.
 *
 * A zero-length regex match (`a*`, `\b`) is skipped and the scan advances by
 * one code unit, so the walk always terminates instead of looping forever.
 */

/** One flattened page block: a stable `id` and its plain text. */
export type FindBlock = {
  id: string;
  text: string;
};

/** The three find toggles. Every option default is the "off" value. */
export type FindOptions = {
  /** Match upper/lower case exactly (default `false`). */
  caseSensitive?: boolean;
  /** Require the match to be a whole word (default `false`). */
  wholeWord?: boolean;
  /** Treat the query as a regular expression (default `false`). */
  regex?: boolean;
};

/** One match, ordered by block then offset. `end` is exclusive. */
export type FindMatch = {
  blockId: string;
  /** Start offset within the block's text, in UTF-16 code units. */
  start: number;
  /** End offset (exclusive) within the block's text. */
  end: number;
  /** Short, whitespace-collapsed excerpt around the match, with `…` markers. */
  snippet: string;
};

/** A character range within a single block, ready for highlighting. */
export type FindRange = {
  start: number;
  end: number;
};

/** A run of block text, flagged as part of a match or not. */
export type HighlightRange = {
  text: string;
  match: boolean;
};

/** A successful match pass, or a reported (never thrown) regex error. */
export type FindResult =
  | { ok: true; matches: FindMatch[] }
  | { ok: false; error: string };

/** A compiled query, `null` when the query is empty, or a regex error. */
export type FindPatternResult =
  | { ok: true; pattern: RegExp | null }
  | { ok: false; error: string };

/** Characters of context kept on each side of a match in a snippet. */
export const SNIPPET_CONTEXT = 40;

/** Stable message for an uncompilable regex; the bar shows it verbatim. */
export const INVALID_REGEX = "Invalid regular expression";

/** `\p{L}` (letters) plus `\p{N}` (numbers) plus `_`, the word characters. */
const WORD_CHAR = "\\p{L}\\p{N}_";

/** Escape every regex metacharacter so a literal query matches itself. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a query into a global `RegExp`, or report why it could not be.
 *
 * An empty query yields `{ ok: true, pattern: null }` — "match nothing", which
 * callers distinguish from a compiled pattern that happens to match nothing.
 * Regex mode is injection-safe: a `SyntaxError` from the engine is caught and
 * returned as `{ ok: false, error: INVALID_REGEX }`, never propagated.
 */
export function buildFindPattern(query: string, options: FindOptions = {}): FindPatternResult {
  const source = typeof query === "string" ? query : "";
  if (source.length === 0) return { ok: true, pattern: null };

  // The outer non-capturing group keeps alternation (`a|b`) atomic when the
  // whole-word look-arounds are wrapped around it; it does not renumber the
  // user's own capture groups.
  const body = options.regex ? `(?:${source})` : `(?:${escapeRegExp(source)})`;
  const bounded = options.wholeWord
    ? `(?<![${WORD_CHAR}])${body}(?![${WORD_CHAR}])`
    : body;
  const flags = `g${options.caseSensitive ? "" : "i"}u`;

  try {
    return { ok: true, pattern: new RegExp(bounded, flags) };
  } catch {
    return { ok: false, error: INVALID_REGEX };
  }
}

/**
 * Build the excerpt shown beside a match: `context` code units of text on each
 * side, whitespace collapsed, with an `…` where the window was clamped.
 */
export function buildSnippet(
  text: string,
  start: number,
  end: number,
  context: number = SNIPPET_CONTEXT,
): string {
  const radius = Number.isFinite(context) ? Math.max(0, Math.floor(context)) : SNIPPET_CONTEXT;
  const from = Math.max(0, start - radius);
  const to = Math.min(text.length, end + radius);
  const core = text.slice(from, to).replace(/\s+/gu, " ").trim();
  const lead = from > 0 ? "…" : "";
  const tail = to < text.length ? "…" : "";
  return `${lead}${core}${tail}`;
}

/**
 * Find every match of `query` across the ordered `blocks`, best-effort ordered
 * by block then offset. Returns `{ ok: true, matches: [] }` for an empty query
 * and `{ ok: false }` (never throws) for an invalid regex.
 */
export function findInPage(
  blocks: readonly FindBlock[],
  query: string,
  options: FindOptions = {},
): FindResult {
  const built = buildFindPattern(query, options);
  if (!built.ok) return built;
  const pattern = built.pattern;
  if (!pattern) return { ok: true, matches: [] };

  const matches: FindMatch[] = [];
  for (const block of blocks) {
    const text = block && typeof block.text === "string" ? block.text : "";
    if (text.length === 0) continue;

    pattern.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = pattern.exec(text)) !== null) {
      const start = hit.index;
      const end = start + hit[0].length;
      // Skip zero-width matches: nothing to highlight, and the manual advance
      // below keeps the walk finite.
      if (end > start) {
        matches.push({
          blockId: block.id,
          start,
          end,
          snippet: buildSnippet(text, start, end),
        });
      }
      if (hit[0].length === 0) pattern.lastIndex += 1;
    }
  }

  return { ok: true, matches };
}

/** The match ranges belonging to one block, ready for {@link splitHighlights}. */
export function rangesForBlock(matches: readonly FindMatch[], blockId: string): FindRange[] {
  const ranges: FindRange[] = [];
  for (const match of matches) {
    if (match.blockId === blockId) ranges.push({ start: match.start, end: match.end });
  }
  return ranges;
}

/**
 * Split `text` into alternating plain/match runs for rendering. Ranges are
 * clamped to the text, empty ranges dropped, sorted by start, and overlapping
 * ranges merged (adjacent ranges stay separate so each match gets its own
 * marker). An empty text or a text with no ranges yields a single plain run.
 */
export function splitHighlights(text: string, ranges: readonly FindRange[]): HighlightRange[] {
  if (text.length === 0) return [];
  if (!ranges || ranges.length === 0) return [{ text, match: false }];

  const normalized = ranges
    .map((range) => ({
      start: Math.max(0, Math.min(range.start, text.length)),
      end: Math.max(0, Math.min(range.end, text.length)),
    }))
    .filter((range) => range.end > range.start && range.start < text.length)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  if (normalized.length === 0) return [{ text, match: false }];

  const merged: FindRange[] = [];
  for (const range of normalized) {
    const last = merged[merged.length - 1];
    if (last && range.start < last.end) {
      if (range.end > last.end) merged[merged.length - 1] = { start: last.start, end: range.end };
    } else {
      merged.push({ ...range });
    }
  }

  const runs: HighlightRange[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.start > cursor) runs.push({ text: text.slice(cursor, range.start), match: false });
    runs.push({ text: text.slice(range.start, range.end), match: true });
    cursor = range.end;
  }
  if (cursor < text.length) runs.push({ text: text.slice(cursor), match: false });
  return runs;
}

/** Coerce a count to a finite, non-negative integer; anything else is 0. */
function normalizeCount(count: number): number {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return 0;
  return Math.floor(count);
}

/**
 * The match index after "next", wrapping at the end. `current = -1` (nothing
 * selected yet) steps to the first match; a one-match list stays on `0`.
 * Returns `-1` when there is nothing to step through.
 */
export function nextIndex(current: number, count: number): number {
  const size = normalizeCount(count);
  if (size === 0) return -1;
  const index = typeof current === "number" && Number.isFinite(current) ? Math.floor(current) : -1;
  const cursor = ((index % size) + size) % size;
  return (cursor + 1) % size;
}

/**
 * The match index after "previous", wrapping at the start. `current = -1` steps
 * to the last match (so opening the bar and hitting `⇧⏎` lands on the end);
 * a one-match list stays on `0`. Returns `-1` when the list is empty.
 */
export function prevIndex(current: number, count: number): number {
  const size = normalizeCount(count);
  if (size === 0) return -1;
  const index = typeof current === "number" && Number.isFinite(current) ? Math.floor(current) : -1;
  if (index < 0) return size - 1;
  const cursor = ((index % size) + size) % size;
  return (cursor - 1 + size) % size;
}
