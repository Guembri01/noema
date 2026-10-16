import { describe, expect, it } from "vitest";
import {
  COLOR_TOKENS,
  describeRule,
  evaluateRule,
  isSafeColor,
  parseFormatRule,
  reorderRules,
  resolveRowStyle,
  toCss,
  validateFormatRule,
  type FormatProperty,
  type FormatRule,
  type FormatRow,
} from "./conditional-format";

/* Conditional formatting / row colour rules (docs/MISSING_FEATURES.md §3,
   "Conditional formatting" + "Row color rules").

   A `FormatRule` pairs a condition on one property with a style. The module is
   pure: no DB, no DOM. It parses untrusted config, validates it against the
   database schema, evaluates rules against a row, resolves the winning row
   style by priority, reorders rules and renders safe inline CSS. */

const properties: FormatProperty[] = [
  { id: "status", name: "Status", type: "STATUS" },
  { id: "estimate", name: "Estimate", type: "NUMBER" },
  { id: "name", name: "Name", type: "TEXT" },
  { id: "tags", name: "Tags", type: "MULTI_SELECT" },
  { id: "done", name: "Done", type: "CHECKBOX" },
];

const row = (values: Record<string, unknown>): FormatRow => ({
  propertyValues: Object.entries(values).map(([propertyId, value]) => ({
    propertyId,
    value,
  })),
});

const alpha = row({
  name: { text: "Alpha" },
  status: { optionId: "done" },
  estimate: { number: 5 },
  tags: { optionIds: ["web", "api"] },
  done: { checked: true },
});

const beta = row({
  name: { text: "Beta" },
  estimate: { number: 2 },
});

const rule = (overrides: Partial<FormatRule> = {}): FormatRule => ({
  id: "r1",
  target: "row",
  propertyId: "status",
  condition: { op: "is", value: "Done" },
  style: {},
  priority: 0,
  ...overrides,
});

describe("COLOR_TOKENS / isSafeColor", () => {
  it("exposes the palette allowlist", () => {
    expect(COLOR_TOKENS).toContain("green");
    expect(COLOR_TOKENS).toContain("red");
    expect(COLOR_TOKENS).not.toContain("magenta");
  });

  it("accepts named tokens and hex, rejects everything else", () => {
    expect(isSafeColor("blue")).toBe(true);
    expect(isSafeColor("#fff")).toBe(true);
    expect(isSafeColor("#16A34A")).toBe(true);
    expect(isSafeColor("red; background: url(x)")).toBe(false);
    expect(isSafeColor("var(--accent)")).toBe(false);
    expect(isSafeColor("expression(alert(1))")).toBe(false);
    expect(isSafeColor(42)).toBe(false);
  });
});

describe("parseFormatRule", () => {
  it("parses a full rule", () => {
    expect(
      parseFormatRule({
        id: "r1",
        name: "Overdue",
        enabled: false,
        target: "cell",
        propertyId: "status",
        condition: { op: "is_not", value: "Done" },
        style: { background: "red", text: "#fff", bold: true, italic: true },
        priority: 3,
      }),
    ).toStrictEqual({
      id: "r1",
      name: "Overdue",
      enabled: false,
      target: "cell",
      propertyId: "status",
      condition: { op: "is_not", value: "Done" },
      style: { background: "red", text: "#fff", bold: true, italic: true },
      priority: 3,
    });
  });

  it("defaults target to row and priority to 0", () => {
    const parsed = parseFormatRule({ id: "r1", condition: { op: "is_empty" } });
    expect(parsed).toStrictEqual({
      id: "r1",
      target: "row",
      condition: { op: "is_empty" },
      style: {},
      priority: 0,
    });
  });

  it("drops unsafe style values but keeps the rule", () => {
    const parsed = parseFormatRule({
      id: "r1",
      condition: { op: "is_empty" },
      style: { background: "red; background:url(x)", text: "green", bold: "yes" },
    });
    expect(parsed?.style).toStrictEqual({ text: "green" });
  });

  it("returns null without an id", () => {
    expect(parseFormatRule({ condition: { op: "is" } })).toBeNull();
    expect(parseFormatRule({ id: "  ", condition: { op: "is" } })).toBeNull();
  });

  it("returns null for an unknown operator", () => {
    expect(parseFormatRule({ id: "r1", condition: { op: "matches_regex" } })).toBeNull();
  });

  it("returns null for non-objects", () => {
    expect(parseFormatRule(null)).toBeNull();
    expect(parseFormatRule("r1")).toBeNull();
    expect(parseFormatRule([{ id: "r1" }])).toBeNull();
  });
});

