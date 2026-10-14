import { describe, expect, it } from "vitest";
import type { Filter, QueryProperty, QueryRow } from "@/lib/database-query";
import {
  ROW_COLOR_PALETTE,
  cellColorFor,
  evaluateRowColors,
  normalizeColor,
  validateRules,
  type RowColorRule,
} from "@/lib/row-color-rules";

/* Fixtures mirror filter-tree.test.ts / database-query.test.ts so colour-rule
   behaviour is compared against the exact values the flat evaluator is
   already tested with. */

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

const alpha = row("1", "Alpha", {
  estimate: { number: 5 },
  status: { optionId: "todo" },
  due: { start: "2026-03-01" },
  tags: { optionIds: ["web"] },
});
const beta = row("2", "Beta", {
  estimate: { number: 2 },
  status: { optionId: "done" },
  due: { start: "2026-01-15" },
  tags: { optionIds: ["api"] },
});
const gamma = row("3", "Gamma", {
  estimate: { number: 9 },
  status: { optionId: "todo" },
});
const rows = [alpha, beta, gamma];

/** A rule; `propertyId` (the painted cell) defaults to the condition's. */
const rule = (
  id: string,
  filter: Filter,
  overrides: Partial<Omit<RowColorRule, "id" | "filter">> = {},
): RowColorRule => ({
  id,
  propertyId: filter.propertyId,
  filter,
  color: "blue",
  target: "row",
  ...overrides,
});

const toDoRule = (id: string, overrides?: Partial<Omit<RowColorRule, "id">>) =>
  rule(id, { propertyId: "status", operator: "is", value: "To-do" }, overrides);

describe("evaluateRowColors — single rule", () => {
  it("returns no colours and no matches when there are no rules", () => {
    expect(evaluateRowColors([], alpha, properties)).toEqual({
      matchedRuleIds: [],
    });
  });

  it("paints the row when the rule matches", () => {
    expect(evaluateRowColors([toDoRule("r1")], alpha, properties)).toEqual({
      backgroundColor: "blue",
      matchedRuleIds: ["r1"],
    });
  });

  it("leaves the row plain when the rule does not match", () => {
    expect(evaluateRowColors([toDoRule("r1")], beta, properties)).toEqual({
      matchedRuleIds: [],
    });
  });

  it("normalises the winning colour to its palette name", () => {
    const rules = [toDoRule("r1", { color: "  Green " })];
    expect(evaluateRowColors(rules, alpha, properties)).toEqual({
      backgroundColor: "green",
      matchedRuleIds: ["r1"],
    });
  });

  it("resolves the winner's textColor (and only the winner's)", () => {
    const rules = [
      toDoRule("r1", { color: "green", textColor: "gray" }),
      rule(
        "r2",
        { propertyId: "estimate", operator: "gt", value: "1" },
        { color: "red", textColor: "blue" },
      ),
    ];
    expect(evaluateRowColors(rules, alpha, properties)).toEqual({
      backgroundColor: "green",
      textColor: "gray",
      matchedRuleIds: ["r1", "r2"],
    });
  });

  it("leaves textColor unset when the winning rule defines none", () => {
    const rules = [
      toDoRule("r1", { color: "green" }),
      rule(
        "r2",
        { propertyId: "estimate", operator: "gt", value: "1" },
        { color: "red", textColor: "blue" },
      ),
    ];
    const resolved = evaluateRowColors(rules, alpha, properties);
    expect(resolved).toEqual({
      backgroundColor: "green",
      matchedRuleIds: ["r1", "r2"],
    });
    expect(resolved.textColor).toBeUndefined();
  });

  it("still paints the background when the rule's textColor is outside the palette", () => {
    const rules = [toDoRule("r1", { color: "green", textColor: "white" })];
    expect(evaluateRowColors(rules, alpha, properties)).toEqual({
      backgroundColor: "green",
      matchedRuleIds: ["r1"],
    });
  });

  it("skips a rule whose colour is outside the palette (fail-safe)", () => {
    const rules = [toDoRule("r1", { color: "teal" })];
    expect(evaluateRowColors(rules, alpha, properties)).toEqual({
      matchedRuleIds: [],
    });
  });

  it("skips a rule whose filter property no longer exists instead of matching every row", () => {
    const rules = [
      rule("r1", { propertyId: "ghost", operator: "is", value: "x" }),
    ];
    expect(evaluateRowColors(rules, alpha, properties)).toEqual({
      matchedRuleIds: [],
    });
  });
});

