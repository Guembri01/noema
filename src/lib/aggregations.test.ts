import { describe, expect, it } from "vitest";
import {
  AGGREGATION_FUNCTIONS,
  AGGREGATION_TO_ROLLUP,
  EMPTY_GROUP_LABEL,
  aggregate,
  aggregateGroups,
  groupRows,
  propertyValueOf,
  toAggregationValue,
  type AggregationFn,
} from "@/lib/aggregations";

type Task = { id: string; status?: string | null; estimate?: number | null };
type CellRow = {
  id: string;
  propertyValues: { propertyId: string; value: unknown }[];
};

describe("toAggregationValue (property value normalization)", () => {
  it("passes primitives through", () => {
    expect(toAggregationValue(42)).toBe(42);
    expect(toAggregationValue(-1.5)).toBe(-1.5);
    expect(toAggregationValue(true)).toBe(true);
    expect(toAggregationValue(false)).toBe(false);
    expect(toAggregationValue("hi")).toBe("hi");
  });

  it("unwraps the database property value shapes", () => {
    expect(toAggregationValue({ number: 3 })).toBe(3);
    expect(toAggregationValue({ text: "hello" })).toBe("hello");
    expect(toAggregationValue({ checked: true })).toBe(true);
    expect(toAggregationValue({ optionId: "opt-1" })).toBe("opt-1");
    expect(toAggregationValue({ start: "2026-01-01" })).toBe("2026-01-01");
    expect(toAggregationValue({ optionIds: ["a", "b"] })).toBe("a, b");
    expect(toAggregationValue({ names: ["Ann", "Bo"] })).toBe("Ann, Bo");
    expect(toAggregationValue({ pageIds: ["p1", "p2"] })).toBe("p1, p2");
  });

  it("normalizes missing and unknown values to null without throwing", () => {
    expect(toAggregationValue(null)).toBeNull();
    expect(toAggregationValue(undefined)).toBeNull();
    expect(toAggregationValue({})).toBeNull();
    expect(toAggregationValue({ text: "" })).toBe("");
    expect(toAggregationValue({ optionIds: [] })).toBeNull();
    expect(toAggregationValue({ files: [{ name: "a.png", url: "/x" }] })).toBeNull();
    expect(toAggregationValue(Number.NaN)).toBeNull();
    expect(toAggregationValue(Number.POSITIVE_INFINITY)).toBeNull();
    expect(toAggregationValue(4 as unknown)).toBe(4); // sanity: unknown stays usable
    expect(() => toAggregationValue(Symbol("s"))).not.toThrow();
  });
});

describe("aggregate — counting", () => {
  it("counts every cell for count and only non-empty for countValues", () => {
    const values = [1, null, "", { text: "x" }];
    expect(aggregate(values, "count")).toEqual({ value: 4, display: "4" });
    expect(aggregate(values, "countValues")).toEqual({ value: 2, display: "2" });
    expect(aggregate(values, "countEmpty")).toEqual({ value: 2, display: "2" });
  });

  it("returns zeroes for an empty input", () => {
    expect(aggregate([], "count")).toEqual({ value: 0, display: "0" });
    expect(aggregate([], "countValues")).toEqual({ value: 0, display: "0" });
    expect(aggregate([], "countEmpty")).toEqual({ value: 0, display: "0" });
  });

  it("treats blank/unknown property values as empty", () => {
    const allEmpty = [null, "", "   ", {}, { text: "" }, { optionIds: [] }];
    expect(aggregate(allEmpty, "countEmpty").value).toBe(6);
    expect(aggregate(allEmpty, "countValues").value).toBe(0);
    expect(aggregate(allEmpty, "percentEmpty")).toEqual({ value: 1, display: "100%" });
    expect(aggregate(allEmpty, "sum")).toEqual({ value: null, display: "—" });
  });
});

