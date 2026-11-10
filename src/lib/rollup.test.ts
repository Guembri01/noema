import { describe, expect, it } from "vitest";
import { ROLLUP_FUNCTIONS, aggregate } from "@/lib/rollup";

describe("rollup aggregation", () => {
  const nums = [1, 2, 3, 4];

  it("counts including empty", () => {
    expect(aggregate(nums, "count")).toBe("4");
    expect(aggregate([1, null, "", 2], "count")).toBe("2");
    expect(aggregate([1, null, "", 2], "count_empty")).toBe("2");
  });

  it("computes numeric aggregates", () => {
    expect(aggregate(nums, "sum")).toBe("10");
    expect(aggregate(nums, "avg")).toBe("2.50");
    expect(aggregate(nums, "min")).toBe("1");
    expect(aggregate(nums, "max")).toBe("4");
    expect(aggregate(nums, "median")).toBe("2.50");
    expect(aggregate(nums, "range")).toBe("3");
  });

  it("handles booleans", () => {
    expect(aggregate([true, false, true], "checked")).toBe("2");
    expect(aggregate([true, false, true, true], "percent_checked")).toBe("75%");
  });

  it("computes percent empty over every slot, including empty ones", () => {
    expect(aggregate([], "percent_empty")).toBe("—");
    expect(aggregate([1, null, ""], "percent_empty")).toBe("67%");
    expect(aggregate(["a", "b", "c"], "percent_empty")).toBe("0%");
  });

  it("handles dates", () => {
    expect(aggregate(["2026-03-01", "2026-01-15"], "earliest")).toBe("2026-01-15");
    expect(aggregate(["2026-03-01", "2026-01-15"], "latest")).toBe("2026-03-01");
  });

  it("handles uniqueness and originals", () => {
    expect(aggregate(["a", "b", "a"], "unique")).toBe("2");
    expect(aggregate(["a", "b"], "show_original")).toBe("a, b");
    expect(aggregate(["a", "b"], "show_original", { separator: " · " })).toBe(
      "a · b",
    );
  });

  it("returns a dash when there is nothing to aggregate", () => {
    expect(aggregate([], "sum")).toBe("—");
    expect(aggregate([], "earliest")).toBe("—");
  });

  it("exposes a function list", () => {
    expect(ROLLUP_FUNCTIONS.length).toBeGreaterThan(10);
  });

  it("exposes exactly the 15 rollup functions with unique ids", () => {
    expect(ROLLUP_FUNCTIONS.map((fn) => fn.id)).toEqual([
      "count",
      "count_empty",
      "sum",
      "avg",
      "min",
      "max",
      "median",
      "range",
      "earliest",
      "latest",
      "checked",
      "percent_checked",
      "percent_empty",
      "unique",
      "show_original",
    ]);
    expect(new Set(ROLLUP_FUNCTIONS.map((fn) => fn.id)).size).toBe(15);
  });

  it("returns a safe sentinel for every function over an empty group", () => {
    for (const fn of ROLLUP_FUNCTIONS) {
      const result = aggregate([], fn.id);
      expect(result.length).toBeGreaterThan(0);
      expect(result).not.toMatch(/NaN|undefined|null/i);
    }
    expect(aggregate([], "count")).toBe("0");
    expect(aggregate([], "count_empty")).toBe("0");
    expect(aggregate([], "checked")).toBe("0");
    expect(aggregate([], "percent_checked")).toBe("0%");
    expect(aggregate([], "unique")).toBe("0");
    expect(aggregate([], "show_original")).toBe("—");
    expect(aggregate([], "sum")).toBe("—");
    expect(aggregate([], "earliest")).toBe("—");
    expect(aggregate([], "latest")).toBe("—");
  });

  it("aggregates a single-row group with every function", () => {
    expect(aggregate([7], "count")).toBe("1");
    expect(aggregate([7], "count_empty")).toBe("0");
    expect(aggregate([7], "sum")).toBe("7");
    expect(aggregate([7], "avg")).toBe("7");
    expect(aggregate([7], "min")).toBe("7");
    expect(aggregate([7], "max")).toBe("7");
    expect(aggregate([7], "median")).toBe("7");
    expect(aggregate([7], "range")).toBe("0");
    expect(aggregate([7], "checked")).toBe("0");
    expect(aggregate([7], "percent_checked")).toBe("0%");
    expect(aggregate([7], "unique")).toBe("1");
    expect(aggregate([7], "show_original")).toBe("7");
    expect(aggregate(["2026-02-15"], "earliest")).toBe("2026-02-15");
    expect(aggregate(["2026-02-15"], "latest")).toBe("2026-02-15");
  });

  it("returns safe sentinels for a null-heavy group with every function", () => {
    const nullHeavy = [null, undefined, "", "   ", null];
    expect(aggregate(nullHeavy, "count")).toBe("0");
    expect(aggregate(nullHeavy, "count_empty")).toBe("5");
    expect(aggregate(nullHeavy, "sum")).toBe("—");
    expect(aggregate(nullHeavy, "avg")).toBe("—");
    expect(aggregate(nullHeavy, "min")).toBe("—");
    expect(aggregate(nullHeavy, "max")).toBe("—");
    expect(aggregate(nullHeavy, "median")).toBe("—");
    expect(aggregate(nullHeavy, "range")).toBe("—");
    expect(aggregate(nullHeavy, "earliest")).toBe("—");
    expect(aggregate(nullHeavy, "latest")).toBe("—");
    expect(aggregate(nullHeavy, "checked")).toBe("0");
    expect(aggregate(nullHeavy, "percent_checked")).toBe("0%");
    expect(aggregate(nullHeavy, "unique")).toBe("0");
    expect(aggregate(nullHeavy, "show_original")).toBe("—");
    for (const fn of ROLLUP_FUNCTIONS) {
      expect(aggregate(nullHeavy, fn.id)).not.toMatch(/NaN/i);
    }
  });

  it("keeps percent and average NaN-free on empty or non-numeric data", () => {
    expect(aggregate([], "avg")).toBe("—");
    expect(aggregate([], "percent_checked")).toBe("0%");
    expect(aggregate(["", null], "avg")).toBe("—");
    expect(aggregate(["", null], "percent_checked")).toBe("0%");
    expect(aggregate(["abc", "xyz"], "avg")).toBe("—");
    expect(aggregate(["12", "abc"], "avg")).toBe("12"); // agrees with the footer: "abc" excluded
    expect(aggregate(["12", "abc"], "sum")).toBe("12");
    expect(aggregate(["12", "abc"], "median")).toBe("12");
    expect(aggregate([true, false], "avg")).toBe("0.50");
    expect(aggregate([true, true, false], "percent_checked")).toBe("67%");
    expect(aggregate([true], "percent_checked")).toBe("100%");
    expect(aggregate([false], "percent_checked")).toBe("0%");
    for (const input of [[], [null], ["abc"], [true, false], [1, "x", null]]) {
      for (const fn of ROLLUP_FUNCTIONS) {
        expect(aggregate(input, fn.id)).not.toMatch(/NaN/i);
      }
    }
  });

  it("distinguishes count (present values) from count_empty (empty slots)", () => {
    const values = [1, null, "", 2, undefined, " "];
    expect(aggregate(values, "count")).toBe("2");
    expect(aggregate(values, "count_empty")).toBe("4");
    expect(
      Number(aggregate(values, "count")) + Number(aggregate(values, "count_empty")),
    ).toBe(values.length);
  });

  it("ignores unparseable dates in earliest and latest", () => {
    expect(aggregate(["2026-03-01", "not-a-date"], "earliest")).toBe("2026-03-01");
    expect(aggregate(["2026-03-01", "not-a-date"], "latest")).toBe("2026-03-01");
    expect(aggregate(["garbage"], "earliest")).toBe("—");
    expect(aggregate(["garbage"], "latest")).toBe("—");
  });
});
