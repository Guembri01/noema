/**
 * Pull quote / large quote (docs/MISSING_FEATURES.md §1 "Pull quote / large
 * quote" — display-scale quotation styling).
 *
 * A pull quote is a quotation pulled out of the body copy and set at a larger
 * display scale. It is a small value object — the quote text, an optional
 * attribution ("— Who said it") and an optional display size — plus the two
 * conversions every block-shaped feature in the app exposes:
 *
 *   • `parsePullQuote`  — tolerant raw value/JSON → `{ ok, value | error }`
 *   • `validatePullQuote` — non-empty text, capped attribution, known scale
 *   • `formatPullQuote` — text + optional em-dashed attribution (plain text)
 *   • `quoteToBlocks` / `blocksToQuote` — the editor block pair round trip
 *
 * Everything here is pure and deterministic: no `Date`, no randomness, so the
 * server render and the client paint agree byte-for-byte.
 */

export type PullQuoteSize = "default" | "large";

export type PullQuote = {
  /** The quoted words. Required and non-empty once validated. */
  text: string;
  /** Who said it — rendered after an em dash. Optional. */
  attribution?: string;
  /** Display scale. Missing means `"default"`. */
  size?: PullQuoteSize;
};

/** Longest attribution we store, measured after trimming. */
export const ATTRIBUTION_MAX = 200;

/** The supported display scales, smallest first. */
export const DISPLAY_SCALES = ["default", "large"] as const;

export const DEFAULT_PULL_QUOTE_SIZE: PullQuoteSize = "default";

const SCALES = new Set<string>(DISPLAY_SCALES);

/** Em dash we put before an attribution (typographic, not a hyphen). */
const ATTRIBUTION_MARK = "\u2014";

/** Leading em dash / en dash / hyphen(s) a hand-written attribution may carry. */
const ATTRIBUTION_PREFIX = /^\s*[\u2014\u2013-]{1,2}\s*/;

export type ParsePullQuoteResult =
  | { ok: true; value: PullQuote }
  | { ok: false; error: string };

export type PullQuoteValidation = { ok: true } | { ok: false; errors: string[] };

/** A block in the editor's JSON shape — the subset a pull quote needs. */
export type PullQuoteBlock = {
  type: "blockquote" | "paragraph";
  content?: Array<{ type: "text"; text: string }>;
  attrs?: { size?: PullQuoteSize };
};

/** Type guard for the display scale union. */
export function isPullQuoteSize(value: unknown): value is PullQuoteSize {
  return typeof value === "string" && SCALES.has(value);
}

/** Trim CRLF-normalised text; `null` when the value is not a string at all. */
function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/\r\n?/g, "\n").trim();
}

/** True when the value is a plain (non-array) object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coerce tolerant input to an object shape. Strings are accepted as either a
 * JSON object or the quote text itself, which is what makes pasted prose and
 * serialized values both round-trip without a special case at the call site.
 */
function toRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isRecord(parsed)) return parsed;
      } catch {
        // Not JSON after all — fall through and treat it as the quote text.
      }
    }
    return { text: trimmed };
  }
  return isRecord(raw) ? raw : null;
}

/**
 * Validate a raw/unknown value against the pull-quote rules. Returns every
 * problem at once so a form can show them together; `parsePullQuote` surfaces
 * the first as a single error string.
 */