describe("aggregate — numeric functions", () => {
  it("sums numbers", () => {
    expect(aggregate([1, 2, 3, 4], "sum")).toEqual({ value: 10, display: "10" });
    expect(aggregate([{ number: 1 }, { number: 2 }, { number: 3 }], "sum").value).toBe(6);
  });

  it("handles negatives and decimals", () => {
    const values = [-1.5, 2.5, { number: 3 }];
    expect(aggregate(values, "sum")).toEqual({ value: 4, display: "4" });
    expect(aggregate(values, "min")).toEqual({ value: -1.5, display: "-1.50" });
    expect(aggregate(values, "max")).toEqual({ value: 3, display: "3" });
    expect(aggregate(values, "average").value).toBeCloseTo(4 / 3);
  });

  it("computes average, median (odd and even) and range", () => {
    expect(aggregate([1, 2], "average")).toEqual({ value: 1.5, display: "1.50" });
    expect(aggregate([3, 1, 2], "median")).toEqual({ value: 2, display: "2" });
    expect(aggregate([1, 2, 3, 4], "median")).toEqual({ value: 2.5, display: "2.50" });
    expect(aggregate([1, 4, 2], "range")).toEqual({ value: 3, display: "1–4" });
  });

  it("handles a single value", () => {
    expect(aggregate([5], "sum")).toEqual({ value: 5, display: "5" });
    expect(aggregate([5], "min")).toEqual({ value: 5, display: "5" });
    expect(aggregate([5], "max")).toEqual({ value: 5, display: "5" });
    expect(aggregate([5], "median")).toEqual({ value: 5, display: "5" });
    expect(aggregate([5], "range")).toEqual({ value: 0, display: "5–5" });
  });

  it("returns null / dash for empty and all-empty input", () => {
    for (const fn of ["sum", "average", "min", "max", "median", "range"] as const) {
      expect(aggregate([], fn)).toEqual({ value: null, display: "—" });
      expect(aggregate([null, "", undefined], fn)).toEqual({ value: null, display: "—" });
    }
  });

  it("is safe with mixed types: non-numeric strings and non-finite numbers are excluded", () => {
    const values = ["2", { number: 3 }, true, false, "abc"];
    expect(aggregate(values, "sum")).toEqual({ value: 6, display: "6" });
    expect(aggregate([1, Number.NaN, Number.POSITIVE_INFINITY, 2], "sum").value).toBe(3);
  });

  it("coerces numeric-looking strings (currency noise stripped)", () => {
    expect(aggregate([{ text: "$1,200" }, { text: "800" }], "sum").value).toBe(2000);
    expect(aggregate(["-1.5", "0.5"], "sum").value).toBe(-1);
  });

  it("fails safe on an unknown function instead of throwing", () => {
    expect(aggregate([1, 2], "bogus" as AggregationFn)).toEqual({ value: null, display: "—" });
  });
});

describe("aggregate — percent functions", () => {
  it("computes percentChecked over boolean cells only", () => {
    expect(aggregate([true, false, true, true], "percentChecked")).toEqual({
      value: 0.75,
      display: "75%",
    });
    expect(aggregate([true, "yes", 1, { checked: false }], "percentChecked").value).toBe(0.5);
  });

  it("computes percentEmpty as empty over total cells", () => {
    expect(aggregate([1, null, "", 2], "percentEmpty")).toEqual({ value: 0.5, display: "50%" });
    expect(aggregate([null, ""], "percentEmpty")).toEqual({ value: 1, display: "100%" });
  });

  it("returns 0% for empty input and no boolean cells", () => {
    expect(aggregate([], "percentEmpty")).toEqual({ value: 0, display: "0%" });
    expect(aggregate([], "percentChecked")).toEqual({ value: 0, display: "0%" });
    expect(aggregate(["a", "b"], "percentChecked")).toEqual({ value: 0, display: "0%" });
  });

  it("kills float noise in the display (maximumFractionDigits)", () => {
    const noisy = [...Array(93).fill(1), ...Array(7).fill(null)];
    expect(aggregate(noisy, "percentEmpty").value).toBeCloseTo(0.07);
    expect(aggregate(noisy, "percentEmpty").display).toBe("7%");
    expect(aggregate([true, false, false], "percentChecked").display).toBe("33.33%");
  });
});

