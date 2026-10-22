import { describe, expect, it } from "vitest";
import {
  BLOCK_COLOR_CATALOGUE,
  BLOCK_COLOR_ORDER,
  BLOCK_COLOR_TYPES,
  blockColorCss,
  blockColorHue,
} from "./block-colors";

/**
 * ds04 — block-colour catalogue. The catalogue is the single source for the
 * nine tints; these tests pin that it carries no raw hex (presentation lives in
 * the tag tokens) while the persisted ids — the serialization contract — stay
 * exactly what they were.
 */

const HEX = /#[0-9a-fA-F]{3,8}\b/;

describe("BLOCK_COLOR_CATALOGUE catalogue", () => {
  it("offers Default plus the nine hues, in menu order", () => {
    expect(BLOCK_COLOR_CATALOGUE.map((entry) => entry.label)).toEqual([
      "Default",
      "Gray",
      "Brown",
      "Orange",
      "Yellow",
      "Green",
      "Blue",
      "Purple",
      "Pink",
      "Red",
    ]);
    expect(BLOCK_COLOR_CATALOGUE.map((entry) => entry.value)).toEqual([
      null,
      ...BLOCK_COLOR_ORDER,
    ]);
    expect(BLOCK_COLOR_ORDER).toEqual([
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
  });

  it("resolves every tinted entry to a var(--tag-…-bg) token", () => {
    for (const entry of BLOCK_COLOR_CATALOGUE) {
      if (entry.value === null) {
        expect(entry.hue).toBeNull();
        expect(entry.tint).toBe("transparent");
        continue;
      }
      expect(entry.hue).toBe(entry.value);
      expect(entry.tint).toBe(`var(--tag-${entry.hue}-bg)`);
      expect(entry.tint).toMatch(/^var\(--tag-[a-z]+-bg\)$/);
    }
  });

  it("has no raw hex in the catalogue", () => {
    expect(JSON.stringify(BLOCK_COLOR_CATALOGUE)).not.toMatch(HEX);
  });

  it("keeps the same paintable node types", () => {
    expect(BLOCK_COLOR_TYPES).toContain("paragraph");
    expect(BLOCK_COLOR_TYPES).toContain("heading");
    expect(BLOCK_COLOR_TYPES).toContain("codeBlock");
  });
});

describe("blockColorHue — stable id ↔ hue mapping", () => {
  it("pins the persisted id → tag hue table", () => {
    const mapping = BLOCK_COLOR_CATALOGUE.filter((entry) => entry.value !== null).map(
      (entry) => [entry.value, entry.hue],
    );
    expect(mapping).toEqual([
      ["gray", "gray"],
      ["brown", "brown"],
      ["orange", "orange"],
      ["yellow", "yellow"],
      ["green", "green"],
      ["blue", "blue"],
      ["purple", "purple"],
      ["pink", "pink"],
      ["red", "red"],
    ]);
  });

  it("is case- and whitespace-tolerant", () => {
    expect(blockColorHue(" RED ")).toBe("red");
    expect(blockColorHue("Blue")).toBe("blue");
  });

  it("rejects Default, unknown and non-string ids", () => {
    expect(blockColorHue(null)).toBeNull();
    expect(blockColorHue(undefined)).toBeNull();
    expect(blockColorHue("")).toBeNull();
    expect(blockColorHue("teal")).toBeNull(); // a tag hue, not a block colour
    expect(blockColorHue("magenta")).toBeNull();
    expect(blockColorHue(42 as unknown as string)).toBeNull();
  });
});

describe("blockColorCss", () => {
  it("returns the tag background + matching foreground token", () => {
    expect(blockColorCss("blue")).toEqual({
      backgroundColor: "var(--tag-blue-bg)",
      color: "var(--tag-blue-fg)",
    });
    expect(blockColorCss("gray")).toEqual({
      backgroundColor: "var(--tag-gray-bg)",
      color: "var(--tag-gray-fg)",
    });
  });

  it("clears to transparent for Default and unknown ids", () => {
    expect(blockColorCss(null)).toEqual({ backgroundColor: "transparent" });
    expect(blockColorCss(undefined)).toEqual({ backgroundColor: "transparent" });
    expect(blockColorCss("nope")).toEqual({ backgroundColor: "transparent" });
  });

  it("never emits a raw hex for any catalogue id", () => {
    for (const hue of BLOCK_COLOR_ORDER) {
      expect(JSON.stringify(blockColorCss(hue))).not.toMatch(HEX);
    }
  });
});
