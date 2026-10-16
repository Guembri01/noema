import { describe, expect, it } from "vitest";
import {
  colorRulesToFormatRules,
  formatRulesToColorRules,
  moveColorRule,
  moveTemplate,
  removeFooterFunction,
  setFooterFunction,
} from "@/components/database/view-settings";
import type { ColorRule } from "@/lib/database-query";
import {
  parseFormatRule,
  resolveRowStyle,
  type FormatRule,
} from "@/lib/conditional-format";
import {
  computeFooter,
  parseFooterSpec,
  type FooterProperty,
} from "@/lib/footer-calculations";

/**
 * Wiring tests for the settings toolbar's pure bridges (W02).
 *
 * The two engines this toolbar now feeds — `@/lib/conditional-format` and
 * `@/lib/footer-calculations` — each parse a specific persisted shape. These are
 * node tests for the config ⇄ engine mappings, plus a check that a persisted
 * config actually renders through the engine that reads it.
 */

const statusRule: ColorRule = {
  propertyId: "status",
  operator: "is",
  value: "done",
  color: "green",
};
const cellRule: ColorRule = {
  propertyId: "name",
  operator: "contains",
  value: "x",
  color: "blue",
  target: "cell",
};
/** `before` is a filter operator the conditional-format engine cannot evaluate. */
const unsupportedRule: ColorRule = {
  propertyId: "due",
  operator: "before",
  value: "2026-01-01",
  color: "red",
};

describe("moveColorRule", () => {
  it("moves a rule by delta and clamps out-of-range moves", () => {
    const rules: ColorRule[] = [statusRule, cellRule, unsupportedRule];
    expect(moveColorRule(rules, 0, 1)[0]).toBe(cellRule);
    expect(moveColorRule(rules, 2, -1)[2]).toBe(cellRule);
    // Out of range returns a copy, unchanged.
    expect(moveColorRule(rules, 0, -1)).toEqual(rules);
    expect(moveColorRule(rules, 2, 1)).toEqual(rules);
  });
});

describe("colorRulesToFormatRules / formatRulesToColorRules", () => {
  it("projects every evaluable rule and re-indexes priority densely", () => {
    const formats = colorRulesToFormatRules([statusRule, unsupportedRule, cellRule]);
    // `before` is dropped, so the cell rule becomes priority 1.
    expect(formats).toHaveLength(2);
    expect(formats.map((rule) => rule.priority)).toEqual([0, 1]);
    expect(formats[0]).toMatchObject({
      id: "view-color-0",
      target: "row",
      propertyId: "status",
      condition: { op: "is", value: "done" },
      style: { background: "green" },
    });
    expect(formats[1]).toMatchObject({ target: "cell", priority: 1 });
  });

  it("round-trips the operators both vocabularies share", () => {
    const rules = [statusRule, cellRule];
    expect(formatRulesToColorRules(colorRulesToFormatRules(rules))).toEqual(rules);
  });

  it("drops a format rule that paints nothing", () => {
    const noPaint: FormatRule = {
      id: "x",
      target: "row",
      propertyId: "status",
      condition: { op: "is", value: "done" },
      style: {},
      priority: 0,
    };
    expect(formatRulesToColorRules([noPaint])).toEqual([]);
  });

  it("renders the persisted shape through the conditional-format engine", () => {
    // Persisted config → engine shape → what the engine resolves for a row.
    const rules = colorRulesToFormatRules([statusRule, unsupportedRule, cellRule])
      .map(parseFormatRule)
      .filter((rule): rule is FormatRule => rule !== null);
    const resolved = resolveRowStyle(rules, {}, {
      propertyValueFor: (_row, propertyId) =>
        propertyId === "status" ? { optionId: "done" } : null,
    });
    expect(resolved.style).toEqual({ background: "green" });
    expect(resolved.matchedRuleIds).toEqual(["view-color-0"]);
  });
});

describe("footer spec helpers", () => {
  it("upserts a function, preserving first-appearance order", () => {
    let spec = setFooterFunction([], "estimate", "sum");
    spec = setFooterFunction(spec, "name", "count");
    // Replacing keeps the original position.
    spec = setFooterFunction(spec, "estimate", "average");
    expect(spec).toEqual([
      { propertyId: "estimate", fn: "average" },
      { propertyId: "name", fn: "count" },
    ]);
  });

  it("removes a column's function", () => {
    const spec = [
      { propertyId: "estimate", fn: "sum" as const },
      { propertyId: "name", fn: "count" as const },
    ];
    expect(removeFooterFunction(spec, "estimate")).toEqual([
      { propertyId: "name", fn: "count" },
    ]);
  });

  it("persists a spec the engine parses and renders", () => {
    const spec = setFooterFunction(
      setFooterFunction([], "estimate", "sum"),
      "name",
      "count",
    );
    // Stored JSON round-trips through the engine's own parser.
    const parsed = parseFooterSpec(JSON.parse(JSON.stringify(spec)));
    expect(parsed).toEqual(spec);

    const rows = [10, 20, 30];
    const properties: FooterProperty[] = [
      { id: "estimate", type: "NUMBER", name: "Estimate" },
      { id: "name", type: "TEXT", name: "Name" },
    ];
    const results = computeFooter(parsed, rows, {
      valueFor: (row, propertyId) => (propertyId === "estimate" ? row : "row"),
      properties,
    });
    expect(results.map((entry) => [entry.propertyId, entry.value])).toEqual([
      ["estimate", 60],
      ["name", 3],
    ]);
  });
});

describe("moveTemplate", () => {
  it("reorders ids and clamps out-of-range moves", () => {
    expect(moveTemplate(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveTemplate(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveTemplate(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
  });
});
