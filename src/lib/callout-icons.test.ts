import { describe, expect, it } from "vitest";
import { EMOJI_SHORTCODES } from "@/lib/emoji";
import {
  CALLOUT_ICONS,
  DEFAULT_CALLOUT_ICON,
  isCalloutIcon,
  normalizeCalloutIcon,
  searchIcons,
  type CalloutIconCategory,
} from "@/lib/callout-icons";

/**
 * Callout icon picker catalog (`docs/MISSING_FEATURES` §1).
 *
 * Pure API backing the in-block picker: a curated, categorized subset of the
 * shared emoji table (`@/lib/emoji`) plus search/validation helpers. The emoji
 * glyphs + keywords are reused, never duplicated.
 */
describe("callout icon catalog", () => {
  it("curates a categorized subset of the shared emoji table", () => {
    expect(CALLOUT_ICONS.length).toBeGreaterThanOrEqual(30);
    const categories = new Set<CalloutIconCategory>();
    const glyphs = new Set<string>();
    for (const icon of CALLOUT_ICONS) {
      // Every entry resolves to a real shortcode; no table is duplicated here.
      expect(EMOJI_SHORTCODES[icon.shortcode], `missing shortcode: ${icon.shortcode}`).toBeDefined();
      expect(icon.emoji).toBe(EMOJI_SHORTCODES[icon.shortcode]);
      expect(icon.keywords.length).toBeGreaterThan(0);
      categories.add(icon.category);
      glyphs.add(icon.emoji);
    }
    expect(glyphs.size).toBe(CALLOUT_ICONS.length); // no duplicate icons
    expect(categories.size).toBeGreaterThanOrEqual(5);
    expect(categories.has("objects")).toBe(true);
  });
});

describe("searchIcons", () => {
  it("returns the curated catalog in stable order for an empty query", () => {
    expect(searchIcons("")).toEqual(CALLOUT_ICONS);
    expect(searchIcons("   ")).toEqual(searchIcons("")); // blank == empty
    expect(searchIcons("", { limit: 5 })).toEqual(CALLOUT_ICONS.slice(0, 5));
    expect(searchIcons("", { limit: 0 })).toEqual([]);
  });

  it("matches keywords through the shared emoji search", () => {
    expect(searchIcons("idea")[0]?.emoji).toBe("💡");
    expect(searchIcons("plant").map((i) => i.emoji)).toContain("🌱");
    expect(searchIcons("confetti").map((i) => i.emoji)).toContain("🎉");
    expect(searchIcons("IDEA")).toEqual(searchIcons("idea")); // case-insensitive
  });

  it("matches categories as well as keywords", () => {
    const nature = searchIcons("nature");
    expect(nature.map((i) => i.emoji)).toContain("🐛");
    for (const icon of nature) expect(icon.category).toBe("nature");
    expect(searchIcons("smileys").map((i) => i.emoji)).toContain("🙂");
  });

  it("caps results at the limit while keeping order", () => {
    const all = searchIcons("s");
    expect(all.length).toBeGreaterThan(3);
    expect(searchIcons("s", { limit: 3 })).toEqual(all.slice(0, 3));
    expect(searchIcons("s", { limit: 3 })).toHaveLength(3);
  });

  it("returns an empty list when nothing matches", () => {
    expect(searchIcons("zzznotanicon")).toEqual([]);
    expect(searchIcons("🦄")).toEqual([]); // an emoji is not a query
  });
});

describe("isCalloutIcon / normalizeCalloutIcon", () => {
  it("accepts curated glyphs and rejects everything else", () => {
    expect(isCalloutIcon("💡")).toBe(true);
    expect(isCalloutIcon("🚀")).toBe(true);
    expect(isCalloutIcon("hello")).toBe(false);
    expect(isCalloutIcon("")).toBe(false);
    expect(isCalloutIcon("🦄")).toBe(false); // valid emoji, not in the catalog
  });

  it("falls back to the default icon for unknown values", () => {
    expect(DEFAULT_CALLOUT_ICON).toBe("💡");
    expect(isCalloutIcon(DEFAULT_CALLOUT_ICON)).toBe(true);
    expect(normalizeCalloutIcon("🔥")).toBe("🔥");
    expect(normalizeCalloutIcon("nope")).toBe(DEFAULT_CALLOUT_ICON);
    expect(normalizeCalloutIcon(null)).toBe(DEFAULT_CALLOUT_ICON);
    expect(normalizeCalloutIcon(undefined)).toBe(DEFAULT_CALLOUT_ICON);
  });
});
