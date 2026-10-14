import { describe, expect, it } from "vitest";
import {
  DEFAULT_COVER_POSITION,
  formatObjectPosition,
  normalizeCoverPosition,
  nudgePosition,
  parseCoverPosition,
} from "./cover-position";

/**
 * B-cover-position — Cover reposition
 * (docs/MISSING_FEATURES.md §1 "Editor & blocks", row "Cover reposition").
 *
 * Written RED-first against a missing module, then implemented. Coverage pins:
 * - tolerant parsing: object / array / "x% y%" string / bare junk,
 * - clamping to the 0..100 focal-point range,
 * - per-component defaulting to 50/50 (one bad axis never zeroes the other),
 * - NaN / Infinity / null / non-numeric handled without throwing,
 * - drag-delta math via nudgePosition (edge clamping, non-finite deltas),
 * - pure helpers: inputs are never mutated.
 */

describe("DEFAULT_COVER_POSITION", () => {
  it("centres the focal point at 50/50", () => {
    expect(DEFAULT_COVER_POSITION).toEqual({ x: 50, y: 50 });
  });
});

describe("parseCoverPosition — tolerant focal-point parsing", () => {
  it("returns the default for undefined and null", () => {
    expect(parseCoverPosition(undefined)).toEqual({ x: 50, y: 50 });
    expect(parseCoverPosition(null)).toEqual({ x: 50, y: 50 });
  });

  it("returns a fresh object (never the shared constant)", () => {
    const parsed = parseCoverPosition("garbage");
    expect(parsed).not.toBe(DEFAULT_COVER_POSITION);
  });

  it("reads a { x, y } object", () => {
    expect(parseCoverPosition({ x: 30, y: 70 })).toEqual({ x: 30, y: 70 });
  });

  it("reads numeric strings and percent signs inside an object", () => {
    expect(parseCoverPosition({ x: "30%", y: " 70 " })).toEqual({ x: 30, y: 70 });
  });

  it("reads a two-element array", () => {
    expect(parseCoverPosition([10, 90])).toEqual({ x: 10, y: 90 });
  });

  it("reads an 'x% y%' string with either space or comma separators", () => {
    expect(parseCoverPosition("25% 75%")).toEqual({ x: 25, y: 75 });
    expect(parseCoverPosition(" 40% , 60% ")).toEqual({ x: 40, y: 60 });
  });

  it("defaults the missing axis of a single-value string", () => {
    expect(parseCoverPosition("25%")).toEqual({ x: 25, y: 50 });
  });

  it("clamps an out-of-range object instead of rejecting it", () => {
    expect(parseCoverPosition({ x: 150, y: -20 })).toEqual({ x: 100, y: 0 });
  });

  it("defaults a bad axis while keeping the good one", () => {
    expect(parseCoverPosition({ x: 30 })).toEqual({ x: 30, y: 50 });
    expect(parseCoverPosition({ x: Number.NaN, y: 80 })).toEqual({ x: 50, y: 80 });
    expect(parseCoverPosition({ x: "abc", y: 20 })).toEqual({ x: 50, y: 20 });
  });

  it("treats a non-finite axis as absent", () => {
    expect(parseCoverPosition("Infinity 20")).toEqual({ x: 50, y: 20 });
  });
});

describe("normalizeCoverPosition", () => {
  it("clamps both axes into 0..100", () => {
    expect(normalizeCoverPosition({ x: 120, y: 120 })).toEqual({ x: 100, y: 100 });
    expect(normalizeCoverPosition({ x: -5, y: 200 })).toEqual({ x: 0, y: 100 });
  });

  it("returns a new object and does not mutate its input", () => {
    const input = { x: 200, y: -3 };
    const normalized = normalizeCoverPosition(input);
    expect(normalized).toEqual({ x: 100, y: 0 });
    expect(input).toEqual({ x: 200, y: -3 });
  });
});

describe("formatObjectPosition — CSS object-position / background-position", () => {
  it("renders an 'x% y%' pair", () => {
    expect(formatObjectPosition({ x: 50, y: 40 })).toBe("50% 40%");
  });

  it("normalizes an out-of-range position before formatting", () => {
    expect(formatObjectPosition({ x: 150, y: -10 })).toBe("100% 0%");
    expect(formatObjectPosition({ x: 0, y: 100 })).toBe("0% 100%");
  });
});

describe("nudgePosition — drag-delta math", () => {
  it("adds the delta to both axes", () => {
    expect(nudgePosition({ x: 50, y: 50 }, 10, -20)).toEqual({ x: 60, y: 30 });
  });

  it("clamps to the 0..100 edges", () => {
    expect(nudgePosition({ x: 95, y: 5 }, 10, -10)).toEqual({ x: 100, y: 0 });
    expect(nudgePosition({ x: 50, y: 50 }, -100, 100)).toEqual({ x: 0, y: 100 });
  });

  it("ignores non-finite deltas (keeps the other axis)", () => {
    expect(nudgePosition({ x: 40, y: 60 }, Number.NaN, 5)).toEqual({ x: 40, y: 65 });
    expect(nudgePosition({ x: 40, y: 60 }, 5, Number.POSITIVE_INFINITY)).toEqual({
      x: 45,
      y: 60,
    });
  });

  it("supports fractional drag deltas", () => {
    expect(nudgePosition({ x: 50, y: 50 }, 0.5, 0.25)).toEqual({ x: 50.5, y: 50.25 });
  });

  it("normalizes a garbage base and does not mutate it", () => {
    const input = { x: 200, y: 0 };
    const nudged = nudgePosition(input, -10, 10);
    expect(nudged).toEqual({ x: 90, y: 10 });
    expect(input).toEqual({ x: 200, y: 0 });
  });
});
