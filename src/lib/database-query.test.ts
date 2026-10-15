import { describe, expect, it } from "vitest";
import {
  addFilter,
  addSort,
  applyFilters,
  applySorts,
  applyView,
  chartData,
  compareValues,
  formatCell,
  groupRows,
  moveSort,
  normalizeOptionIds,
  normalizeViewConfig,
  operatorsFor,
  parseViewConfig,
  removeSort,
  rowColor,
  statusGroupColumns,
  statusGroupOf,
  timelineData,
  visibleColumns,
  type QueryProperty,
  type QueryRow,
  type ViewConfig,
} from "@/lib/database-query";

const properties: QueryProperty[] = [
  { id: "name", name: "Name", type: "TEXT", config: { primary: true } },
  { id: "estimate", name: "Estimate", type: "NUMBER", config: null },
  {
    id: "status",
    name: "Status",
    type: "STATUS",
    config: {
      options: [
        { id: "todo", name: "To-do", color: "gray" },
        { id: "done", name: "Done", color: "green" },
      ],
    },
  },
  {
    id: "tags",
    name: "Tags",
    type: "MULTI_SELECT",
    config: {
      options: [
        { id: "web", name: "Web", color: "blue" },
        { id: "api", name: "API", color: "purple" },
      ],
    },
  },
  { id: "due", name: "Due", type: "DATE", config: null },
];

const row = (
  id: string,
  title: string,
  values: Record<string, unknown>,
): QueryRow => ({
  id,
  title,
  icon: null,
  propertyValues: Object.entries(values).map(([propertyId, value]) => ({
    propertyId,
    value,
  })),
});

const rows: QueryRow[] = [
  row("1", "Alpha", { estimate: { number: 5 }, status: { optionId: "todo" }, due: { start: "2026-03-01" }, tags: { optionIds: ["web"] } }),
  row("2", "Beta", { estimate: { number: 2 }, status: { optionId: "done" }, due: { start: "2026-01-15" }, tags: { optionIds: ["api"] } }),
  row("3", "Gamma", { estimate: { number: 9 }, status: { optionId: "todo" }, tags: {} }),
];

describe("formatCell", () => {
  it("formats each property type", () => {
    expect(formatCell({ number: 3 }, properties[1])).toBe("3");
    expect(formatCell({ optionId: "done" }, properties[2])).toBe("Done");
    expect(formatCell({ optionIds: ["web", "api"] }, properties[3])).toBe("Web, API");
    expect(formatCell({ start: "2026-05-09T00:00:00.000Z" }, properties[4])).toBe("2026-05-09");
    expect(formatCell(null, properties[0])).toBe("");
  });
});

describe("compareValues", () => {
  it("compares numbers numerically", () => {
    expect(compareValues({ number: 2 }, { number: 10 }, properties[1])).toBeLessThan(0);
  });
  it("compares dates chronologically", () => {
    expect(
      compareValues({ start: "2026-01-01" }, { start: "2026-02-01" }, properties[4]),
    ).toBeLessThan(0);
  });
});

describe("applyFilters", () => {
  it("filters by contains", () => {
    const out = applyFilters(rows, properties, [
      { propertyId: "name", operator: "contains", value: "amm" },
    ]);
    expect(out.map((r) => r.id)).toEqual(["3"]);
  });
  it("filters numerically with gt", () => {
    const out = applyFilters(rows, properties, [
      { propertyId: "estimate", operator: "gt", value: "4" },
    ]);
    expect(out.map((r) => r.id)).toEqual(["1", "3"]);
  });
  it("filters empty values", () => {
    const out = applyFilters(rows, properties, [
      { propertyId: "due", operator: "is_empty" },
    ]);
    expect(out.map((r) => r.id)).toEqual(["3"]);
  });
  it("returns all rows with no filters", () => {
    expect(applyFilters(rows, properties, undefined)).toHaveLength(3);
  });
});

