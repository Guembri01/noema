import { describe, expect, it } from "vitest";
import {
  HUE_LABELS,
  HUE_NAMES,
  hueEdge,
  hueInk,
  hueLabel,
  hueSurface,
  isHue,
  normalizeHue,
} from "./palette";
import { TAG_HUES } from "@/lib/design-tokens";
import {
  BLOCK_COLORS,
  BLOCK_COLOR_HUES,
} from "@/components/editor/extensions/block-colors";
import {
  COLOR_CHOICES,
  OPTION_COLORS,
  optionEdge,
  optionHue,
  optionInk,
  optionSurface,
} from "@/components/database/database-types";

/**
 * The one colour catalogue.
 *
 * `palette.ts` is the single façade both tag-hue catalogues delegate to. These
 * tests pin the two promises the refactor must keep: (1) every persisted id is
 * byte-for-byte unchanged, so old data still round-trips, and (2) every hue
 * resolves to a `var(--tag-*)` token rather than any hard-coded colour.
 */

/** A tag token expression, e.g. `var(--tag-blue-bd)`. */
const TAG_TOKEN = /^var\(--tag-[a-z]+-(fg|bg|bd)\)$/;
/** A raw hex colour, anywhere. */
const RAW_HEX = /#[0-9a-fA-F]{3,8}\b/;

describe("palette — hue list and token lookups", () => {
  it("exposes the shared tag-hue list, in token order", () => {
    expect(HUE_NAMES).toEqual([
      "gray",
      "brown",
      "orange",
      "yellow",
      "green",
      "blue",
      "purple",
      "pink",
      "red",
      "teal",
    ]);
    // The list is the token layer's list — not a second copy that can drift.
    expect(HUE_NAMES).toBe(TAG_HUES);
  });

  it("labels every hue", () => {
    for (const hue of HUE_NAMES) {
      expect(typeof HUE_LABELS[hue]).toBe("string");
      expect(HUE_LABELS[hue].length).toBeGreaterThan(0);
      expect(hueLabel(hue)).toBe(HUE_LABELS[hue]);
    }
  });

  it("resolves every hue to a var(--tag-*) token", () => {
    for (const hue of HUE_NAMES) {
      expect(hueInk(hue)).toBe(`var(--tag-${hue}-fg)`);
      expect(hueSurface(hue)).toBe(`var(--tag-${hue}-bg)`);
      expect(hueEdge(hue)).toBe(`var(--tag-${hue}-bd)`);
      expect(hueInk(hue)).toMatch(TAG_TOKEN);
      expect(hueSurface(hue)).toMatch(TAG_TOKEN);
      expect(hueEdge(hue)).toMatch(TAG_TOKEN);
      expect(JSON.stringify([hueInk(hue), hueSurface(hue), hueEdge(hue)])).not.toMatch(RAW_HEX);
    }
  });

  it("normalises unknown hues to gray and guards values", () => {
    expect(normalizeHue("chartreuse")).toBe("gray");
    expect(normalizeHue(null)).toBe("gray");
    expect(normalizeHue(undefined)).toBe("gray");
    expect(normalizeHue("")).toBe("gray");
    expect(hueInk("nope")).toBe("var(--tag-gray-fg)");
    expect(hueSurface(null)).toBe("var(--tag-gray-bg)");
    expect(hueEdge(undefined)).toBe("var(--tag-gray-bd)");
    expect(isHue("blue")).toBe(true);
    expect(isHue("chartreuse")).toBe(false);
    expect(isHue(42)).toBe(false);
  });
});

describe("palette — the persisted catalogues delegate to it", () => {
  it("pins the block-colour id list (unchanged serialization contract)", () => {
    expect(BLOCK_COLOR_HUES).toEqual([
      "gray",
      "brown",
      "orange",
      "yellow",
      "green",
      "blue",
      "purple",
      "pink",
      "red",
    ]);
    // Default + the nine hue rows, painted from the palette.
    expect(BLOCK_COLORS.map((entry) => entry.value)).toEqual([null, ...BLOCK_COLOR_HUES]);
    for (const entry of BLOCK_COLORS) {
      if (entry.value === null) {
        expect(entry.tint).toBe("transparent");
        continue;
      }
      expect(entry.hue).toBe(entry.value);
      expect(entry.tint).toBe(hueSurface(entry.hue));
      expect(entry.label).toBe(hueLabel(entry.hue));
    }
  });

  it("pins the option-colour id list (unchanged serialization contract)", () => {
    // The same nine ids `COLOR_CHOICES` offers, in the frozen catalogue order.
    expect(Object.keys(OPTION_COLORS)).toEqual([
      "gray",
      "blue",
      "green",
      "red",
      "yellow",
      "orange",
      "purple",
      "pink",
      "brown",
    ]);
    expect(new Set(Object.keys(OPTION_COLORS))).toEqual(new Set(COLOR_CHOICES));
  });

  it("resolves both catalogues through the palette lookups", () => {
    for (const [id, value] of Object.entries(OPTION_COLORS)) {
      expect(value).toBe(hueInk(id));
      expect(value).toMatch(TAG_TOKEN);
    }
    for (const hue of TAG_HUES) {
      expect(optionHue(hue)).toBe(hue);
      expect(optionInk(hue)).toBe(hueInk(hue));
      expect(optionSurface(hue)).toBe(hueSurface(hue));
      expect(optionEdge(hue)).toBe(hueEdge(hue));
    }
  });
});
