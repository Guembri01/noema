import { describe, expect, it } from "vitest";
import { EMPTY_GROUP_LABEL, type AggregationFn } from "@/lib/aggregations";
import {
  ALL_ROWS_LABEL,
  OTHER_SLICE_LABEL,
  buildChartSeries,
  type ChartConfig,
  type ChartProperty,
} from "@/lib/charts";

type Row = { id: string; propertyValues: { propertyId: string; value: unknown }[] };

/** Build a DBRow-shaped fixture from a cell map (insertion order preserved). */
const row = (id: string, cells: Record<string, unknown>): Row => ({
  id,
  propertyValues: Object.entries(cells).map(([propertyId, value]) => ({ propertyId, value })),
});

const PROPS: ChartProperty[] = [
  {
    id: "status",
    name: "Status",
    config: {
      options: [
        { id: "opt-todo", name: "Todo" },
        { id: "opt-done", name: "Done" },
        { id: "opt-doing", name: "Doing" },
        { id: "opt-backlog", name: "Backlog" },
      ],
    },
  },
  { id: "estimate", name: "Estimate", config: null },
  { id: "title", name: "Title", config: null },
];

/** First-appearance order of statuses: Todo, Done, Doing, Backlog. Sums: 7, 3, 1, 4. */
const ROWS: Row[] = [
  row("r1", { status: { optionId: "opt-todo" }, estimate: { number: 2 } }),
  row("r2", { status: { optionId: "opt-done" }, estimate: { number: 3 } }),
  row("r3", { status: { optionId: "opt-todo" }, estimate: { number: 5 } }),
  row("r4", { status: { optionId: "opt-doing" }, estimate: { number: 1 } }),
  row("r5", { status: { optionId: "opt-backlog" }, estimate: { number: 4 } }),
];

const BAR_BY_STATUS: ChartConfig & { type: "bar" } = {
  type: "bar",
  groupByPropertyId: "status",
  valuePropertyId: "estimate",
  aggregateFn: "sum",
};

const PIE_BY_STATUS: ChartConfig & { type: "pie" } = {
  type: "pie",
  groupByPropertyId: "status",
  valuePropertyId: "estimate",
  aggregateFn: "sum",
};

describe("buildChartSeries — bar grouped series", () => {
  it("aggregates each group into one category, first-appearance order, option names resolved", () => {
    const out = buildChartSeries(ROWS, BAR_BY_STATUS, PROPS);
    expect(out).toEqual({
      categories: ["Todo", "Done", "Doing", "Backlog"],
      series: [{ name: "Estimate", values: [7, 3, 1, 4] }],
    });
  });

  it("counts rows per group when no value property is configured", () => {
    const out = buildChartSeries(
      ROWS,
      { type: "bar", groupByPropertyId: "status", aggregateFn: "count" },
      PROPS,
    );
    expect(out.series[0]).toEqual({ name: "Count all", values: [2, 1, 1, 1] });
    expect(out.categories).toEqual(["Todo", "Done", "Doing", "Backlog"]);
  });

  it("keeps only numeric cells in numeric aggregations (reuses the aggregations numeric filter)", () => {
    const rows = [
      row("a", { status: { optionId: "opt-todo" }, estimate: { text: "abc" } }),
      row("b", { status: { optionId: "opt-todo" }, estimate: { number: 4 } }),
      row("c", { status: { optionId: "opt-done" }, estimate: { text: "abc" } }),
    ];
    const out = buildChartSeries(rows, BAR_BY_STATUS, PROPS);
    expect(out).toEqual({
      categories: ["Todo", "Done"],
      series: [{ name: "Estimate", values: [4, null] }],
    });
  });

  it("fails safe on an unknown aggregation id without throwing", () => {
    const out = buildChartSeries(ROWS, { ...BAR_BY_STATUS, aggregateFn: "bogus" as AggregationFn }, PROPS);
    expect(out.series[0]).toEqual({ name: "Estimate", values: [null, null, null, null] });
  });
});

describe("buildChartSeries — line series", () => {
  it("builds averages per group as a single series", () => {
    const out = buildChartSeries(
      ROWS,
      { type: "line", groupByPropertyId: "status", valuePropertyId: "estimate", aggregateFn: "average" },
      PROPS,
    );
    expect(out.categories).toEqual(["Todo", "Done", "Doing", "Backlog"]);
    expect(out.series).toEqual([{ name: "Estimate", values: [3.5, 3, 1, 4] }]);
  });
});

