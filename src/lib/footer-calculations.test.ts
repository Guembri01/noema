/**
 * Table calculation footer model (R89.4). Red-first acceptance for the pure
 * footer/group-aggregation layer. Values/display come from `aggregate()`
 * (src/lib/aggregations.ts) which is reused by import only.
 */
import { describe, expect, it } from "vitest";
import {
  aggregate,
  groupRows,
  type AggregationFn,
  type GroupedRows,
} from "@/lib/aggregations";
import {
  computeFooter,
  defaultFnForType,
  describeFooter,
  footerFunctionsForType,
  forGroup,
  mergeFooters,
  parseFooterSpec,
  validateFooterSpec,
  type FooterColumnResult,
  type FooterProperty,
  type FooterSpec,
} from "@/lib/footer-calculations";

type CellRow = {
  id: string;
  propertyValues: { propertyId: string; value: unknown }[];
};

const valueFor = (row: CellRow, propertyId: string): unknown =>
  row.propertyValues.find((entry) => entry.propertyId === propertyId)?.value ?? null;

const PROPERTIES: FooterProperty[] = [
  { id: "est", type: "NUMBER", name: "Estimate", config: null },
  { id: "cost", type: "NUMBER", name: "Cost", config: { format: "currency", currency: "EUR" } },
  { id: "pct", type: "NUMBER", name: "Progress", config: { format: "percent" } },
  { id: "done", type: "CHECKBOX", name: "Done", config: null },
  { id: "title", type: "TEXT", name: "Name", config: null },
  { id: "status", type: "SELECT", name: "Status", config: null },
];

const ROWS: CellRow[] = [
  {
    id: "r1",
    propertyValues: [
      { propertyId: "est", value: { number: 3 } },
      { propertyId: "cost", value: { number: 12.5 } },
      { propertyId: "pct", value: { number: 0.25 } },
      { propertyId: "done", value: { checked: true } },
      { propertyId: "title", value: { text: "Alpha" } },
      { propertyId: "status", value: { optionId: "todo" } },
    ],
  },
  {
    id: "r2",
    propertyValues: [
      { propertyId: "est", value: { number: 5 } },
      { propertyId: "cost", value: { number: 7.5 } },
      { propertyId: "pct", value: { number: 0.5 } },
      { propertyId: "done", value: { checked: false } },
      { propertyId: "title", value: { text: "Beta" } },
      { propertyId: "status", value: { optionId: "done" } },
    ],
  },
  {
    id: "r3",
    propertyValues: [
      { propertyId: "est", value: { number: 2 } },
      { propertyId: "cost", value: { number: 0 } },
      { propertyId: "pct", value: { number: 0.25 } },
      { propertyId: "done", value: { checked: true } },
      { propertyId: "title", value: { text: "" } },
    ],
  },
];

const baseOptions = { valueFor, properties: PROPERTIES };

describe("R89.4 parseFooterSpec", () => {
  it("parses a well-formed persisted spec", () => {
    const raw = [
      { propertyId: "est", fn: "sum" },
      { propertyId: "done", fn: "percentChecked" },
    ];
    expect(parseFooterSpec(raw)).toEqual([
      { propertyId: "est", fn: "sum" },
      { propertyId: "done", fn: "percentChecked" },
    ]);
  });

  it("returns an empty spec for non-array / missing input", () => {
    expect(parseFooterSpec(undefined)).toEqual([]);
    expect(parseFooterSpec(null)).toEqual([]);
    expect(parseFooterSpec({ propertyId: "est", fn: "sum" })).toEqual([]);
    expect(parseFooterSpec("nope")).toEqual([]);
  });

  it("drops entries with a missing id or unknown function", () => {
    const raw = [
      { propertyId: "est", fn: "sum" },
      { propertyId: "", fn: "sum" },
      { propertyId: 7, fn: "sum" },
      { propertyId: "title", fn: "bogus" },
      { propertyId: "title" },
      null,
      42,
    ];
    expect(parseFooterSpec(raw)).toEqual([{ propertyId: "est", fn: "sum" }]);
  });

  it("dedupes by property with later wins and keeps first-appearance order", () => {
    const raw = [
      { propertyId: "est", fn: "sum" },
      { propertyId: "done", fn: "count" },
      { propertyId: "est", fn: "average" },
    ];
    expect(parseFooterSpec(raw)).toEqual([
      { propertyId: "est", fn: "average" },
      { propertyId: "done", fn: "count" },
    ]);
  });
});