describe("aggregate — showAs formatting hints", () => {
  it("formats plain numbers (default and explicit)", () => {
    expect(aggregate([1, 2], "average").display).toBe("1.50");
    expect(aggregate([1, 2], "average", { showAs: "number" }).display).toBe("1.50");
  });

  it("formats percent columns where the stored value is a fraction", () => {
    const result = aggregate([{ number: 0.075 }], "average", { showAs: "percent" });
    expect(result.value).toBe(0.075);
    expect(result.display).toBe("7.5%");
  });

  it("formats currency with the USD default", () => {
    const result = aggregate([{ number: 12.5 }], "sum", { showAs: "currency" });
    expect(result.value).toBe(12.5);
    expect(result.display).toBe("$12.50");
  });

  it("accepts an ISO currency code like the NUMBER property config", () => {
    expect(aggregate([12.5], "sum", { showAs: "currency", currency: "EUR" }).display).toBe("€12.50");
  });

  it("accepts a literal currency symbol and thousands separators", () => {
    expect(aggregate([1250], "sum", { showAs: "currency", currency: "¥" }).display).toBe("¥1,250");
  });

  it("never throws on an invalid currency code", () => {
    const result = aggregate([12.5], "sum", { showAs: "currency", currency: "XYZ" });
    expect(result.display).toContain("12.50");
  });
});