describe("validateFormatRule", () => {
  it("accepts a well-formed rule", () => {
    const result = validateFormatRule(rule({ style: { background: "green" } }), { properties });
    expect(result.valid).toBe(true);
    expect(result.issues).toStrictEqual([]);
  });

  it("flags an unknown property", () => {
    const result = validateFormatRule(rule({ propertyId: "ghost" }), { properties });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("unknown_property");
  });

  it("flags a missing property on a cell rule", () => {
    const result = validateFormatRule(rule({ target: "cell", propertyId: undefined }), { properties });
    expect(result.issues.map((issue) => issue.code)).toContain("unknown_property");
  });

  it("flags an unknown operator", () => {
    const bad = rule();
    // Simulate untrusted JSON reaching validation.
    bad.condition = { op: "approximately" as never };
    const result = validateFormatRule(bad, { properties });
    expect(result.issues.map((issue) => issue.code)).toContain("unknown_operator");
  });

  it("flags dangerous style values", () => {
    const result = validateFormatRule(
      rule({ style: { background: "url(evil)", text: "javascript:alert(1)" } }),
      { properties },
    );
    const codes = result.issues.map((issue) => issue.code);
    expect(codes.filter((code) => code === "dangerous_style")).toHaveLength(2);
  });

  it("flags non-boolean bold/italic as dangerous", () => {
    const bad = rule();
    bad.style = { bold: "yes" as never, italic: 1 as never };
    const result = validateFormatRule(bad, { properties });
    expect(result.issues.filter((issue) => issue.code === "dangerous_style")).toHaveLength(2);
  });

  it("flags a duplicate priority among sibling rules", () => {
    const candidate = rule({ id: "new", priority: 1 });
    const result = validateFormatRule(candidate, {
      properties,
      rules: [rule({ id: "a", priority: 1 }), rule({ id: "b", priority: 2 })],
    });
    expect(result.issues.map((issue) => issue.code)).toContain("duplicate_priority");
  });

  it("ignores the rule itself and distinct priorities", () => {
    const candidate = rule({ id: "a", priority: 1 });
    const result = validateFormatRule(candidate, {
      properties,
      rules: [candidate, rule({ id: "b", priority: 2 })],
    });
    expect(result.valid).toBe(true);
  });
});

describe("evaluateRule", () => {
  it("matches `is` case-insensitively against an option id", () => {
    expect(evaluateRule(rule({ condition: { op: "is", value: "done" } }), alpha)).toBe(true);
    expect(evaluateRule(rule({ condition: { op: "is", value: "todo" } }), alpha)).toBe(false);
  });

  it("matches `is_not`", () => {
    expect(evaluateRule(rule({ condition: { op: "is_not", value: "todo" } }), alpha)).toBe(true);
    expect(evaluateRule(rule({ condition: { op: "is_not", value: "done" } }), alpha)).toBe(false);
  });

  it("matches `contains` on text", () => {
    expect(
      evaluateRule(rule({ propertyId: "name", condition: { op: "contains", value: "lph" } }), alpha),
    ).toBe(true);
    expect(
      evaluateRule(rule({ propertyId: "name", condition: { op: "contains", value: "zzz" } }), alpha),
    ).toBe(false);
  });

  it("matches `contains` by membership on a multi-select", () => {
    expect(
      evaluateRule(rule({ propertyId: "tags", condition: { op: "contains", value: "api" } }), alpha),
    ).toBe(true);
    expect(
      evaluateRule(rule({ propertyId: "tags", condition: { op: "contains", value: "sql" } }), alpha),
    ).toBe(false);
  });

  it("handles is_empty / is_not_empty", () => {
    expect(evaluateRule(rule({ propertyId: "tags", condition: { op: "is_empty" } }), beta)).toBe(true);
    expect(evaluateRule(rule({ propertyId: "tags", condition: { op: "is_not_empty" } }), alpha)).toBe(true);
  });

  it("compares numbers with gt / lte", () => {
    expect(
      evaluateRule(rule({ propertyId: "estimate", condition: { op: "gt", value: "3" } }), alpha),
    ).toBe(true);
    expect(
      evaluateRule(rule({ propertyId: "estimate", condition: { op: "lte", value: "3" } }), alpha),
    ).toBe(false);
  });

  it("never matches a disabled rule", () => {
    expect(evaluateRule(rule({ enabled: false }), alpha)).toBe(false);
  });

  it("treats a missing property value as empty and not-equal", () => {
    expect(evaluateRule(rule({ propertyId: "status", condition: { op: "is_empty" } }), beta)).toBe(true);
    expect(evaluateRule(rule({ propertyId: "status", condition: { op: "is", value: "done" } }), beta)).toBe(false);
  });

  it("uses a custom propertyValueFor extractor", () => {
    const custom = { id: "x" };
    const seen = evaluateRule(
      rule({ propertyId: "whatever", condition: { op: "is", value: "hot" } }),
      custom,
      { propertyValueFor: () => ({ text: "Hot" }) },
    );
    expect(seen).toBe(true);
  });
});