describe("applySorts", () => {
  it("sorts ascending by number", () => {
    const out = applySorts(rows, properties, [{ propertyId: "estimate", direction: "asc" }]);
    expect(out.map((r) => r.id)).toEqual(["2", "1", "3"]);
  });
  it("sorts descending by date", () => {
    const out = applySorts(rows, properties, [{ propertyId: "due", direction: "desc" }]);
    expect(out[0].id).toBe("1");
  });
});

describe("groupRows", () => {
  it("groups by status and appends an ungrouped bucket", () => {
    const grouped = groupRows(rows, properties, "status");
    expect(grouped).not.toBeNull();
    expect(grouped!.map((g) => g.id)).toEqual(["todo", "done"]);
    expect(grouped!.find((g) => g.id === "todo")!.rows).toHaveLength(2);
  });
  it("returns null when no group property is set", () => {
    expect(groupRows(rows, properties, null)).toBeNull();
  });
});

describe("applyView", () => {
  it("composes filter + sort + group", () => {
    const { rows: out, groups } = applyView(rows, properties, {
      filters: [{ propertyId: "status", operator: "is", value: "to-do" }],
      sorts: [{ propertyId: "estimate", direction: "desc" }],
      groupByPropertyId: "status",
    });
    expect(out.map((r) => r.id)).toEqual(["3", "1"]);
    expect(groups!.map((g) => g.id)).toEqual(["todo"]);
  });

  it("supports OR mode", () => {
    const { rows: out } = applyView(rows, properties, {
      filters: [
        { propertyId: "status", operator: "is", value: "done" },
        { propertyId: "estimate", operator: "gt", value: "8" },
      ],
      filterMode: "or",
    });
    expect(out.map((r) => r.id)).toEqual(["2", "3"]);
  });

  it("supports a nested AND/OR filter tree", () => {
    const { rows: out } = applyView(rows, properties, {
      filterTree: [
        { propertyId: "estimate", operator: "gt", value: "1" },
        { or: [{ propertyId: "status", operator: "is", value: "done" }] },
      ],
    });
    expect(out.map((r) => r.id)).toEqual(["2"]);
  });
});

describe("rowColor", () => {
  it("returns the first matching rule's color", () => {
    const color = rowColor(rows[0], properties, [
      { propertyId: "status", operator: "is", value: "done", color: "green" },
      { propertyId: "status", operator: "is", value: "to-do", color: "gray" },
    ]);
    expect(color).toBe("gray");
    expect(rowColor(rows[1], properties, [
      { propertyId: "status", operator: "is", value: "done", color: "green" },
    ])).toBe("green");
    expect(rowColor(rows[2], properties, [])).toBeNull();
  });
});

describe("chartData", () => {
  it("aggregates counts by a status property", () => {
    const data = chartData(rows, properties, "status");
    expect(data.map((d) => [d.id, d.count])).toEqual([
      ["todo", 2],
      ["done", 1],
    ]);
  });
});

describe("timelineData", () => {
  it("positions bars within a range", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const to = new Date("2026-03-01T00:00:00Z");
    const bars = timelineData(rows, properties, "due", from, to);
    expect(bars).toHaveLength(2);
    const beta = bars.find((b) => b.title === "Beta")!;
    const alpha = bars.find((b) => b.title === "Alpha")!;
    expect(beta.offsetPct).toBeLessThan(alpha.offsetPct);
    expect(alpha.widthPct).toBeGreaterThan(0);
  });
});

/* ---------------------------------------------------------------------------
   B15 — filter operator long tail
   --------------------------------------------------------------------------- */

