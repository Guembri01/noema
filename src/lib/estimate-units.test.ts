import { describe, expect, it } from "vitest";
import {
  DEFAULT_ESTIMATE_CONVERSION,
  ESTIMATE_UNITS,
  convert,
  formatEstimate,
  isEstimateUnit,
  normalizeEstimates,
  sumEstimates,
} from "./estimate-units";

/**
 * Estimate units — pure conversion/counting helpers for ticket estimates.
 *
 * Written RED-first against a missing module, then implemented. Coverage pins:
 * - the unit set and the type guard (`points` | `hours` | `days`, nothing else),
 * - the default conversion table (1 day === 8 hours === 8 points) and overrides,
 * - `convert` round-tripping, fractional values, 2dp rounding, bad input → NaN,
 * - `sumEstimates` dominant-unit result (mode, deterministic tie-break, defaults),
 * - `normalizeEstimates` (single target unit, invalid entries dropped, no mutation),
 * - `formatEstimate` pluralisation, 2dp rounding and the `"—"` fallback.
 */

describe("ESTIMATE_UNITS / isEstimateUnit", () => {
  it("lists exactly points, hours and days", () => {
    expect(ESTIMATE_UNITS).toEqual(["points", "hours", "days"]);
  });

  it("accepts each known unit", () => {
    expect(isEstimateUnit("points")).toBe(true);
    expect(isEstimateUnit("hours")).toBe(true);
    expect(isEstimateUnit("days")).toBe(true);
  });

  it("rejects unknown units and non-strings", () => {
    expect(isEstimateUnit("story points")).toBe(false);
    expect(isEstimateUnit("")).toBe(false);
    expect(isEstimateUnit("Points")).toBe(false);
    expect(isEstimateUnit(null)).toBe(false);
    expect(isEstimateUnit(undefined)).toBe(false);
    expect(isEstimateUnit(8)).toBe(false);
    expect(isEstimateUnit({ unit: "points" })).toBe(false);
  });
});

describe("DEFAULT_ESTIMATE_CONVERSION", () => {
  it("treats 1 day as 8 hours and 8 points", () => {
    expect(DEFAULT_ESTIMATE_CONVERSION).toEqual({ points: 1, hours: 1, days: 8 });
  });
});

describe("convert", () => {
  it("returns the value unchanged for a same-unit conversion", () => {
    expect(convert(5, "points", "points")).toBe(5);
    expect(convert(2.5, "hours", "hours")).toBe(2.5);
  });

  it("converts days to hours (1 day = 8 hours)", () => {
    expect(convert(2, "days", "hours")).toBe(16);
    expect(convert(1.5, "days", "hours")).toBe(12);
  });

  it("converts hours to days", () => {
    expect(convert(16, "hours", "days")).toBe(2);
  });

  it("converts days to points (1 day = 8 points)", () => {
    expect(convert(3, "days", "points")).toBe(24);
  });

  it("converts points to hours (1 point = 1 hour)", () => {
    expect(convert(8, "points", "hours")).toBe(8);
  });

  it("rounds to two decimals", () => {
    expect(convert(1, "hours", "days")).toBe(0.13);
  });

  it("keeps the sign of negative values", () => {
    expect(convert(-16, "hours", "days")).toBe(-2);
    expect(convert(-1, "days", "points")).toBe(-8);
  });

  it("honours a custom conversion table", () => {
    expect(convert(1, "days", "hours", { days: 6 })).toBe(6);
    expect(convert(12, "hours", "days", { days: 6 })).toBe(2);
  });

  it("ignores a non-positive or non-finite override", () => {
    expect(convert(1, "days", "hours", { days: 0 })).toBe(8);
    expect(convert(1, "days", "hours", { days: Number.NaN })).toBe(8);
  });
});

describe("convert — guards", () => {
  it("returns NaN for an unknown from/to unit", () => {
    expect(Number.isNaN(convert(2, "fortnights" as never, "points"))).toBe(true);
    expect(Number.isNaN(convert(2, "points", "fortnights" as never))).toBe(true);
  });

  it("returns NaN for a non-finite value", () => {
    expect(Number.isNaN(convert(Number.NaN, "points", "days"))).toBe(true);
    expect(Number.isNaN(convert(Number.POSITIVE_INFINITY, "points", "days"))).toBe(true);
  });
});