describe("aggregate — function metadata", () => {
  it("exposes 11 unique footer functions", () => {
    const ids = AGGREGATION_FUNCTIONS.map((entry) => entry.id);
    expect(ids).toHaveLength(11);
    expect(new Set(ids).size).toBe(11);
    expect(ids).toEqual(
      expect.arrayContaining([
        "count",
        "countValues",
        "countEmpty",
        "sum",
        "average",
        "min",
        "max",
        "median",
        "range",
        "percentEmpty",
        "percentChecked",
      ]),
    );
    for (const entry of AGGREGATION_FUNCTIONS) {
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it("crosswalks to the rollup vocabulary, leaving ambiguous ids unmapped", () => {
    expect(AGGREGATION_TO_ROLLUP.countValues).toBe("count");
    expect(AGGREGATION_TO_ROLLUP.countEmpty).toBe("count_empty");
    expect(AGGREGATION_TO_ROLLUP.sum).toBe("sum");
    expect(AGGREGATION_TO_ROLLUP.average).toBe("avg");
    expect(AGGREGATION_TO_ROLLUP.median).toBe("median");
    expect(AGGREGATION_TO_ROLLUP.range).toBe("range");
    expect(AGGREGATION_TO_ROLLUP.percentChecked).toBe("percent_checked");
    // "count"/"percentEmpty" mean different things on each side — no mapping.
    expect(AGGREGATION_TO_ROLLUP.count).toBeUndefined();
    expect(AGGREGATION_TO_ROLLUP.percentEmpty).toBeUndefined();
  });
});

describe("groupRows", () => {
  it("buckets rows by a key fn in first-appearance order", () => {
    const tasks: Task[] = [
      { id: "1", status: "todo" },
      { id: "2", status: "done" },
      { id: "3", status: "todo" },
    ];
    const groups = groupRows(tasks, (task) => task.status);
    expect(groups.map((group) => group.key)).toEqual(["todo", "done"]);
    expect(groups[0].rows.map((row) => row.id)).toEqual(["1", "3"]);
    expect(groups[1].rows.map((row) => row.id)).toEqual(["2"]);
  });

  it("returns no groups for no rows", () => {
    expect(groupRows([], () => "x")).toEqual([]);
  });

  it("collects missing values into a labelled empty group", () => {
    const tasks: Task[] = [
      { id: "1", status: "todo" },
      { id: "2", status: null },
      { id: "3" },
    ];
    const groups = groupRows(tasks, (task) => task.status);
    expect(groups.map((group) => group.key)).toEqual(["todo", ""]);
    const empty = groups[1];
    expect(empty.label).toBe(EMPTY_GROUP_LABEL);
    expect(empty.rows.map((row) => row.id)).toEqual(["2", "3"]);
  });

  it("normalizes mixed-type keys so equivalent values merge", () => {
    const rows = [{ v: { number: 1 } }, { v: 1 }, { v: "1" }, { v: { text: "1" } }];
    const groups = groupRows(rows, (row) => row.v);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("1");
    expect(groups[0].rows).toHaveLength(4);
  });

  it("separates boolean keys", () => {
    const groups = groupRows([{ v: true }, { v: false }], (row) => row.v);
    expect(groups.map((group) => group.key)).toEqual(["true", "false"]);
  });

  it("buckets DBRow-shaped rows by a property value", () => {
    const rows: CellRow[] = [
      {
        id: "a",
        propertyValues: [
          { propertyId: "status", value: { optionId: "opt-todo" } },
          { propertyId: "est", value: { number: 4 } },
        ],
      },
      { id: "b", propertyValues: [{ propertyId: "est", value: { number: 6 } }] },
    ];
    const groups = groupRows(rows, (row) => propertyValueOf(row, "status"));
    expect(groups.map((group) => group.key)).toEqual(["opt-todo", ""]);
    expect(propertyValueOf(rows[0], "est")).toEqual({ number: 4 });
    expect(propertyValueOf(rows[1], "missing")).toBeNull();
  });
});

describe("aggregateGroups", () => {
  const tasks: Task[] = [
    { id: "1", status: "todo", estimate: 3 },
    { id: "2", status: "done", estimate: 5 },
    { id: "3", status: "todo", estimate: 2 },
    { id: "4", status: null, estimate: 1 },
  ];

  it("applies a per-group aggregation spec (sum of estimates per status)", () => {
    const groups = groupRows(tasks, (task) => task.status);
    const result = aggregateGroups(groups, {
      total: { fn: "sum", value: (task) => task.estimate },
    });
    expect(result.map((group) => group.key)).toEqual(["todo", "done", ""]);
    expect(result[0].aggregates.total).toEqual({ value: 5, display: "5" });
    expect(result[1].aggregates.total).toEqual({ value: 5, display: "5" });
    expect(result[2].aggregates.total).toEqual({ value: 1, display: "1" });
  });

  it("supports several specs, counting rows when no value fn is given", () => {
    const groups = groupRows(tasks, (task) => task.status);
    const result = aggregateGroups(groups, {
      size: { fn: "count" },
      avg: { fn: "average", value: (task) => task.estimate },
    });
    expect(result[0].aggregates.size.value).toBe(2);
    expect(result[0].aggregates.avg).toEqual({ value: 2.5, display: "2.50" });
  });

  it("preserves group order, labels and rows", () => {
    const groups = groupRows(tasks, (task) => task.status);
    const result = aggregateGroups(groups, { size: { fn: "count" } });
    expect(result.map((group) => group.key)).toEqual(groups.map((group) => group.key));
    expect(result[0].label).toBe(groups[0].label);
    expect(result[0].rows).toBe(groups[0].rows);
  });

  it("handles hand-built empty groups safely", () => {
    const result = aggregateGroups<Task>([{ key: "x", label: "X", rows: [] }], {
      total: { fn: "sum", value: (task) => task.estimate },
      size: { fn: "count" },
    });
    expect(result[0].aggregates.total).toEqual({ value: null, display: "—" });
    expect(result[0].aggregates.size).toEqual({ value: 0, display: "0" });
  });

  it("is safe with missing and mixed-typed group values", () => {
    const rows = [
      { id: "1", estimate: null },
      { id: "2", estimate: "2" },
      { id: "3", estimate: { number: 3 } },
      { id: "4", estimate: "n/a" },
    ];
    const result = aggregateGroups([{ key: "g", label: "g", rows }], {
      total: { fn: "sum", value: (row) => row.estimate },
    });
    expect(result[0].aggregates.total).toEqual({ value: 5, display: "5" });
    const allMissing = aggregateGroups([{ key: "g", label: "g", rows: [{ id: "1", estimate: null }] }], {
      total: { fn: "sum", value: (row) => row.estimate },
    });
    expect(allMissing[0].aggregates.total).toEqual({ value: null, display: "—" });
  });

  it("passes formatting options through to every group", () => {
    const groups = groupRows(tasks, (task) => task.status);
    const result = aggregateGroups(groups, {
      total: { fn: "sum", value: (task) => task.estimate, options: { showAs: "currency" } },
    });
    expect(result[0].aggregates.total.display).toBe("$5.00");
  });

  it("returns an empty list for no groups", () => {
    expect(aggregateGroups([], { size: { fn: "count" } })).toEqual([]);
  });
});