describe("operatorsFor", () => {
  const values = (type: string) =>
    operatorsFor(type as QueryProperty["type"]).map((op) => op.value);

  it("offers the text long tail", () => {
    expect(values("TEXT")).toEqual(
      expect.arrayContaining([
        "contains",
        "does_not_contain",
        "starts_with",
        "ends_with",
        "is",
        "is_not",
        "is_empty",
        "is_not_empty",
      ]),
    );
  });

  it("offers the numeric comparison set", () => {
    expect(values("NUMBER")).toEqual(
      expect.arrayContaining(["gt", "gte", "lt", "lte", "is_empty", "is_not_empty"]),
    );
  });

  it("offers chronological operators for dates", () => {
    expect(values("DATE")).toEqual(
      expect.arrayContaining(["before", "after", "gt", "lt", "gte", "lte"]),
    );
  });

  it("offers checked/unchecked for checkboxes and no text operators", () => {
    expect(values("CHECKBOX")).toEqual(
      expect.arrayContaining(["checked", "unchecked"]),
    );
    expect(values("CHECKBOX")).not.toContain("starts_with");
    expect(values("CHECKBOX")).not.toContain("gt");
  });

  it("keeps every operator label unique", () => {
    for (const type of ["TEXT", "NUMBER", "DATE", "CHECKBOX", "SELECT"]) {
      const list = operatorsFor(type as QueryProperty["type"]);
      expect(new Set(list.map((op) => op.label)).size).toBe(list.length);
      expect(new Set(list.map((op) => op.value)).size).toBe(list.length);
    }
  });
});

describe("filter operator long tail", () => {
  it("matches starts_with and ends_with", () => {
    expect(
      applyFilters(rows, properties, [
        { propertyId: "name", operator: "starts_with", value: "a" },
      ]).map((r) => r.id),
    ).toEqual(["1"]);
    expect(
      applyFilters(rows, properties, [
        { propertyId: "name", operator: "ends_with", value: "ta" },
      ]).map((r) => r.id),
    ).toEqual(["2"]);
    // Both conditions must hold when they are combined with AND.
    expect(
      applyFilters(rows, properties, [
        { propertyId: "name", operator: "ends_with", value: "a" },
        { propertyId: "name", operator: "starts_with", value: "b" },
      ]).map((r) => r.id),
    ).toEqual(["2"]);
  });

  it("matches gte and lte inclusively on numbers", () => {
    expect(
      applyFilters(rows, properties, [
        { propertyId: "estimate", operator: "gte", value: "5" },
      ]).map((r) => r.id),
    ).toEqual(["1", "3"]);
    expect(
      applyFilters(rows, properties, [
        { propertyId: "estimate", operator: "lte", value: "5" },
      ]).map((r) => r.id),
    ).toEqual(["1", "2"]);
  });

  it("compares dates chronologically with before/after", () => {
    expect(
      applyFilters(rows, properties, [
        { propertyId: "due", operator: "before", value: "2026-02-01" },
      ]).map((r) => r.id),
    ).toEqual(["2"]);
    expect(
      applyFilters(rows, properties, [
        { propertyId: "due", operator: "after", value: "2026-02-01" },
      ]).map((r) => r.id),
    ).toEqual(["1"]);
  });

  it("parses the target as a date for gt/lt on date properties", () => {
    // Regression: the old implementation compared the date against
    // { number: NaN }, so every dated row matched.
    expect(
      applyFilters(rows, properties, [
        { propertyId: "due", operator: "gt", value: "2026-02-01" },
      ]).map((r) => r.id),
    ).toEqual(["1"]);
    expect(
      applyFilters(rows, properties, [
        { propertyId: "due", operator: "lt", value: "2026-02-01" },
      ]).map((r) => r.id),
    ).toEqual(["2"]);
  });

  it("never matches a comparison with an unparseable target", () => {
    expect(
      applyFilters(rows, properties, [
        { propertyId: "estimate", operator: "gt", value: "" },
      ]),
    ).toHaveLength(0);
    expect(
      applyFilters(rows, properties, [
        { propertyId: "due", operator: "after", value: "not-a-date" },
      ]),
    ).toHaveLength(0);
  });

  it("addFilter never duplicates a property+operator pair", () => {
    const first = addFilter([], { propertyId: "name", operator: "contains", value: "a" });
    const second = addFilter(first, { propertyId: "name", operator: "contains", value: "b" });
    expect(second).toHaveLength(1);
    expect(second[0].value).toBe("a");
    expect(
      addFilter(second, { propertyId: "name", operator: "starts_with", value: "a" }),
    ).toHaveLength(2);
  });
});