describe("sumEstimates — dominant-unit result", () => {
  it("returns a points zero for an empty list", () => {
    expect(sumEstimates([])).toEqual({ total: 0, unit: "points", count: 0 });
  });

  it("sums items that already share a unit", () => {
    expect(
      sumEstimates([
        { estimate: 2, estimateUnit: "points" },
        { estimate: 3, estimateUnit: "points" },
      ]),
    ).toEqual({ total: 5, unit: "points", count: 2 });
  });

  it("converts every item into the dominant unit", () => {
    expect(
      sumEstimates([
        { estimate: 2, estimateUnit: "days" },
        { estimate: 4, estimateUnit: "days" },
        { estimate: 8, estimateUnit: "hours" },
      ]),
    ).toEqual({ total: 7, unit: "days", count: 3 });
  });

  it("breaks a dominant-unit tie by the canonical unit order", () => {
    // days/hours appear once each → hours wins (before days in ESTIMATE_UNITS).
    expect(
      sumEstimates([
        { estimate: 3, estimateUnit: "days" },
        { estimate: 16, estimateUnit: "hours" },
      ]),
    ).toEqual({ total: 40, unit: "hours", count: 2 });
  });

  it("rounds the converted total to two decimals", () => {
    expect(
      sumEstimates([
        { estimate: 1, estimateUnit: "hours" },
        { estimate: 1, estimateUnit: "days" },
        { estimate: 1, estimateUnit: "days" },
      ]),
    ).toEqual({ total: 2.13, unit: "days", count: 3 });
  });

  it("skips missing/non-finite estimates but still counts the items", () => {
    expect(
      sumEstimates([
        { estimate: null },
        { estimate: 2, estimateUnit: "points" },
        { estimate: Number.NaN, estimateUnit: "days" },
      ]),
    ).toEqual({ total: 2, unit: "points", count: 3 });
  });

  it("treats a missing or unknown unit as points", () => {
    expect(sumEstimates([{ estimate: 5 }])).toEqual({ total: 5, unit: "points", count: 1 });
    expect(
      sumEstimates([
        { estimate: 5, estimateUnit: "weird" },
        { estimate: 3, estimateUnit: "hours" },
      ]),
    ).toEqual({ total: 8, unit: "points", count: 2 });
  });
});

describe("normalizeEstimates", () => {
  it("converts every valid estimate to points by default", () => {
    expect(
      normalizeEstimates([
        { estimate: 3, estimateUnit: "days" },
        { estimate: 8, estimateUnit: "hours" },
      ]),
    ).toEqual([
      { estimate: 24, unit: "points" },
      { estimate: 8, unit: "points" },
    ]);
  });

  it("converts to an explicit target unit", () => {
    expect(
      normalizeEstimates(
        [
          { estimate: 16, estimateUnit: "hours" },
          { estimate: 1, estimateUnit: "days" },
        ],
        "days",
      ),
    ).toEqual([
      { estimate: 2, unit: "days" },
      { estimate: 1, unit: "days" },
    ]);
  });

  it("drops missing/non-finite estimates and defaults unknown units to points", () => {
    expect(
      normalizeEstimates([
        { estimate: null, estimateUnit: "points" },
        { estimate: Number.NaN, estimateUnit: "hours" },
        { estimate: 2, estimateUnit: "days" },
        { estimate: 5, estimateUnit: "weird" },
      ]),
    ).toEqual([
      { estimate: 16, unit: "points" },
      { estimate: 5, unit: "points" },
    ]);
  });

  it("returns a fresh array and never mutates its input", () => {
    const input = [{ estimate: 1, estimateUnit: "days" }];
    const result = normalizeEstimates(input);
    expect(result).toEqual([{ estimate: 8, unit: "points" }]);
    expect(result).not.toBe(input);
    expect(input).toEqual([{ estimate: 1, estimateUnit: "days" }]);
  });

  it("returns an empty array for an empty list", () => {
    expect(normalizeEstimates([])).toEqual([]);
  });
});

describe("formatEstimate", () => {
  it("pluralises points", () => {
    expect(formatEstimate(1, "points")).toBe("1 point");
    expect(formatEstimate(3, "points")).toBe("3 points");
    expect(formatEstimate(0, "points")).toBe("0 points");
  });

  it("pluralises hours and days", () => {
    expect(formatEstimate(1, "hours")).toBe("1 hour");
    expect(formatEstimate(2, "hours")).toBe("2 hours");
    expect(formatEstimate(1, "days")).toBe("1 day");
    expect(formatEstimate(1.5, "days")).toBe("1.5 days");
  });

  it("rounds to two decimals", () => {
    expect(formatEstimate(1.239, "points")).toBe("1.24 points");
  });

  it("treats an absolute value of one as singular", () => {
    expect(formatEstimate(-1, "days")).toBe("-1 day");
  });

  it("falls back to points for an unknown unit", () => {
    expect(formatEstimate(2, "story points")).toBe("2 points");
  });

  it("renders an em dash for missing/non-finite values", () => {
    expect(formatEstimate(null, "points")).toBe("—");
    expect(formatEstimate(undefined, "points")).toBe("—");
    expect(formatEstimate(Number.NaN, "points")).toBe("—");
    expect(formatEstimate(Number.POSITIVE_INFINITY, "days")).toBe("—");
  });
});
