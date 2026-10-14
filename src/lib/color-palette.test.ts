import { describe, expect, it } from "vitest";
import {
  PALETTE_STEPS,
  darken,
  generatePalette,
  isValidHex,
  lighten,
  parseHex,
  shade,
  tint,
  toHex,
} from "./color-palette";
import { relativeLuminance } from "./theme-contrast";

describe("parseHex", () => {
  it("expands shorthand and long hex", () => {
    expect(parseHex("#abc")).toEqual({ r: 170, g: 187, b: 204 });
    expect(parseHex("#0b57d0")).toEqual({ r: 11, g: 87, b: 208 });
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(parseHex("#0B57D0")).toEqual({ r: 11, g: 87, b: 208 });
    expect(parseHex("  #fff  ")).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("rejects anything that is not #rgb or #rrggbb", () => {
    expect(() => parseHex("abc")).toThrow(/invalid hex/i);
    expect(() => parseHex("#abcd")).toThrow(/invalid hex/i);
    expect(() => parseHex("#12345")).toThrow(/invalid hex/i);
    expect(() => parseHex("#gggggg")).toThrow(/invalid hex/i);
    expect(() => parseHex("rgb(1, 2, 3)")).toThrow(/invalid hex/i);
  });
});

describe("isValidHex", () => {
  it("accepts #rgb and #rrggbb in any case", () => {
    expect(isValidHex("#fff")).toBe(true);
    expect(isValidHex("#0B57D0")).toBe(true);
    expect(isValidHex("#abc")).toBe(true);
  });

  it("rejects malformed hex", () => {
    expect(isValidHex("fff")).toBe(false);
    expect(isValidHex("#abcd")).toBe(false);
    expect(isValidHex("#12345")).toBe(false);
    expect(isValidHex("#xyzxyz")).toBe(false);
  });
});

describe("toHex", () => {
  it("serialises channels as lowercase, zero-padded #rrggbb", () => {
    expect(toHex({ r: 255, g: 255, b: 255 })).toBe("#ffffff");
    expect(toHex({ r: 0, g: 0, b: 0 })).toBe("#000000");
    expect(toHex({ r: 11, g: 87, b: 208 })).toBe("#0b57d0");
  });

  it("rounds and clamps channels", () => {
    expect(toHex({ r: 300, g: -5, b: 12.6 })).toBe("#ff000d");
    expect(toHex({ r: 127.5, g: 0, b: 0 })).toBe("#800000");
  });

  it("round-trips through parseHex", () => {
    expect(toHex(parseHex("#0b57d0"))).toBe("#0b57d0");
    expect(toHex(parseHex("#abc"))).toBe("#aabbcc");
  });
});

describe("lighten / darken", () => {
  it("mixes towards white and black by amount (0..1)", () => {
    expect(lighten("#000000", 0)).toBe("#000000");
    expect(lighten("#000000", 0.5)).toBe("#808080");
    expect(lighten("#000000", 1)).toBe("#ffffff");
    expect(darken("#ffffff", 0.5)).toBe("#808080");
    expect(darken("#ffffff", 1)).toBe("#000000");
  });

  it("is a no-op when the target is already reached", () => {
    expect(lighten("#ffffff", 0.5)).toBe("#ffffff");
    expect(darken("#000000", 0.5)).toBe("#000000");
  });

  it("clamps amounts outside 0..1", () => {
    expect(lighten("#000000", 2)).toBe("#ffffff");
    expect(lighten("#000000", -1)).toBe("#000000");
    expect(darken("#ffffff", 5)).toBe("#000000");
  });

  it("is deterministic", () => {
    expect(lighten("#3b82f6", 0.25)).toBe(lighten("#3b82f6", 0.25));
  });
});

describe("tint / shade", () => {
  it("mixes towards white and black by percent (0..100)", () => {
    expect(tint("#000000", 0)).toBe("#000000");
    expect(tint("#000000", 50)).toBe("#808080");
    expect(tint("#000000", 100)).toBe("#ffffff");
    expect(shade("#ffffff", 50)).toBe("#808080");
    expect(shade("#ffffff", 100)).toBe("#000000");
  });

  it("matches lighten/darken at the equivalent fraction", () => {
    expect(tint("#3b82f6", 40)).toBe(lighten("#3b82f6", 0.4));
    expect(shade("#3b82f6", 40)).toBe(darken("#3b82f6", 0.4));
  });

  it("clamps percents outside 0..100", () => {
    expect(tint("#000000", 1000)).toBe("#ffffff");
    expect(shade("#ffffff", -50)).toBe("#ffffff");
  });
});

describe("generatePalette", () => {
  it("produces every ordered step with the base at 500", () => {
    const palette = generatePalette("#3b82f6");
    expect(Object.keys(palette).map(Number)).toEqual([...PALETTE_STEPS]);
    expect(palette[500]).toBe("#3b82f6");
    expect(PALETTE_STEPS).toEqual([50, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
  });

  it("normalises the base and mixes towards white below 500", () => {
    expect(generatePalette("#FFF")[500]).toBe("#ffffff");
    const palette = generatePalette("#3b82f6");
    expect(palette[50]).toBe("#f5f9ff");
    expect(palette[300]).toBe("#b1cdfb");
  });

  it("mixes towards black above 500", () => {
    const palette = generatePalette("#3b82f6");
    expect(palette[600]).toBe("#326fd1");
    expect(palette[900]).toBe("#0f213e");
  });

  it("is monotonically lighter→darker across the scale", () => {
    const palette = generatePalette("#3b82f6");
    const luminances = PALETTE_STEPS.map((step) => relativeLuminance(palette[step]));
    for (let i = 1; i < luminances.length; i += 1) {
      expect(luminances[i]).toBeLessThan(luminances[i - 1]);
    }
  });

  it("is deterministic", () => {
    expect(generatePalette("#7c3aed")).toEqual(generatePalette("#7c3aed"));
  });
});