describe("buildChartSeries — pie and donut slices", () => {
  it("turns summed groups into pie slices in first-appearance order", () => {
    const out = buildChartSeries(ROWS, PIE_BY_STATUS, PROPS);
    expect(out).toEqual({
      slices: [
        { label: "Todo", value: 7 },
        { label: "Done", value: 3 },
        { label: "Doing", value: 1 },
        { label: "Backlog", value: 4 },
      ],
    });
  });

  it("counts rows per group for a donut", () => {
    const out = buildChartSeries(
      ROWS,
      { type: "donut", groupByPropertyId: "status", aggregateFn: "count" },
      PROPS,
    );
    expect(out.slices).toEqual([
      { label: "Todo", value: 2 },
      { label: "Done", value: 1 },
      { label: "Doing", value: 1 },
      { label: "Backlog", value: 1 },
    ]);
  });

  it("omits groups whose aggregate has no numeric value", () => {
    const rows = [
      row("a", { status: { optionId: "opt-todo" }, estimate: { number: 4 } }),
      row("c", { status: { optionId: "opt-done" }, estimate: { text: "abc" } }),
    ];
    const out = buildChartSeries(rows, PIE_BY_STATUS, PROPS);
    expect(out).toEqual({ slices: [{ label: "Todo", value: 4 }] });
  });
});

describe("buildChartSeries — no group-by", () => {
  it("aggregates all rows into a single category for bar", () => {
    const out = buildChartSeries(
      ROWS,
      { type: "bar", valuePropertyId: "estimate", aggregateFn: "sum" },
      PROPS,
    );
    expect(out).toEqual({
      categories: [ALL_ROWS_LABEL],
      series: [{ name: "Estimate", values: [15] }],
    });
  });

  it("aggregates all rows into a single slice for pie", () => {
    const out = buildChartSeries(ROWS, { type: "pie", aggregateFn: "count" }, PROPS);
    expect(out).toEqual({ slices: [{ label: ALL_ROWS_LABEL, value: 5 }] });
  });
});

describe("buildChartSeries — empty rows", () => {
  const none: Row[] = [];

  it("returns an empty bar/line series without throwing", () => {
    expect(buildChartSeries(none, BAR_BY_STATUS, PROPS)).toEqual({ categories: [], series: [] });
    expect(buildChartSeries(none, { type: "line", aggregateFn: "count" }, PROPS)).toEqual({
      categories: [],
      series: [],
    });
  });

  it("returns empty pie slices without throwing", () => {
    expect(buildChartSeries(none, PIE_BY_STATUS, PROPS)).toEqual({ slices: [] });
    expect(buildChartSeries(none, { type: "donut", aggregateFn: "count" }, PROPS)).toEqual({
      slices: [],
    });
  });
});

describe("buildChartSeries — missing value property", () => {
  const rowsMissingCells = [
    row("a", { status: { optionId: "opt-todo" } }),
    row("b", { status: { optionId: "opt-done" } }),
  ];

  it("yields safe nulls for bar when rows carry no values for the property", () => {
    const out = buildChartSeries(rowsMissingCells, BAR_BY_STATUS, PROPS);
    expect(out).toEqual({
      categories: ["Todo", "Done"],
      series: [{ name: "Estimate", values: [null, null] }],
    });
  });

  it("yields no pie slices when nothing is aggregatable", () => {
    expect(buildChartSeries(rowsMissingCells, PIE_BY_STATUS, PROPS)).toEqual({ slices: [] });
  });

  it("falls back to a neutral series name when the property is not in props", () => {
    const out = buildChartSeries(
      ROWS,
      { type: "bar", groupByPropertyId: "status", valuePropertyId: "ghost", aggregateFn: "sum" },
      PROPS,
    );
    expect(out.series[0]).toEqual({ name: "Value", values: [null, null, null, null] });
  });
});

describe("buildChartSeries — showEmpty", () => {
  const withEmpty = [...ROWS, row("r6", { estimate: { number: 10 } })];

  it("includes the Empty bucket for rows missing the group-by value by default", () => {
    const out = buildChartSeries(withEmpty, BAR_BY_STATUS, PROPS);
    expect(out).toEqual({
      categories: ["Todo", "Done", "Doing", "Backlog", EMPTY_GROUP_LABEL],
      series: [{ name: "Estimate", values: [7, 3, 1, 4, 10] }],
    });
  });

  it("drops the Empty bucket when showEmpty is false", () => {
    const out = buildChartSeries(withEmpty, { ...BAR_BY_STATUS, showEmpty: false }, PROPS);
    expect(out).toEqual({
      categories: ["Todo", "Done", "Doing", "Backlog"],
      series: [{ name: "Estimate", values: [7, 3, 1, 4] }],
    });
  });
});