describe("R89.4 validateFooterSpec", () => {
  it("accepts a valid spec", () => {
    expect(
      validateFooterSpec(
        [
          { propertyId: "est", fn: "sum" },
          { propertyId: "title", fn: "count" },
          { propertyId: "done", fn: "percentChecked" },
        ],
        { properties: PROPERTIES },
      ),
    ).toEqual([]);
  });

  it("flags an unknown property", () => {
    const issues = validateFooterSpec([{ propertyId: "ghost", fn: "sum" }], {
      properties: PROPERTIES,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].propertyId).toBe("ghost");
    expect(issues[0].reason).toBe("unknown-property");
    expect(issues[0].message.length).toBeGreaterThan(0);
  });

  it("flags a numeric function on a non-numeric property", () => {
    const issues = validateFooterSpec([{ propertyId: "title", fn: "sum" }], {
      properties: PROPERTIES,
    });
    expect(issues.map((issue) => issue.reason)).toEqual(["unsupported-function"]);
    expect(issues[0].type).toBe("TEXT");
  });

  it("only allows percentChecked on a checkbox property", () => {
    expect(
      validateFooterSpec([{ propertyId: "done", fn: "percentChecked" }], {
        properties: PROPERTIES,
      }),
    ).toEqual([]);
    const issues = validateFooterSpec([{ propertyId: "status", fn: "percentChecked" }], {
      properties: PROPERTIES,
    });
    expect(issues.map((issue) => issue.reason)).toEqual(["unsupported-function"]);
  });

  it("reports every issue across a mixed spec", () => {
    const issues = validateFooterSpec(
      [
        { propertyId: "est", fn: "sum" },
        { propertyId: "ghost", fn: "sum" },
        { propertyId: "title", fn: "median" },
      ],
      { properties: PROPERTIES },
    );
    expect(issues.map((issue) => issue.reason)).toEqual([
      "unknown-property",
      "unsupported-function",
    ]);
  });
});

describe("R89.4 computeFooter", () => {
  it("returns one column result per spec entry, in order", () => {
    const spec: FooterSpec = [
      { propertyId: "est", fn: "sum" },
      { propertyId: "title", fn: "countValues" },
    ];
    const result = computeFooter(spec, ROWS, baseOptions);
    expect(result.map((column) => column.propertyId)).toEqual(["est", "title"]);
    expect(result.map((column) => column.fn)).toEqual(["sum", "countValues"]);
  });

  it("sums numeric cells through the value extractor", () => {
    const [column] = computeFooter([{ propertyId: "est", fn: "sum" }], ROWS, baseOptions);
    expect(column).toEqual<FooterColumnResult>({
      propertyId: "est",
      fn: "sum",
      value: 10,
      display: "10",
      empty: false,
    });
  });

  it("returns null / dash / empty for a column with nothing to aggregate", () => {
    const [column] = computeFooter([{ propertyId: "est", fn: "sum" }], [], baseOptions);
    expect(column).toEqual({ propertyId: "est", fn: "sum", value: null, display: "—", empty: true });
  });

  it("keeps count at zero (not empty) for an empty row set", () => {
    const [column] = computeFooter([{ propertyId: "est", fn: "count" }], [], baseOptions);
    expect(column).toEqual({ propertyId: "est", fn: "count", value: 0, display: "0", empty: false });
  });

  it("formats percent columns exactly like aggregate()", () => {
    const [column] = computeFooter([{ propertyId: "pct", fn: "average" }], ROWS, baseOptions);
    const expected = aggregate(
      ROWS.map((row) => valueFor(row, "pct")),
      "average",
      { showAs: "percent" },
    );
    expect(column.value).toBeCloseTo(expected.value ?? Number.NaN);
    expect(column.display).toBe(expected.display);
    expect(column.display).toBe("33.33%");
  });

  it("formats currency columns exactly like aggregate() including the ISO code", () => {
    const [column] = computeFooter([{ propertyId: "cost", fn: "sum" }], ROWS, baseOptions);
    const expected = aggregate(
      ROWS.map((row) => valueFor(row, "cost")),
      "sum",
      { showAs: "currency", currency: "EUR" },
    );
    expect(column.value).toBe(20);
    expect(column.display).toBe(expected.display);
    expect(column.display).toBe("€20.00");
  });

  it("formats a plain number column like aggregate()", () => {
    const [column] = computeFooter([{ propertyId: "est", fn: "average" }], ROWS, baseOptions);
    expect(column.display).toBe(aggregate([3, 5, 2], "average").display);
  });

  it("computes percentChecked for a checkbox column", () => {
    const [column] = computeFooter([{ propertyId: "done", fn: "percentChecked" }], ROWS, baseOptions);
    expect(column.value).toBeCloseTo(2 / 3);
    expect(column.display).toBe("66.67%");
  });

  it("falls back to plain formatting when the property is unknown", () => {
    const [column] = computeFooter([{ propertyId: "ghost", fn: "count" }], ROWS, baseOptions);
    expect(column).toEqual({ propertyId: "ghost", fn: "count", value: 3, display: "3", empty: false });
  });
});