describe("evaluateRowColors — priority order", () => {
  it("applies rules in array order: the first match wins the colours", () => {
    const rules = [
      toDoRule("first", { color: "red" }),
      toDoRule("second", { color: "yellow" }),
    ];
    expect(evaluateRowColors(rules, alpha, properties)).toEqual({
      backgroundColor: "red",
      matchedRuleIds: ["first", "second"],
    });
  });

  it("lists every in-scope match in priority order", () => {
    const rules = [
      rule(
        "later",
        { propertyId: "estimate", operator: "lt", value: "3" },
        { color: "yellow" },
      ),
      toDoRule("earlier", { color: "red" }),
    ];
    expect(evaluateRowColors(rules, alpha, properties)).toEqual({
      backgroundColor: "red",
      matchedRuleIds: ["earlier"],
    });
    expect(evaluateRowColors(rules, beta, properties)).toEqual({
      backgroundColor: "yellow",
      matchedRuleIds: ["later"],
    });
  });
});

describe("evaluateRowColors — row vs cell target scoping", () => {
  const cellRule = (id: string, overrides: Partial<Omit<RowColorRule, "id">> = {}) =>
    rule(id, { propertyId: "estimate", operator: "gt", value: "1" }, {
      target: "cell",
      propertyId: "status",
      color: "red",
      textColor: "gray",
      ...overrides,
    });

  it("does not paint the row from a cell-target rule", () => {
    expect(evaluateRowColors([cellRule("c1")], alpha, properties)).toEqual({
      matchedRuleIds: [],
    });
  });

  it("paints the row from cell rules only when asked (includeCellRules)", () => {
    expect(
      evaluateRowColors([cellRule("c1")], alpha, properties, {
        includeCellRules: true,
      }),
    ).toEqual({
      backgroundColor: "red",
      textColor: "gray",
      matchedRuleIds: ["c1"],
    });
  });

  it("does not paint the row from a cell rule whose cell was deleted", () => {
    const rules = [cellRule("c1", { propertyId: "ghost" })];
    expect(
      evaluateRowColors(rules, alpha, properties, { includeCellRules: true }),
    ).toEqual({ matchedRuleIds: [] });
  });
});

describe("cellColorFor", () => {
  const cellRule = (id: string, overrides: Partial<Omit<RowColorRule, "id">> = {}) =>
    rule(id, { propertyId: "estimate", operator: "gt", value: "1" }, {
      target: "cell",
      propertyId: "status",
      color: "red",
      textColor: "gray",
      ...overrides,
    });

  it("returns the colours of the matching cell rule scoped to that property", () => {
    expect(cellColorFor([cellRule("c1")], alpha, "status", properties)).toEqual({
      backgroundColor: "red",
      textColor: "gray",
      matchedRuleIds: ["c1"],
    });
  });

  it("applies cell rules in priority order (first match wins)", () => {
    const rules = [
      cellRule("first", { color: "red", textColor: undefined }),
      cellRule("second", { color: "yellow", textColor: undefined }),
    ];
    expect(cellColorFor(rules, alpha, "status", properties)).toEqual({
      backgroundColor: "red",
      matchedRuleIds: ["first", "second"],
    });
  });

  it("ignores cell rules scoped to a different property", () => {
    const rules = [cellRule("c1", { propertyId: "due" })];
    expect(cellColorFor(rules, alpha, "status", properties)).toEqual({
      matchedRuleIds: [],
    });
  });

  it("does not paint a cell from a row-target rule", () => {
    expect(cellColorFor([toDoRule("r1")], alpha, "status", properties)).toEqual({
      matchedRuleIds: [],
    });
  });

  it("skips a cell rule whose condition property was deleted", () => {
    const rules = [
      rule(
        "c1",
        { propertyId: "ghost", operator: "is", value: "x" },
        { target: "cell", propertyId: "status" },
      ),
    ];
    expect(cellColorFor(rules, alpha, "status", properties)).toEqual({
      matchedRuleIds: [],
    });
  });

  it("returns nothing for a property that is not in the schema", () => {
    expect(cellColorFor([cellRule("c1")], alpha, "ghost", properties)).toEqual({
      matchedRuleIds: [],
    });
  });

  it("returns no colours when nothing matches", () => {
    const rules = [
      rule(
        "c1",
        { propertyId: "status", operator: "is", value: "Done" },
        { target: "cell", propertyId: "status", color: "red" },
      ),
    ];
    expect(cellColorFor(rules, gamma, "status", properties)).toEqual({
      matchedRuleIds: [],
    });
  });
});