/* ---------------------------------------------------------------------------
   B15 — multi-sort comparator
   --------------------------------------------------------------------------- */

describe("multi-sort comparator", () => {
  it("breaks ties with the next sort key, each with its own direction", () => {
    const out = applySorts(rows, properties, [
      { propertyId: "status", direction: "asc" },
      { propertyId: "estimate", direction: "desc" },
    ]);
    // "Done" < "To-do", then the two To-dos tie and fall to estimate desc.
    expect(out.map((r) => r.id)).toEqual(["2", "3", "1"]);
  });

  it("keeps rows without a value last in ascending and descending order", () => {
    const asc = applySorts(rows, properties, [
      { propertyId: "due", direction: "asc" },
    ]);
    expect(asc.map((r) => r.id)).toEqual(["2", "1", "3"]);
    const desc = applySorts(rows, properties, [
      { propertyId: "due", direction: "desc" },
    ]);
    expect(desc.map((r) => r.id)).toEqual(["1", "2", "3"]);
  });

  it("moves empty rows last even when a secondary key is descending", () => {
    const desc = applySorts(rows, properties, [
      { propertyId: "status", direction: "asc" },
      { propertyId: "due", direction: "desc" },
    ]);
    // Within the To-do group the empty due date must still sort last.
    expect(desc.map((r) => r.id)).toEqual(["2", "1", "3"]);
  });

  it("addSort is deduped by property and removeSort/moveSort are pure", () => {
    let sorts = addSort([], "estimate");
    sorts = addSort(sorts, "estimate");
    expect(sorts).toHaveLength(1);
    sorts = addSort(sorts, "status");
    expect(sorts.map((s) => s.propertyId)).toEqual(["estimate", "status"]);

    const moved = moveSort(sorts, 1, 0);
    expect(moved.map((s) => s.propertyId)).toEqual(["status", "estimate"]);
    // original untouched (pure)
    expect(sorts.map((s) => s.propertyId)).toEqual(["estimate", "status"]);

    const reduced = removeSort(moved, "status");
    expect(reduced.map((s) => s.propertyId)).toEqual(["estimate"]);
    expect(moved).toHaveLength(2);
  });
});

/* ---------------------------------------------------------------------------
   B15 — per-view configuration persistence (serialization)
   --------------------------------------------------------------------------- */

