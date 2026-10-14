import { describe, expect, it } from "vitest";
import {
  aspectRatio,
  clampSize,
  fitContain,
  fitCover,
  parseDimensions,
  percentToPx,
  resizeByWidth,
  scalePercent,
  type Size,
} from "./image-dimensions";

/**
 * Image sizing math — the pure intrinsic-vs-box arithmetic behind an image
 * block and a page cover (FEATURE_MATRIX "Image resize": rows :82 and :558).
 *
 * Written RED-first against a missing module, then implemented. Coverage pins:
 * - tolerant `"WxH"` / bare-number parsing with a zero-size fallback,
 * - contain vs cover scaling for wide and tall sources (letterbox /
 *   pillarbox / overflow crop),
 * - independent per-axis clamping, aspect ratio, percentage scaling,
 * - width-driven resize that preserves the intrinsic ratio,
 * - percentage→pixel conversion,
 * - integer rounding and fail-to-zero guards on zero / non-finite input.
 */

const wide: Size = { w: 1200, h: 800 };
const tall: Size = { w: 800, h: 1200 };

describe("parseDimensions — intrinsic size from stored strings/numbers", () => {
  it("parses a WxH string with lower, upper or multiplication-sign separators", () => {
    expect(parseDimensions("1200x800")).toEqual({ w: 1200, h: 800 });
    expect(parseDimensions("800X600")).toEqual({ w: 800, h: 600 });
    expect(parseDimensions("1920×1080")).toEqual({ w: 1920, h: 1080 });
  });

  it("tolerates surrounding spaces around the separator", () => {
    expect(parseDimensions(" 1024 x 768 ")).toEqual({ w: 1024, h: 768 });
  });

  it("treats a bare number (string or number) as a square", () => {
    expect(parseDimensions("512")).toEqual({ w: 512, h: 512 });
    expect(parseDimensions(512)).toEqual({ w: 512, h: 512 });
  });

  it("rounds a fractional numeric side to an integer", () => {
    expect(parseDimensions(512.4)).toEqual({ w: 512, h: 512 });
  });

  it("fails to zero size on garbage, zero, negative and non-finite input", () => {
    expect(parseDimensions("not-a-size")).toEqual({ w: 0, h: 0 });
    expect(parseDimensions("1200x")).toEqual({ w: 0, h: 0 });
    expect(parseDimensions("0x0")).toEqual({ w: 0, h: 0 });
    expect(parseDimensions(0)).toEqual({ w: 0, h: 0 });
    expect(parseDimensions(-10)).toEqual({ w: 0, h: 0 });
    expect(parseDimensions(Number.NaN)).toEqual({ w: 0, h: 0 });
    expect(parseDimensions(Number.POSITIVE_INFINITY)).toEqual({ w: 0, h: 0 });
  });
});

describe("fitContain — scale to sit inside the box (letterbox)", () => {
  it("letterboxes a wide image in a square box", () => {
    expect(fitContain(wide, { w: 400, h: 400 })).toEqual({ w: 400, h: 267 });
  });

  it("pillarboxes a tall image in a square box", () => {
    expect(fitContain(tall, { w: 400, h: 400 })).toEqual({ w: 267, h: 400 });
  });

  it("scales up a small image to fill the limiting axis", () => {
    expect(fitContain({ w: 100, h: 50 }, { w: 400, h: 400 })).toEqual({ w: 400, h: 200 });
  });

  it("returns zero size for a zero or non-finite intrinsic or box", () => {
    expect(fitContain({ w: 0, h: 100 }, { w: 400, h: 400 })).toEqual({ w: 0, h: 0 });
    expect(fitContain(wide, { w: 400, h: 0 })).toEqual({ w: 0, h: 0 });
    expect(fitContain({ w: Number.NaN, h: 100 }, { w: 400, h: 400 })).toEqual({ w: 0, h: 0 });
  });
});

describe("fitCover — scale to cover the box (overflow crops)", () => {
  it("fills a square box from a wide image by matching height", () => {
    expect(fitCover(wide, { w: 400, h: 400 })).toEqual({ w: 600, h: 400 });
  });

  it("fills a square box from a tall image by matching width", () => {
    expect(fitCover(tall, { w: 400, h: 400 })).toEqual({ w: 400, h: 600 });
  });

  it("returns zero size for a degenerate intrinsic or box", () => {
    expect(fitCover(wide, { w: 0, h: 400 })).toEqual({ w: 0, h: 0 });
    expect(fitCover({ w: 100, h: 0 }, { w: 400, h: 400 })).toEqual({ w: 0, h: 0 });
  });
});

