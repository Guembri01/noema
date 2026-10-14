/**
 * Code block domain — pure helpers behind the two optional code-block
 * affordances in MISSING_FEATURES §1:
 *
 *  - **Line numbers**: the gutter maths (`numberLines`) used by the editor
 *    node view, the read-only renderer and any preview.
 *  - **Caption**: the text under a block (`formatCaption` / `validateCaption`),
 *    mirroring how image captions are trimmed before they are stored.
 *
 * Everything here is UI-free and side-effect-free so the editor, the renderer
 * and the unit tests share one definition. Language normalisation delegates to
 * the picker registry (`code-languages.ts`) so the alias map never forks.
 */

import { CODE_LANGUAGES } from "@/lib/code-languages";

/* -------------------------------------------------------------------------- *
 * Line numbers
 * -------------------------------------------------------------------------- */

/** One row of the numbered code gutter. */
export interface NumberedLine {
  /**
   * Gutter number for the row: `start` + the row's logical line index.
   * Wrapped continuation rows (`wrap` option) carry `null` so the gutter can
   * blank them — a source line's number is only shown once, on its first row.
   */
  n: number | null;
  /** The row's text with its line terminator stripped. */
  text: string;
}

/** Options for {@link numberLines}. */
export interface NumberLinesOptions {
  /** First gutter number. Must be a positive integer; anything else → `1`. */
  start?: number;
  /**
   * Soft-wrap each logical line at this many characters (integer ≥ 1), turning
   * one long line into several rows. Omit/`0` to keep one row per line.
   */
  wrap?: number;
  /** Maximum number of rows to return (integer ≥ 0). Omit for every row. */
  max?: number;
}

/** Split a single line into `width`-sized chunks (`[""]` for an empty line). */
function chunkLine(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const parts: string[] = [];
  for (let offset = 0; offset < line.length; offset += width) {
    parts.push(line.slice(offset, offset + width));
  }
  return parts;
}

/**
 * Number the lines of a code block for the gutter.
 *
 * Line endings are normalised first, so `\r\n` and lone `\r` count as one
 * break each. A single trailing terminator does **not** add a phantom final
 * row (content is the lines joined by `\n`), while genuinely blank interior
 * lines are kept. An empty string stays a single empty row so an empty block
 * still shows "1". `max` caps the returned rows; `wrap` splits long lines into
 * continuation rows that share the source line's number (the continuation
 * itself is `n: null`).
 */
export function numberLines(
  code: string,
  options: NumberLinesOptions = {},
): NumberedLine[] {
  const { start, wrap, max } = options;
  const first = Number.isInteger(start) && (start as number) > 0 ? (start as number) : 1;
  const width = Number.isInteger(wrap) && (wrap as number) > 0 ? (wrap as number) : 0;
  const cap = Number.isInteger(max) && (max as number) >= 0 ? (max as number) : Number.POSITIVE_INFINITY;

  const normalized = String(code ?? "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  // "a\n" and "a" describe the same single line; only drop one terminator.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  const rows: NumberedLine[] = [];
  let n = first;
  for (const line of lines) {
    if (rows.length >= cap) break;
    const segments = width > 0 ? chunkLine(line, width) : [line];
    for (let i = 0; i < segments.length; i++) {
      if (rows.length >= cap) break;
      rows.push({ n: i === 0 ? n : null, text: segments[i] });
    }
    n += 1;
  }
  return rows.slice(0, cap);
}

/* -------------------------------------------------------------------------- *
 * Language normalisation
 * -------------------------------------------------------------------------- */

/**
 * Alias → canonical slug map, generated from the picker registry so `js`,
 * `ts`, `py`, … always resolve exactly like the editor's dropdown. Registry
 * values resolve to themselves; unknown slugs pass through untouched.
 */
const LANGUAGE_ALIASES: ReadonlyMap<string, string> = new Map(
  CODE_LANGUAGES.flatMap((lang): (readonly [string, string])[] => [
    [lang.value, lang.value],
    ...(lang.aliases ?? []).map((alias): readonly [string, string] => [alias, lang.value]),
  ]),
);

/**
 * Canonicalise a stored/fence language: trim, lowercase, then resolve known
 * aliases (`js` → `javascript`, `ts` → `typescript`, `py` → `python`, …).
 * Anything unknown is returned as its cleaned lowercase slug so round-tripping
 * a fence language outside the registry still works. `null`/`undefined`/blank
 * yield `""`.
 */
export function normalizeLanguage(value: string | null | undefined): string {
  const slug = String(value ?? "").trim().toLowerCase();
  if (slug === "") return "";
  return LANGUAGE_ALIASES.get(slug) ?? slug;
}

/* -------------------------------------------------------------------------- *
 * Caption
 * -------------------------------------------------------------------------- */

/** Default caption cap used when a caller does not pass `maxLength`. */
export const DEFAULT_CAPTION_MAX_LENGTH = 200;

/** Options for {@link validateCaption}. */
export interface CaptionOptions {
  /** Maximum caption length; defaults to {@link DEFAULT_CAPTION_MAX_LENGTH}. */
  maxLength?: number;
}

/** Result of {@link validateCaption}: `error` is safe to show verbatim. */
export type CaptionValidation = { ok: true } | { ok: false; error: string };

/**
 * Collapse a caption to its stored form: trim the ends and collapse every run
 * of whitespace (including newlines) to a single space. `null`/`undefined`
 * become `""`, so an empty string means "no caption".
 */
export function formatCaption(text: string | null | undefined): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Validate a caption for storage. An empty caption is always valid (it just
 * means "no caption"); otherwise the **formatted** caption is measured, so
 * trailing whitespace never counts against the limit. A non-integer or
 * negative `maxLength` falls back to the default.
 */
export function validateCaption(
  text: string | null | undefined,
  options: CaptionOptions = {},
): CaptionValidation {
  const requested = options.maxLength;
  const maxLength =
    Number.isInteger(requested) && (requested as number) >= 0
      ? (requested as number)
      : DEFAULT_CAPTION_MAX_LENGTH;

  const length = formatCaption(text).length;
  if (length === 0 || length <= maxLength) return { ok: true };
  return { ok: false, error: `Caption is too long — ${length} of ${maxLength} characters.` };
}