describe("buildChartSeries — sortCategories", () => {
  it("sorts categories by value descending, ties in first-appearance order", () => {
    const out = buildChartSeries(ROWS, { ...BAR_BY_STATUS, sortCategories: "desc" }, PROPS);
    expect(out.categories).toEqual(["Todo", "Backlog", "Done", "Doing"]);
    expect(out.series[0].values).toEqual([7, 4, 3, 1]);
  });

  it("sorts categories by value ascending", () => {
    const out = buildChartSeries(ROWS, { ...BAR_BY_STATUS, sortCategories: "asc" }, PROPS);
    expect(out.categories).toEqual(["Doing", "Done", "Backlog", "Todo"]);
    expect(out.series[0].values).toEqual([1, 3, 4, 7]);
  });

  it("keeps null aggregates last in both directions", () => {
    const rows = [
      row("a", { status: { optionId: "opt-todo" }, estimate: { number: 5 } }),
      row("b", { status: { optionId: "opt-done" }, estimate: { text: "abc" } }),
      row("c", { status: { optionId: "opt-doing" }, estimate: { number: 1 } }),
    ];
    const asc = buildChartSeries(rows, { ...BAR_BY_STATUS, sortCategories: "asc" }, PROPS);
    expect(asc.categories).toEqual(["Doing", "Todo", "Done"]);
    expect(asc.series[0].values).toEqual([1, 5, null]);
    const desc = buildChartSeries(rows, { ...BAR_BY_STATUS, sortCategories: "desc" }, PROPS);
    expect(desc.categories).toEqual(["Todo", "Doing", "Done"]);
    expect(desc.series[0].values).toEqual([5, 1, null]);
  });

  it("sorts pie slices too", () => {
    const out = buildChartSeries(ROWS, { ...PIE_BY_STATUS, sortCategories: "desc" }, PROPS);
    expect(out.slices).toEqual([
      { label: "Todo", value: 7 },
      { label: "Backlog", value: 4 },
      { label: "Done", value: 3 },
      { label: "Doing", value: 1 },
    ]);
  });
});

describe("buildChartSeries — limitSlices (top-N + Other bucket)", () => {
  it("keeps the top 2 pie slices and buckets the rest into Other", () => {
    const out = buildChartSeries(ROWS, { ...PIE_BY_STATUS, limitSlices: { limit: 2 } }, PROPS);
    expect(out.slices).toEqual([
      { label: "Todo", value: 7 },
      { label: "Backlog", value: 4 },
      { label: OTHER_SLICE_LABEL, value: 4 },
    ]);
  });

  it("honors a custom Other label", () => {
    const out = buildChartSeries(
      ROWS,
      { ...PIE_BY_STATUS, limitSlices: { limit: 2, otherLabel: "Rest" } },
      PROPS,
    );
    expect(out.slices.map((slice) => slice.label)).toEqual(["Todo", "Backlog", "Rest"]);
  });

  it("recomputes Other from the underlying rows (not a sum of averages)", () => {
    const out = buildChartSeries(
      ROWS,
      {
        type: "pie",
        groupByPropertyId: "status",
        valuePropertyId: "estimate",
        aggregateFn: "average",
        limitSlices: { limit: 2 },
      },
      PROPS,
    );
    expect(out.slices).toEqual([
      { label: "Todo", value: 3.5 },
      { label: "Backlog", value: 4 },
      { label: OTHER_SLICE_LABEL, value: 2 },
    ]);
  });

  it("applies to bar categories as well", () => {
    const out = buildChartSeries(ROWS, { ...BAR_BY_STATUS, limitSlices: { limit: 2 } }, PROPS);
    expect(out).toEqual({
      categories: ["Todo", "Backlog", OTHER_SLICE_LABEL],
      series: [{ name: "Estimate", values: [7, 4, 4] }],
    });
  });

  it("adds no Other bucket when the limit covers every category", () => {
    const out = buildChartSeries(ROWS, { ...PIE_BY_STATUS, limitSlices: { limit: 4 } }, PROPS);
    expect(out.slices).toHaveLength(4);
    expect(out.slices.some((slice) => slice.label === OTHER_SLICE_LABEL)).toBe(false);
  });

  it("ignores a non-positive limit instead of throwing", () => {
    const out = buildChartSeries(ROWS, { ...PIE_BY_STATUS, limitSlices: { limit: 0 } }, PROPS);
    expect(out.slices).toHaveLength(4);
  });
});

describe("buildChartSeries — determinism and ordering", () => {
  it("returns identical output for identical input", () => {
    const config: ChartConfig = {
      type: "pie",
      groupByPropertyId: "status",
      valuePropertyId: "estimate",
      aggregateFn: "sum",
      sortCategories: "desc",
      limitSlices: { limit: 2 },
    };
    const first = buildChartSeries(ROWS, config, PROPS);
    const second = buildChartSeries(ROWS, config, PROPS);
    expect(second).toEqual(first);
    expect(first).toEqual(second);
  });

  it("orders categories by first appearance of the group key", () => {
    const rows = [
      row("1", { status: { optionId: "opt-done" } }),
      row("2", { status: { optionId: "opt-todo" } }),
      row("3", { status: { optionId: "opt-done" } }),
    ];
    const out = buildChartSeries(
      rows,
      { type: "bar", groupByPropertyId: "status", aggregateFn: "count" },
      PROPS,
    );
    expect(out.categories).toEqual(["Done", "Todo"]);
    expect(out.series[0].values).toEqual([2, 1]);
  });

  it("narrows a plain ChartConfig variable to the shape matching its type", () => {
    const config: ChartConfig = {
      type: "pie",
      groupByPropertyId: "status",
      valuePropertyId: "estimate",
      aggregateFn: "sum",
    };
    const result = buildChartSeries(ROWS, config, PROPS);
    expect("slices" in result).toBe(true);
    if ("slices" in result) expect(result.slices).toHaveLength(4);
  });
});