describe("evaluateRowColors — operator vocabulary (reuses applyFilters)", () => {
  const colorOf = (filter: Filter, r: QueryRow) =>
    evaluateRowColors([rule("r", filter)], r, properties).backgroundColor;

  it("is / contains / is_empty / gt / before", () => {
    const is: Filter = { propertyId: "status", operator: "is", value: "To-do" };
    expect(rows.map((r) => colorOf(is, r))).toEqual(["blue", undefined, "blue"]);

    const contains: Filter = { propertyId: "name", operator: "contains", value: "amm" };
    expect(rows.map((r) => colorOf(contains, r))).toEqual([
      undefined,
      undefined,
      "blue",
    ]);

    const isEmpty: Filter = { propertyId: "due", operator: "is_empty" };
    expect(rows.map((r) => colorOf(isEmpty, r))).toEqual([
      undefined,
      undefined,
      "blue",
    ]);

    const gt: Filter = { propertyId: "estimate", operator: "gt", value: "4" };
    expect(rows.map((r) => colorOf(gt, r))).toEqual(["blue", undefined, "blue"]);

    const before: Filter = { propertyId: "due", operator: "before", value: "2026-02-01" };
    expect(rows.map((r) => colorOf(before, r))).toEqual([
      undefined,
      "blue",
      undefined,
    ]);
  });

  it("honours an unmatchable operator instead of falling back to a match", () => {
    const nonsense: Filter = { propertyId: "name", operator: "is", value: "Nope" };
    expect(colorOf(nonsense, alpha)).toBeUndefined();
  });
});