describe("R89.4 forGroup", () => {
  type Task = { id: string; status?: string | null; estimate?: number | null };
  const tasks: Task[] = [
    { id: "1", status: "todo", estimate: 3 },
    { id: "2", status: "done", estimate: 5 },
    { id: "3", status: "todo", estimate: 2 },
    { id: "4", status: null, estimate: 1 },
  ];
  const groupValueFor = (row: Task, propertyId: string): unknown =>
    propertyId === "est" ? row.estimate : null;
  const groupOptions = { valueFor: groupValueFor, properties: PROPERTIES };
  const groups: GroupedRows<Task>[] = groupRows(tasks, (task) => task.status);

  it("computes a footer per group over that group's rows", () => {
    const result = forGroup(groups, [{ propertyId: "est", fn: "sum" }], groupOptions);
    expect(result.map((group) => group.key)).toEqual(["todo", "done", ""]);
    expect(result.map((group) => group.footers[0].value)).toEqual([5, 5, 1]);
  });

  it("preserves group order, labels and the row references", () => {
    const result = forGroup(groups, [{ propertyId: "est", fn: "count" }], groupOptions);
    expect(result.map((group) => group.label)).toEqual(groups.map((group) => group.label));
    expect(result[0].rows).toBe(groups[0].rows);
  });

  it("is safe on an empty group", () => {
    const empty: GroupedRows<Task>[] = [{ key: "x", label: "X", rows: [] }];
    const result = forGroup(empty, [{ propertyId: "est", fn: "sum" }], groupOptions);
    expect(result[0].footers[0]).toEqual({
      propertyId: "est",
      fn: "sum",
      value: null,
      display: "—",
      empty: true,
    });
  });

  it("applies percent formatting within each group", () => {
    const rows: Task[] = [
      { id: "1", status: "g", estimate: 0.25 },
      { id: "2", status: "g", estimate: 0.75 },
    ];
    const result = forGroup(
      groupRows(rows, (row) => row.status),
      [{ propertyId: "est", fn: "average" }],
      { valueFor: (row) => row.estimate, properties: PROPERTIES },
    );
    expect(result[0].footers[0].value).toBe(0.5);
  });

  it("returns an empty list for no groups", () => {
    expect(forGroup([], [{ propertyId: "est", fn: "sum" }], groupOptions)).toEqual([]);
  });
});

describe("R89.4 describeFooter", () => {
  const names: Record<string, string> = { est: "Estimate", done: "Done" };
  const labels: Record<AggregationFn, string> = {
    count: "Count all",
    countValues: "Count values",
    countEmpty: "Count empty",
    sum: "Sum",
    average: "Average",
    min: "Min",
    max: "Max",
    median: "Median",
    range: "Range",
    percentEmpty: "Percent empty",
    percentChecked: "Percent checked",
  };
  const opts = {
    propertyName: (id: string) => names[id] ?? id,
    fnLabel: (fn: AggregationFn) => labels[fn],
  };

  it("describes each entry as property + function", () => {
    const text = describeFooter(
      [
        { propertyId: "est", fn: "sum" },
        { propertyId: "done", fn: "percentChecked" },
      ],
      opts,
    );
    expect(text).toEqual(["Estimate: Sum", "Done: Percent checked"]);
  });

  it("falls back to the id when the property name is unknown", () => {
    expect(describeFooter([{ propertyId: "ghost", fn: "count" }], opts)).toEqual(["ghost: Count all"]);
  });

  it("returns no labels for an empty spec", () => {
    expect(describeFooter([], opts)).toEqual([]);
  });
});