describe("resolveRowStyle", () => {
  const greenBold = rule({
    id: "green",
    priority: 1,
    condition: { op: "is", value: "done" },
    style: { background: "green", bold: true },
  });
  const redThin = rule({
    id: "red",
    priority: 2,
    condition: { op: "is", value: "done" },
    style: { background: "red" },
  });

  it("lets the first matching rule by priority win", () => {
    const resolved = resolveRowStyle([redThin, greenBold], alpha);
    expect(resolved.style).toStrictEqual({ background: "green", bold: true });
  });

  it("ignores cell-target rules", () => {
    const cell = rule({
      id: "cell",
      target: "cell",
      priority: 0,
      condition: { op: "is", value: "done" },
      style: { background: "blue" },
    });
    const resolved = resolveRowStyle([cell, greenBold], alpha);
    expect(resolved.style).toStrictEqual({ background: "green", bold: true });
    expect(resolved.matchedRuleIds).not.toContain("cell");
  });

  it("collects every matching row rule id in priority order", () => {
    const resolved = resolveRowStyle([redThin, greenBold], alpha);
    expect(resolved.matchedRuleIds).toStrictEqual(["green", "red"]);
  });

  it("skips disabled rules", () => {
    const resolved = resolveRowStyle([{ ...greenBold, enabled: false }, redThin], alpha);
    expect(resolved.style).toStrictEqual({ background: "red" });
    expect(resolved.matchedRuleIds).toStrictEqual(["red"]);
  });

  it("returns an empty style when nothing matches", () => {
    expect(resolveRowStyle([greenBold], beta)).toStrictEqual({ style: {}, matchedRuleIds: [] });
  });

  it("returns a fresh style object, not the rule's reference", () => {
    const resolved = resolveRowStyle([greenBold], alpha);
    expect(resolved.style).not.toBe(greenBold.style);
  });
});

describe("reorderRules", () => {
  const a = rule({ id: "a", priority: 0 });
  const b = rule({ id: "b", priority: 1 });
  const c = rule({ id: "c", priority: 2 });

  it("moves a rule and reassigns priorities to match order", () => {
    const next = reorderRules([a, b, c], "c", 0);
    expect(next.map((r) => r.id)).toStrictEqual(["c", "a", "b"]);
    expect(next.map((r) => r.priority)).toStrictEqual([0, 1, 2]);
  });

  it("clamps an out-of-range index", () => {
    expect(reorderRules([a, b, c], "a", 99).map((r) => r.id)).toStrictEqual(["b", "c", "a"]);
    expect(reorderRules([a, b, c], "c", -5).map((r) => r.id)).toStrictEqual(["c", "a", "b"]);
  });

  it("returns a copy when the id is unknown", () => {
    const input = [a, b];
    const next = reorderRules(input, "ghost", 0);
    expect(next).toStrictEqual(input);
    expect(next).not.toBe(input);
  });

  it("does not mutate the input array", () => {
    const input = [a, b, c];
    reorderRules(input, "b", 0);
    expect(input.map((r) => r.id)).toStrictEqual(["a", "b", "c"]);
  });
});

describe("describeRule", () => {
  it("describes an equality rule with its value", () => {
    expect(describeRule(rule(), { propertyName: "Status" })).toBe(
      'When Status is "Done" → row: no style',
    );
  });

  it("describes a contains rule by property name", () => {
    expect(
      describeRule(rule({ propertyId: "tags", condition: { op: "contains", value: "web" } }), {
        propertyName: "Tags",
      }),
    ).toBe('When Tags contains "web" → row: no style');
  });

  it("omits the value for empty operators", () => {
    expect(
      describeRule(rule({ condition: { op: "is_empty" } }), { propertyName: "Status" }),
    ).toBe("When Status is empty → row: no style");
  });

  it("summarises the style and the target", () => {
    expect(
      describeRule(
        rule({
          target: "cell",
          style: { background: "green", text: "blue", bold: true },
        }),
        { propertyName: "Status" },
      ),
    ).toBe('When Status is "Done" → cell: background green, text blue, bold');
  });

  it("marks disabled rules and prefixes the name", () => {
    expect(describeRule(rule({ name: "Overdue", enabled: false }), { propertyName: "Status" })).toBe(
      'Overdue: When Status is "Done" → row: no style (disabled)',
    );
  });
});

describe("toCss", () => {
  it("renders safe inline declarations", () => {
    expect(toCss({ background: "green", text: "#fff", bold: true, italic: true })).toBe(
      "background-color:green;color:#fff;font-weight:700;font-style:italic",
    );
  });

  it("drops unsafe values and non-true booleans", () => {
    expect(toCss({ background: "url(evil)", text: "blue", bold: "yes" as never })).toBe("color:blue");
  });

  it("returns an empty string for an empty style", () => {
    expect(toCss({})).toBe("");
    expect(toCss(undefined)).toBe("");
  });
});
