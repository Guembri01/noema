/**
 * Callout icon catalog + picker helpers (`docs/MISSING_FEATURES` §1).
 *
 * Pure and side-effect free. The emoji glyphs and their search keywords are
 * NOT re-listed here — they live in `@/lib/emoji` (`EMOJI_SHORTCODES`,
 * `EMOJI_ALIASES`, `emojiCandidates`) and are reused read-only. This module
 * only adds the callout-friendly grouping plus the search/validation API the
 * in-block picker needs, so callouts and the `:emoji:` autocomplete share one
 * source of truth.
 */
import { EMOJI_ALIASES, EMOJI_SHORTCODES, emojiCandidates } from "@/lib/emoji";

/** Glyph shown on a callout that has no (valid) icon yet. */
export const DEFAULT_CALLOUT_ICON = "💡";

/** Picker sections, mirroring the emoji groups in `@/lib/emoji`. */
export type CalloutIconCategory =
  | "objects"
  | "symbols"
  | "smileys"
  | "people"
  | "activities"
  | "nature"
  | "food"
  | "travel";

export type CalloutIcon = {
  /** Backing shortcode (a key of `EMOJI_SHORTCODES`). */
  shortcode: string;
  /** The emoji glyph stored on the callout node. */
  emoji: string;
  /** Picker section this icon belongs to. */
  category: CalloutIconCategory;
  /** Curated search keywords (aliases from `@/lib/emoji`). */
  keywords: string[];
};

/**
 * Curated, callout-friendly subset of the shared emoji table, in picker order.
 * The most-used callout icons come first so an empty query surfaces them.
 */
const CATALOG: ReadonlyArray<{ shortcode: string; category: CalloutIconCategory }> = [
  { shortcode: "bulb", category: "objects" },
  { shortcode: "memo", category: "objects" },
  { shortcode: "check", category: "symbols" },
  { shortcode: "warning", category: "symbols" },
  { shortcode: "fire", category: "symbols" },
  { shortcode: "star", category: "symbols" },
  { shortcode: "heart", category: "symbols" },
  { shortcode: "sparkles", category: "symbols" },
  { shortcode: "tada", category: "activities" },
  { shortcode: "rocket", category: "travel" },
  { shortcode: "eyes", category: "objects" },
  { shortcode: "lock", category: "objects" },
  { shortcode: "calendar", category: "objects" },
  { shortcode: "page", category: "objects" },
  { shortcode: "mail", category: "objects" },
  { shortcode: "chart", category: "objects" },
  { shortcode: "hourglass", category: "objects" },
  { shortcode: "zap", category: "symbols" },
  { shortcode: "x", category: "symbols" },
  { shortcode: "100", category: "symbols" },
  { shortcode: "broken_heart", category: "symbols" },
  { shortcode: "smile", category: "smileys" },
  { shortcode: "thinking", category: "smileys" },
  { shortcode: "joy", category: "smileys" },
  { shortcode: "sob", category: "smileys" },
  { shortcode: "angry", category: "smileys" },
  { shortcode: "sunglasses", category: "smileys" },
  { shortcode: "grin", category: "smileys" },
  { shortcode: "neutral_face", category: "smileys" },
  { shortcode: "confounded", category: "smileys" },
  { shortcode: "crying_face", category: "smileys" },
  { shortcode: "thumbsup", category: "people" },
  { shortcode: "thumbs_down", category: "people" },
  { shortcode: "clap", category: "people" },
  { shortcode: "wave", category: "people" },
  { shortcode: "pray", category: "people" },
  { shortcode: "muscle", category: "people" },
  { shortcode: "point_up", category: "people" },
  { shortcode: "ok_hand", category: "people" },
  { shortcode: "party", category: "activities" },
  { shortcode: "puzzle", category: "activities" },
  { shortcode: "gift", category: "activities" },
  { shortcode: "seedling", category: "nature" },
  { shortcode: "bug", category: "nature" },
  { shortcode: "coffee", category: "food" },
  { shortcode: "pizza", category: "food" },
  { shortcode: "apple", category: "food" },
  { shortcode: "cake", category: "food" },
  { shortcode: "airplane", category: "travel" },
  { shortcode: "car", category: "travel" },
];

/** The curated catalog, with glyphs + keywords derived from `@/lib/emoji`. */
export const CALLOUT_ICONS: readonly CalloutIcon[] = CATALOG.map(
  ({ shortcode, category }) => ({
    shortcode,
    emoji: EMOJI_SHORTCODES[shortcode],
    category,
    keywords: [...(EMOJI_ALIASES[shortcode] ?? [])],
  }),
);

const ICON_BY_SHORTCODE = new Map(CALLOUT_ICONS.map((icon) => [icon.shortcode, icon]));
const CALLOUT_ICON_GLYPHS = new Set(CALLOUT_ICONS.map((icon) => icon.emoji));

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return CALLOUT_ICONS.length;
  return Number.isInteger(limit) ? Math.max(0, limit) : CALLOUT_ICONS.length;
}

/** A category matches by exact name or prefix (`"sym"` → `"symbols"`). */
function matchesCategory(category: CalloutIconCategory, query: string): boolean {
  return category === query || category.startsWith(query);
}

/**
 * Search the catalog for the picker. Keyword/shortcode matches come from the
 * shared `emojiCandidates` search (so `"plant"` finds 🌱, `"confetti"` finds
 * 🎉), then category matches fill in the rest — both keep a deterministic,
 * stable order. An empty/blank query returns the catalog top-N. `limit`
 * defaults to the whole catalog; `0` (or less) returns nothing.
 */
export function searchIcons(
  query: string,
  options: { limit?: number } = {},
): CalloutIcon[] {
  const limit = resolveLimit(options.limit);
  if (limit <= 0) return [];
  const q = (query ?? "").trim().toLowerCase();
  if (q === "") return CALLOUT_ICONS.slice(0, limit);

  const results: CalloutIcon[] = [];
  const seen = new Set<string>();
  const push = (icon: CalloutIcon | undefined) => {
    if (icon && !seen.has(icon.shortcode)) {
      seen.add(icon.shortcode);
      results.push(icon);
    }
  };
  for (const candidate of emojiCandidates(q, CALLOUT_ICONS.length)) {
    push(ICON_BY_SHORTCODE.get(candidate.shortcode));
  }
  for (const icon of CALLOUT_ICONS) {
    if (matchesCategory(icon.category, q)) push(icon);
  }
  return results.slice(0, limit);
}

/**
 * Whether `value` is a curated callout icon glyph. A strict allow-list: a
 * plausible-but-uncurated emoji (or any non-string) is rejected.
 */
export function isCalloutIcon(value: unknown): value is string {
  return typeof value === "string" && CALLOUT_ICON_GLYPHS.has(value);
}

/** Coerce any stored value to a valid callout glyph, falling back to the default. */
export function normalizeCalloutIcon(value: unknown): string {
  return isCalloutIcon(value) ? value : DEFAULT_CALLOUT_ICON;
}