export function validatePullQuote(quote: unknown): PullQuoteValidation {
  if (!isRecord(quote)) {
    return { ok: false, errors: ["A pull quote must be an object."] };
  }
  const errors: string[] = [];

  if (cleanText(quote.text) === "" || typeof quote.text !== "string") {
    errors.push("A pull quote needs text.");
  }

  if (quote.attribution !== undefined && quote.attribution !== null) {
    if (typeof quote.attribution !== "string") {
      errors.push("The attribution must be a string.");
    } else if (quote.attribution.trim().length > ATTRIBUTION_MAX) {
      errors.push(`The attribution must be ${ATTRIBUTION_MAX} characters or fewer.`);
    }
  }

  if (quote.size !== undefined && quote.size !== null && !isPullQuoteSize(quote.size)) {
    errors.push('The size must be "default" or "large".');
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

/**
 * Parse a raw value into a normalised `PullQuote`.
 *
 * Accepts an object, a JSON object string, or a bare string (treated as the
 * text). Text and attribution are trimmed; blank attributions are dropped; a
 * missing `size` stays missing. Invalid input comes back as
 * `{ ok: false, error }` rather than throwing.
 */
export function parsePullQuote(raw: unknown): ParsePullQuoteResult {
  const record = toRecord(raw);
  if (!record) {
    return { ok: false, error: "A pull quote must be an object or a JSON string." };
  }

  const value: PullQuote = { text: cleanText(record.text) ?? "" };

  if (record.attribution !== undefined && record.attribution !== null) {
    if (typeof record.attribution !== "string") {
      return { ok: false, error: "The attribution must be a string." };
    }
    const attribution = cleanText(record.attribution) ?? "";
    if (attribution) value.attribution = attribution;
  }

  if (record.size !== undefined && record.size !== null) {
    if (!isPullQuoteSize(record.size)) {
      return { ok: false, error: `"${String(record.size)}" is not a display scale.` };
    }
    value.size = record.size;
  }

  const validation = validatePullQuote(value);
  if (!validation.ok) return { ok: false, error: validation.errors[0] };
  return { ok: true, value };
}

/**
 * Render a pull quote as plain text: the quote, then an em-dashed attribution
 * on its own line. A blank attribution is omitted.
 */
export function formatPullQuote(quote: PullQuote): string {
  const text = quote.text.trim();
  const attribution = quote.attribution?.trim();
  return attribution ? `${text}\n${ATTRIBUTION_MARK} ${attribution}` : text;
}

/** Flatten a block's inline text content. */
function blockText(block: PullQuoteBlock): string {
  return (block.content ?? []).map((node) => node.text).join("");
}

/** Drop a leading dash a hand-written attribution may carry. */
function stripAttributionMark(value: string): string {
  return value.replace(ATTRIBUTION_PREFIX, "").trim();
}

/**
 * Convert a pull quote into the editor's block pair: a `blockquote` carrying
 * the quote text (with a `size` attr only when the scale is not the default),
 * followed by a `paragraph` for the attribution when there is one.
 */
export function quoteToBlocks(quote: PullQuote): PullQuoteBlock[] {
  const text = quote.text.trim();
  const first: PullQuoteBlock = { type: "blockquote", content: [{ type: "text", text }] };
  if (quote.size && quote.size !== DEFAULT_PULL_QUOTE_SIZE) {
    first.attrs = { size: quote.size };
  }

  const blocks: PullQuoteBlock[] = [first];
  const attribution = quote.attribution?.trim();
  if (attribution) {
    blocks.push({
      type: "paragraph",
      content: [{ type: "text", text: `${ATTRIBUTION_MARK} ${attribution}` }],
    });
  }
  return blocks;
}

/**
 * Read a block pair back into a `PullQuote`. The first non-empty block is the
 * quote text (its `size` attr, when valid, is kept); the next non-empty block
 * is the attribution, with any leading dash stripped. Blank blocks are ignored
 * so a quote that was split or padded while editing still parses.
 */
export function blocksToQuote(blocks: readonly PullQuoteBlock[]): PullQuote {
  const quote: PullQuote = { text: "" };
  let seenText = false;

  for (const block of blocks) {
    const value = blockText(block).trim();
    if (!value) continue;

    if (!seenText) {
      quote.text = value;
      if (isPullQuoteSize(block.attrs?.size)) quote.size = block.attrs?.size;
      seenText = true;
    } else if (quote.attribution === undefined) {
      quote.attribution = stripAttributionMark(value);
      if (!quote.attribution) quote.attribution = undefined;
    }
  }

  return quote;
}
