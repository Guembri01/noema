import { describe, expect, it } from "vitest";
import {
  bestTextColor,
  blendColors,
  contrastRatio,
  meetsWCAG,
  parseColor,
  relativeLuminance,
} from "./theme-contrast";

describe("parseColor", () => {
  it("parses shorthand and long hex", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor("#0b57d0")).toEqual({ r: 11, g: 87, b: 208 });
  });

  it("is case-insensitive", () => {
    expect(parseColor("#FFF")).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("parses rgb() with commas or spaces", () => {
    expect(parseColor("rgb(255, 0, 0)")).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseColor("rgb(0 128 255)")).toEqual({ r: 0, g: 128, b: 255 });
  });

  it("parses rgba() and drops the alpha channel", () => {
    expect(parseColor("rgba(10, 20, 30, 0.5)")).toEqual({ r: 10, g: 20, b: 30 });
  });

  it("rejects invalid colors", () => {
    expect(() => parseColor("red")).toThrow(/invalid color/i);
    expect(() => parseColor("#12345")).toThrow(/invalid color/i);
    expect(() => parseColor("rgb(300, 0, 0)")).toThrow(/invalid color/i);
    expect(() => parseColor("rgb(1, 2)")).toThrow(/invalid color/i);
    expect(() => parseColor("rgb(1, 2, 3, 4)")).toThrow(/invalid color/i);
  });
});

describe("relativeLuminance", () => {
  it("is 0 for black and 1 for white", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 10);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 10);
  });

  it("matches the WCAG curve for mid grey", () => {
    expect(relativeLuminance("#808080")).toBeCloseTo(0.2159, 4);
  });

  it("accepts an already-parsed color", () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 10);
  });
});

describe("contrastRatio", () => {
  it("is 21:1 for black on white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });

  it("is 1:1 for identical colors", () => {
    expect(contrastRatio("#1a75d2", "#1a75d2")).toBeCloseTo(1, 5);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#0b57d0", "#ffffff")).toBeCloseTo(
      contrastRatio("#ffffff", "#0b57d0"),
      10,
    );
  });

  it("matches a known ratio for accent blue on white", () => {
    expect(contrastRatio("#0b57d0", "#ffffff")).toBeCloseTo(6.39, 2);
  });

  it("accepts parsed colors mixed with strings", () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, "#ffffff")).toBeCloseTo(21, 5);
  });
});

describe("meetsWCAG", () => {
  it("uses 4.5:1 for AA normal text", () => {
    expect(meetsWCAG(4.5, { level: "AA" })).toBe(true);
    expect(meetsWCAG(4.499, { level: "AA" })).toBe(false);
  });

  it("uses 3:1 for AA large text", () => {
    expect(meetsWCAG(3, { level: "AA", large: true })).toBe(true);
    expect(meetsWCAG(2.999, { level: "AA", large: true })).toBe(false);
  });

  it("uses 7:1 for AAA normal text", () => {
    expect(meetsWCAG(7, { level: "AAA" })).toBe(true);
    expect(meetsWCAG(6.999, { level: "AAA" })).toBe(false);
  });

  it("uses 4.5:1 for AAA large text", () => {
    expect(meetsWCAG(4.5, { level: "AAA", large: true })).toBe(true);
    expect(meetsWCAG(4.499, { level: "AAA", large: true })).toBe(false);
  });
});

describe("bestTextColor", () => {
  const candidates = ["#000000", "#ffffff"];

  it("picks black on a light background", () => {
    expect(bestTextColor("#ffffff", { candidates })).toBe("#000000");
  });

  it("picks white on a dark background", () => {
    expect(bestTextColor("#4d4d4d", { candidates })).toBe("#ffffff");
  });

  it("picks black on a mid grey", () => {
    expect(bestTextColor("#777777", { candidates })).toBe("#000000");
  });

  it("preserves the candidate's original form", () => {
    expect(bestTextColor("rgb(0, 0, 0)", { candidates: ["#fff", "#000"] })).toBe("#fff");
  });

  it("breaks ties toward the first candidate", () => {
    expect(bestTextColor("#ffffff", { candidates: ["#ffffff", "#ffffff"] })).toBe(
      "#ffffff",
    );
  });

  it("requires at least one candidate", () => {
    expect(() => bestTextColor("#ffffff", { candidates: [] })).toThrow(/candidate/i);
  });
});

describe("blendColors", () => {
  it("composites fg over bg at 50%", () => {
    expect(blendColors("#000000", "#ffffff", 0.5)).toEqual({ r: 128, g: 128, b: 128 });
  });

  it("returns fg at alpha 1 and bg at alpha 0", () => {
    expect(blendColors("#ffffff", "#000000", 1)).toEqual({ r: 255, g: 255, b: 255 });
    expect(blendColors("#ffffff", "#000000", 0)).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("blends per channel", () => {
    expect(blendColors("#ff0000", "#ffffff", 0.5)).toEqual({ r: 255, g: 128, b: 128 });
  });

  it("rejects an alpha outside 0..1", () => {
    expect(() => blendColors("#000000", "#ffffff", 1.5)).toThrow(/alpha/i);
    expect(() => blendColors("#000000", "#ffffff", -0.1)).toThrow(/alpha/i);
    expect(() => blendColors("#000000", "#ffffff", Number.NaN)).toThrow(/alpha/i);
  });

  it("composes with contrastRatio for a translucent overlay", () => {
    const overlay = blendColors("#ffffff", "#000000", 0.75);
    expect(contrastRatio(overlay, "#000000")).toBeGreaterThan(10);
  });
});
