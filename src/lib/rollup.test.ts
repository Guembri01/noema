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

  it("handles dates", () => {
    expect(aggregate(["2026-03-01", "2026-01-15"], "earliest")).toBe("2026-01-15");
    expect(aggregate(["2026-03-01", "2026-01-15"], "latest")).toBe("2026-03-01");
  });

  it("handles uniqueness and originals", () => {
    expect(aggregate(["a", "b", "a"], "unique")).toBe("2");
    expect(aggregate(["a", "b"], "show_original")).toBe("a, b");
  });

  it("returns a dash when there is nothing to aggregate", () => {
    expect(aggregate([], "sum")).toBe("—");
    expect(aggregate([], "earliest")).toBe("—");
  });

  it("exposes a function list", () => {
    expect(ROLLUP_FUNCTIONS.length).toBeGreaterThan(10);
  });
});
