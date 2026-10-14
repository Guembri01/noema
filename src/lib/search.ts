/**
 * Full-text search support.
 *
 * Pages keep a plain-text mirror (`Page.searchText`) so Postgres can index the
 * content with a GIN index and rank results — instead of the old approach of
 * pulling every page into Node and scanning it with `String.includes`.
 */

import { prosemirrorToText } from "@/lib/blocks";

/** Plain-text mirror of a page for indexing. Bounded so a huge page cannot bloat a row. */
export function pageSearchText(title: string | null, content: unknown): string {
  const body = prosemirrorToText(content);
  return `${title ?? ""}\n${body}`.replace(/\s+/g, " ").trim().slice(0, 100_000);
}

/** Words a query can be turned into, for the prefix (type-ahead) pass. */
export function searchTerms(query: string): string[] {
  return (query ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((term) => term.length >= 2)
    .slice(0, 8);
}

/** A short excerpt around the first match, for result lists. */
export function makeSnippet(text: string, query: string): string {
  const haystack = (text ?? "").toLowerCase();
  const needle = (query ?? "").trim().toLowerCase();
  if (!needle) return "";
  const index = haystack.indexOf(needle);
  if (index === -1) return text.slice(0, 120);
  const start = Math.max(0, index - 40);
  return text.slice(start, index + 120).trim();
}