describe("view config serialization", () => {
  it("round-trips a full per-view config", () => {
    const config = {
      filters: [
        { propertyId: "name", operator: "starts_with" as const, value: "a" },
        { propertyId: "estimate", operator: "gte" as const, value: "5" },
      ],
      filterMode: "or" as const,
      sorts: [
        { propertyId: "status", direction: "asc" as const },
        { propertyId: "estimate", direction: "desc" as const },
      ],
      groupByPropertyId: "status",
      visiblePropertyIds: ["name", "estimate"],
      colorRules: [
        { propertyId: "status", operator: "is" as const, value: "done", color: "green" },
      ],
    };
    const stored = JSON.parse(JSON.stringify(normalizeViewConfig(config)));
    expect(parseViewConfig(stored)).toEqual(config);
  });

  it("drops unknown operators, coerces directions and rejects unknown keys", () => {
    const out = normalizeViewConfig({
      filters: [
        { propertyId: "name", operator: "bogus", value: "x" },
        { propertyId: "name", operator: "contains", value: "ok" },
        { operator: "contains", value: "no property" },
      ],
      sorts: [
        { propertyId: "estimate", direction: "sideways" },
        { propertyId: "estimate", direction: "desc" },
      ],
      filterMode: "maybe",
      visiblePropertyIds: ["estimate", 7, "estimate"],
      futureOption: { nested: true },
    } as never);

    expect(out.filters).toEqual([
      { propertyId: "name", operator: "contains", value: "ok" },
    ]);
    expect(out.sorts).toEqual([{ propertyId: "estimate", direction: "asc" }]);
    expect(out.filterMode).toBe("and");
    expect(out.visiblePropertyIds).toEqual(["estimate"]);
    expect(out).not.toHaveProperty("futureOption");
  });

  it("survives malformed stored JSON", () => {
    expect(parseViewConfig("not json")).toEqual({});
    expect(parseViewConfig(null)).toEqual({});
    expect(parseViewConfig(undefined)).toEqual({});
    expect(parseViewConfig(42)).toEqual({});
    expect(parseViewConfig("{")).toEqual({});
  });

  it("keeps a stored empty filter list distinguishable from no config", () => {
    expect(parseViewConfig({ filters: [] }).filters).toEqual([]);
    expect(parseViewConfig({ filters: "nope" }).filters).toBeUndefined();
  });

  it("round-trips the optional swimlane, WIP-limit, number-format and layout keys", () => {
    const config = {
      filters: [],
      laneBy: "owner",
      wipLimits: { todo: 3, doing: 2 },
      numberFormat: { style: "percent", decimals: 1 },
      columnLayout: "name:240,status:160",
    };
    const stored = JSON.parse(JSON.stringify(normalizeViewConfig(config)));
    expect(parseViewConfig(stored)).toEqual(config);
  });

  it("keeps the optional keys but drops malformed values", () => {
    const out = normalizeViewConfig({
      laneBy: 7,
      wipLimits: { todo: 3, doing: -1, done: "many", "": 1, review: 2.5 },
      columnLayout: ["nope"],
    } as never);

    expect(out.laneBy).toBeUndefined();
    expect(out.wipLimits).toEqual({ todo: 3 });
    expect(out.columnLayout).toBeUndefined();
    expect(out).not.toHaveProperty("numberFormat");
  });

  it("normalises an empty WIP-limit map away, like the settings editor", () => {
    const out = normalizeViewConfig({ wipLimits: { todo: "nope" } } as never);
    expect(out).not.toHaveProperty("wipLimits");
    expect(normalizeViewConfig({ numberFormat: null }).numberFormat).toBeNull();
  });

  it("round-trips the optional group-visibility, card-size, description and chart keys", () => {
    const config: ViewConfig = {
      visibleGroups: { todo: true, doing: false },
      cardSize: "large",
      description: "Sprint overview",
      chartType: "donut",
      chartAggregate: "sum",
    };
    const stored = JSON.parse(JSON.stringify(normalizeViewConfig(config)));
    expect(parseViewConfig(stored)).toEqual(config);
  });

  it("keeps the optional board/gallery/chart keys but drops malformed values", () => {
    const out = normalizeViewConfig({
      visibleGroups: { todo: true, doing: false, done: "no", "": true },
      cardSize: 7,
      description: { text: "nope" },
      chartType: ["pie"],
      chartAggregate: 12,
    } as never);

    expect(out.visibleGroups).toEqual({ todo: true, doing: false });
    expect(out).not.toHaveProperty("cardSize");
    expect(out).not.toHaveProperty("description");
    expect(out).not.toHaveProperty("chartType");
    expect(out).not.toHaveProperty("chartAggregate");
  });

  it("normalises an empty or invalid group-visibility map away, like the WIP limits", () => {
    expect(normalizeViewConfig({ visibleGroups: {} } as never)).not.toHaveProperty(
      "visibleGroups",
    );
    expect(normalizeViewConfig({ visibleGroups: { todo: 1 } } as never)).not.toHaveProperty(
      "visibleGroups",
    );
    expect(normalizeViewConfig({ visibleGroups: [] } as never)).not.toHaveProperty(
      "visibleGroups",
    );
  });
});