describe("R89.4 defaultFnForType", () => {
  it("defaults numeric-ish properties to sum", () => {
    expect(defaultFnForType("NUMBER")).toBe("sum");
    expect(defaultFnForType("ROLLUP")).toBe("sum");
    expect(defaultFnForType("FORMULA")).toBe("sum");
  });

  it("defaults checkbox to percentChecked", () => {
    expect(defaultFnForType("CHECKBOX")).toBe("percentChecked");
  });

  it("defaults every other type to count", () => {
    expect(defaultFnForType("TEXT")).toBe("count");
    expect(defaultFnForType("SELECT")).toBe("count");
    expect(defaultFnForType("DATE")).toBe("count");
    expect(defaultFnForType("PEOPLE")).toBe("count");
  });
});

describe("R89.4 footerFunctionsForType", () => {
  it("offers numeric functions only for numeric-ish properties", () => {
    for (const type of ["NUMBER", "ROLLUP", "FORMULA"] as const) {
      const fns = footerFunctionsForType(type);
      expect(fns).toEqual(expect.arrayContaining(["sum", "average", "min", "max", "median", "range"]));
    }
    for (const type of ["TEXT", "SELECT", "DATE"] as const) {
      const fns = footerFunctionsForType(type);
      expect(fns).not.toContain("sum");
      expect(fns).toEqual(expect.arrayContaining(["count", "countValues", "countEmpty", "percentEmpty"]));
    }
  });

  it("offers percentChecked only for checkbox and every default is supported", () => {
    expect(footerFunctionsForType("CHECKBOX")).toContain("percentChecked");
    expect(footerFunctionsForType("TEXT")).not.toContain("percentChecked");
    for (const type of ["NUMBER", "CHECKBOX", "TEXT", "DATE"] as const) {
      expect(footerFunctionsForType(type)).toContain(defaultFnForType(type));
    }
  });
});

describe("R89.4 mergeFooters", () => {
  it("combines disjoint specs", () => {
    const merged = mergeFooters([
      [{ propertyId: "est", fn: "sum" }],
      [{ propertyId: "done", fn: "percentChecked" }],
    ]);
    expect(merged).toEqual([
      { propertyId: "est", fn: "sum" },
      { propertyId: "done", fn: "percentChecked" },
    ]);
  });

  it("lets a later spec win for the same property", () => {
    const merged = mergeFooters([
      [{ propertyId: "est", fn: "sum" }],
      [{ propertyId: "est", fn: "average" }],
    ]);
    expect(merged).toEqual([{ propertyId: "est", fn: "average" }]);
  });

  it("keeps the first-appearance order while a later spec overrides", () => {
    const merged = mergeFooters([
      [
        { propertyId: "est", fn: "sum" },
        { propertyId: "done", fn: "count" },
      ],
      [{ propertyId: "est", fn: "max" }],
    ]);
    expect(merged).toEqual([
      { propertyId: "est", fn: "max" },
      { propertyId: "done", fn: "count" },
    ]);
  });

  it("handles empty inputs", () => {
    expect(mergeFooters([])).toEqual([]);
    expect(mergeFooters([[], []])).toEqual([]);
    expect(mergeFooters([[], [{ propertyId: "est", fn: "sum" }]])).toEqual([
      { propertyId: "est", fn: "sum" },
    ]);
  });

  it("does not mutate its inputs", () => {
    const first: FooterSpec = [{ propertyId: "est", fn: "sum" }];
    const second: FooterSpec = [{ propertyId: "est", fn: "average" }];
    const merged = mergeFooters([first, second]);
    expect(merged).not.toBe(first);
    expect(merged).not.toBe(second);
    expect(first).toEqual([{ propertyId: "est", fn: "sum" }]);
    expect(second).toEqual([{ propertyId: "est", fn: "average" }]);
  });
});