describe("validateRules", () => {
  it("reports nothing for valid rules", () => {
    const rules = [
      rule(
        "r1",
        { propertyId: "status", operator: "is", value: "Done" },
        { color: "green", textColor: "gray" },
      ),
      rule(
        "r2",
        { propertyId: "estimate", operator: "gt", value: "4" },
        { target: "cell", propertyId: "due", color: "yellow" },
      ),
    ];
    expect(validateRules(rules, properties)).toEqual([]);
  });

  it("reports a rule whose filter property is unknown", () => {
    const rules = [rule("r1", { propertyId: "ghost", operator: "is", value: "x" })];
    const issues = validateRules(rules, properties);
    expect(issues.map((i) => i.code)).toEqual(["unknown_filter_property"]);
    expect(issues[0]).toMatchObject({ index: 0, ruleId: "r1" });
  });

  it("reports an unknown operator", () => {
    const rules = [
      rule("r1", {
        propertyId: "status",
        operator: "wat" as unknown as Filter["operator"],
      }),
    ];
    expect(validateRules(rules, properties).map((i) => i.code)).toEqual([
      "invalid_operator",
    ]);
  });

  it("reports an operator the property type does not offer", () => {
    const rules = [
      rule("r1", { propertyId: "name", operator: "checked" }),
    ];
    expect(validateRules(rules, properties).map((i) => i.code)).toEqual([
      "operator_not_allowed",
    ]);
  });

  it("reports a cell rule whose painted cell is unknown", () => {
    const rules = [
      rule(
        "r1",
        { propertyId: "estimate", operator: "gt", value: "4" },
        { target: "cell", propertyId: "ghost" },
      ),
    ];
    expect(validateRules(rules, properties).map((i) => i.code)).toEqual([
      "unknown_cell_property",
    ]);
  });

  it("reports colours outside the palette", () => {
    const badColor = [rule("r1", { propertyId: "name", operator: "is_empty" }, { color: "teal" })];
    expect(validateRules(badColor, properties).map((i) => i.code)).toEqual([
      "unknown_color",
    ]);

    const noColor = [rule("r1", { propertyId: "name", operator: "is_empty" }, { color: "" })];
    expect(validateRules(noColor, properties).map((i) => i.code)).toEqual([
      "missing_color",
    ]);

    const badText = [
      rule("r1", { propertyId: "name", operator: "is_empty" }, { textColor: "#fff" }),
    ];
    expect(validateRules(badText, properties).map((i) => i.code)).toEqual([
      "invalid_text_color",
    ]);
  });

  it("reports an invalid target and a missing id", () => {
    const rules = [
      rule("r1", { propertyId: "name", operator: "is_empty" }, {
        target: "column" as unknown as RowColorRule["target"],
      }),
      { ...toDoRule("r2"), id: "" },
    ];
    const issues = validateRules(rules, properties);
    expect(issues.map((i) => [i.ruleId, i.code])).toEqual([
      ["r1", "invalid_target"],
      ["", "missing_id"],
    ]);
  });

  it("collects several issues for one rule", () => {
    const rules = [
      rule("r1", { propertyId: "ghost", operator: "is", value: "x" }, {
        color: "teal",
      }),
    ];
    expect(validateRules(rules, properties).map((i) => i.code).sort()).toEqual([
      "unknown_color",
      "unknown_filter_property",
    ]);
  });

  it("reports a rule with no filter condition", () => {
    const rules = [{ id: "r1", color: "blue", target: "row" } as RowColorRule];
    expect(validateRules(rules, properties).map((i) => i.code)).toContain(
      "missing_filter",
    );
  });

  it("never throws on malformed stored rules", () => {
    const junk = [
      null,
      undefined,
      {},
      { id: 7, filter: "nope", color: 5, target: 42 },
    ] as unknown as RowColorRule[];
    expect(() => validateRules(junk, properties)).not.toThrow();
    expect(validateRules(junk, properties).length).toBeGreaterThan(0);
  });

  it("never throws when resolving malformed stored rules", () => {
    const junk = [null, undefined, 7] as unknown as RowColorRule[];
    expect(() => evaluateRowColors(junk, alpha, properties)).not.toThrow();
    expect(() => cellColorFor(junk, alpha, "status", properties)).not.toThrow();
    expect(evaluateRowColors(junk, alpha, properties)).toEqual({
      matchedRuleIds: [],
    });
  });
});

describe("ROW_COLOR_PALETTE / normalizeColor", () => {
  it("matches the nine tints the rest of the app offers", () => {
    expect([...ROW_COLOR_PALETTE]).toEqual([
      "gray",
      "brown",
      "orange",
      "yellow",
      "green",
      "blue",
      "purple",
      "pink",
      "red",
    ]);
  });

  it("normalises case and whitespace", () => {
    expect(normalizeColor(" RED ")).toBe("red");
    expect(normalizeColor("Blue")).toBe("blue");
  });

  it("rejects anything outside the palette", () => {
    expect(normalizeColor("teal")).toBeNull();
    expect(normalizeColor("#fdebec")).toBeNull();
    expect(normalizeColor(undefined)).toBeNull();
    expect(normalizeColor(7)).toBeNull();
  });
});