/* ---------------------------------------------------------------------------
   B15 — show/hide properties per view
   --------------------------------------------------------------------------- */

describe("visibleColumns", () => {
  it("shows every column when the view has no visibility setting", () => {
    expect(visibleColumns(properties, {}).map((p) => p.id)).toEqual([
      "name",
      "estimate",
      "status",
      "tags",
      "due",
    ]);
  });

  it("honours visiblePropertyIds and always keeps the primary column first", () => {
    expect(
      visibleColumns(properties, { visiblePropertyIds: ["estimate", "due"] }).map(
        (p) => p.id,
      ),
    ).toEqual(["name", "estimate", "due"]);
    // The primary column can never be hidden away.
    expect(
      visibleColumns(properties, { visiblePropertyIds: ["name"] }).map((p) => p.id),
    ).toEqual(["name"]);
    // Unknown ids are ignored rather than rendering an empty column.
    expect(
      visibleColumns(properties, { visiblePropertyIds: ["estimate", "gone"] }).map(
        (p) => p.id,
      ),
    ).toEqual(["name", "estimate"]);
  });

  it("honours an explicit empty list (every secondary column hidden)", () => {
    expect(visibleColumns(properties, { visiblePropertyIds: [] }).map((p) => p.id)).toEqual([
      "name",
    ]);
  });
});

/* ---------------------------------------------------------------------------
   B17 — properties family: number/date formats, status groups,
   multi-select dedup + ordering.
   --------------------------------------------------------------------------- */

describe("number formats", () => {
  const percent = {
    id: "rate",
    name: "Rate",
    type: "NUMBER",
    config: { format: "percent" },
  } as QueryProperty;
  const usd = {
    id: "price",
    name: "Price",
    type: "NUMBER",
    config: { format: "currency" },
  } as QueryProperty;
  const eur = {
    id: "prix",
    name: "Prix",
    type: "NUMBER",
    config: { format: "currency", currency: "EUR" },
  } as QueryProperty;

  it("renders a percent from the stored fraction", () => {
    expect(formatCell({ number: 0.075 }, percent)).toBe("7.5%");
    expect(formatCell({ number: 0.1 }, percent)).toBe("10%");
    expect(formatCell({ number: 0 }, percent)).toBe("0%");
    expect(formatCell({ number: -0.05 }, percent)).toBe("-5%");
  });

  it("renders currency with symbol, grouping and two decimals", () => {
    expect(formatCell({ number: 1234.5 }, usd)).toBe("$1,234.50");
    expect(formatCell({ number: 1234.5 }, eur)).toBe("€1,234.50");
    expect(formatCell({ number: 3 }, usd)).toBe("$3.00");
    expect(formatCell({ number: -7 }, usd)).toBe("-$7.00");
  });

  it("leaves the plain number default untouched", () => {
    expect(formatCell({ number: 1234.5 }, properties[1])).toBe("1234.5");
    expect(formatCell({ number: 3 }, properties[1])).toBe("3");
  });

  it("returns an empty string for empty cells in every format", () => {
    expect(formatCell({}, percent)).toBe("");
    expect(formatCell({ number: null }, usd)).toBe("");
    expect(formatCell(null, percent)).toBe("");
  });
});

describe("date formats", () => {
  const friendly = {
    id: "dueFriendly",
    name: "Due",
    type: "DATE",
    config: { format: "friendly" },
  } as QueryProperty;

  it("renders the friendly format deterministically (UTC, en-GB)", () => {
    expect(formatCell({ start: "2026-05-09" }, friendly)).toBe("9 May 2026");
    expect(formatCell({ start: "2026-05-09T00:00:00.000Z" }, friendly)).toBe("9 May 2026");
  });

  it("keeps the ISO date as the default", () => {
    expect(formatCell({ start: "2026-05-09" }, properties[4])).toBe("2026-05-09");
    expect(formatCell({ start: "2026-05-09T13:45:00.000Z" }, properties[4])).toBe("2026-05-09");
  });

  it("returns an empty string when there is no date", () => {
    expect(formatCell({}, friendly)).toBe("");
    expect(formatCell({ start: null }, friendly)).toBe("");
  });
});