describe("clampSize — independent per-axis caps", () => {
  it("clamps each axis to its own maximum", () => {
    expect(clampSize(wide, { maxW: 600 })).toEqual({ w: 600, h: 800 });
    expect(clampSize(wide, { maxH: 400 })).toEqual({ w: 1200, h: 400 });
    expect(clampSize(wide, { maxW: 600, maxH: 400 })).toEqual({ w: 600, h: 400 });
  });

  it("leaves a size already within its bounds untouched", () => {
    expect(clampSize(wide, { maxW: 2000, maxH: 2000 })).toEqual(wide);
  });

  it("ignores non-positive or non-finite bounds", () => {
    expect(clampSize(wide, { maxW: 0 })).toEqual(wide);
    expect(clampSize(wide, { maxH: -5 })).toEqual(wide);
    expect(clampSize(wide, { maxW: Number.POSITIVE_INFINITY })).toEqual(wide);
  });
});

describe("aspectRatio — width divided by height", () => {
  it("computes the ratio of a wide source", () => {
    expect(aspectRatio(wide)).toBeCloseTo(1.5, 10);
  });

  it("is 1 for a square", () => {
    expect(aspectRatio({ w: 500, h: 500 })).toBe(1);
  });

  it("guards a zero or non-finite side", () => {
    expect(aspectRatio({ w: 100, h: 0 })).toBe(0);
    expect(aspectRatio({ w: 0, h: 100 })).toBe(0);
    expect(aspectRatio({ w: 100, h: Number.NaN })).toBe(0);
  });
});

describe("scalePercent — scale both axes by a percentage", () => {
  it("halves at 50% and grows at 150%", () => {
    expect(scalePercent(wide, 50)).toEqual({ w: 600, h: 400 });
    expect(scalePercent({ w: 1000, h: 333 }, 150)).toEqual({ w: 1500, h: 500 });
  });

  it("collapses to zero at 0%", () => {
    expect(scalePercent(wide, 0)).toEqual({ w: 0, h: 0 });
  });

  it("fails to zero on negative or non-finite percentages and degenerate sizes", () => {
    expect(scalePercent(wide, -25)).toEqual({ w: 0, h: 0 });
    expect(scalePercent(wide, Number.NaN)).toEqual({ w: 0, h: 0 });
    expect(scalePercent({ w: 0, h: 0 }, 50)).toEqual({ w: 0, h: 0 });
  });
});

describe("resizeByWidth — preserve the ratio for a target width", () => {
  it("derives the height from the intrinsic ratio", () => {
    expect(resizeByWidth(wide, 600)).toEqual({ w: 600, h: 400 });
    expect(resizeByWidth(wide, 300)).toEqual({ w: 300, h: 200 });
  });

  it("rounds a fractional derived height", () => {
    expect(resizeByWidth({ w: 1000, h: 333 }, 500)).toEqual({ w: 500, h: 167 });
  });

  it("returns zero size for a zero intrinsic width or a bad target", () => {
    expect(resizeByWidth({ w: 0, h: 100 }, 400)).toEqual({ w: 0, h: 0 });
    expect(resizeByWidth(wide, 0)).toEqual({ w: 0, h: 0 });
    expect(resizeByWidth(wide, Number.NaN)).toEqual({ w: 0, h: 0 });
  });
});

describe("percentToPx — percentage of a container, rounded", () => {
  it("resolves common percentages", () => {
    expect(percentToPx(50, 800)).toBe(400);
    expect(percentToPx(33, 100)).toBe(33);
    expect(percentToPx(12.5, 80)).toBe(10);
  });

  it("rounds to the nearest whole pixel", () => {
    expect(percentToPx(33.333, 100)).toBe(33);
    expect(percentToPx(66.666, 100)).toBe(67);
  });

  it("fails to zero on non-finite input", () => {
    expect(percentToPx(Number.NaN, 800)).toBe(0);
    expect(percentToPx(50, Number.NaN)).toBe(0);
    expect(percentToPx(50, Number.POSITIVE_INFINITY)).toBe(0);
  });
});