describe("status groups", () => {
  const groupedStatus = {
    id: "st",
    name: "Status",
    type: "STATUS",
    config: {
      options: [
        { id: "backlog", name: "Backlog", color: "gray", group: "todo" },
        { id: "building", name: "Building", color: "blue", group: "doing" },
        { id: "shipped", name: "Shipped", color: "green", group: "done" },
        { id: "misc", name: "Misc", color: "purple" },
      ],
    },
  } as QueryProperty;

  it("maps each option to its bucket", () => {
    expect(statusGroupOf(groupedStatus, "backlog")).toBe("todo");
    expect(statusGroupOf(groupedStatus, "building")).toBe("doing");
    expect(statusGroupOf(groupedStatus, "shipped")).toBe("done");
    expect(statusGroupOf(groupedStatus, "misc")).toBeNull();
    expect(statusGroupOf(groupedStatus, undefined)).toBeNull();
    expect(statusGroupOf(groupedStatus, "ghost")).toBeNull();
  });

  it("is null for non-status properties and ungrouped status configs", () => {
    expect(statusGroupOf(properties[1], "todo")).toBeNull(); // NUMBER
    expect(statusGroupOf(properties[2], "todo")).toBeNull(); // STATUS, no groups
  });

  it("buckets rows into To-do / In progress / Done columns for the board", () => {
    const statusRows: QueryRow[] = [
      row("s1", "A", { st: { optionId: "backlog" } }),
      row("s2", "B", { st: { optionId: "building" } }),
      row("s3", "C", { st: { optionId: "shipped" } }),
      row("s4", "D", { st: { optionId: "misc" } }),
      row("s5", "E", {}),
    ];
    const withGrouped = [...properties, groupedStatus];
    const columns = statusGroupColumns(statusRows, withGrouped, "st", "No value");

    expect(columns.map((c) => c.id)).toEqual(["todo", "doing", "done", "__none"]);
    expect(columns.map((c) => c.name)).toEqual([
      "To-do",
      "In progress",
      "Done",
      "No value",
    ]);
    expect(columns[0].rows.map((r) => r.id)).toEqual(["s1"]);
    expect(columns[1].rows.map((r) => r.id)).toEqual(["s2"]);
    expect(columns[2].rows.map((r) => r.id)).toEqual(["s3"]);
    // An option without a group and an empty value both fall to "No value".
    expect(columns[3].rows.map((r) => r.id)).toEqual(["s4", "s5"]);
  });
});

describe("multi-select dedup and ordering", () => {
  const options = [
    { id: "web", name: "Web", color: "blue" },
    { id: "api", name: "API", color: "purple" },
  ];

  it("keeps first-occurrence order and drops duplicates", () => {
    expect(normalizeOptionIds(["api", "web", "api"], options)).toEqual(["api", "web"]);
  });

  it("drops ids that no longer exist", () => {
    expect(normalizeOptionIds(["web", "gone", "api"], options)).toEqual(["web", "api"]);
  });

  it("formats in stored order without duplicates", () => {
    expect(formatCell({ optionIds: ["api", "web", "api", "gone"] }, properties[3])).toBe(
      "API, Web",
    );
  });

  it("tolerates malformed stored values", () => {
    expect(normalizeOptionIds("web", options)).toEqual([]);
    expect(normalizeOptionIds([1, "web", null], options)).toEqual(["web"]);
    expect(normalizeOptionIds(undefined, options)).toEqual([]);
    expect(normalizeOptionIds([null, undefined], options)).toEqual([]);
  });
});
