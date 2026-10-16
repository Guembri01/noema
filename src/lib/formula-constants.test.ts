import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONSTANTS,
  MAX_CONSTANT_NAME_LENGTH,
  collectConstants,
  resolveConstants,
  validateConstantName,
  type NamedConstant,
} from "@/lib/formula-constants";
import { evaluateFormula, type FormulaValue } from "@/lib/formula";

const REGISTRY: NamedConstant[] = [
  { name: "TaxRate", value: 0.2 },
  { name: "Currency", value: "$" },
  { name: "Enabled", value: true },
  { name: "Rates", value: [0.1, 0.2] },
];

const resolve = (expression: string, constants: readonly NamedConstant[]) => {
  const result = resolveConstants(expression, constants);
  return result.ok ? result.expression : `ERR:${result.error}`;
};

const evaluate = (expression: string, scope: Record<string, FormulaValue> = {}) => {
  const result = evaluateFormula(expression, scope);
  return result.ok ? result.value : `ERR:${result.error}`;
};

describe("validateConstantName", () => {
  it("accepts identifier-shaped names", () => {
    for (const name of ["Rate", "tax_rate", "_hidden", "A1", "x"]) {
      expect(validateConstantName(name)).toEqual({ ok: true });
    }
  });

  it("accepts a name at the maximum length and rejects one past it", () => {
    expect(validateConstantName("a".repeat(MAX_CONSTANT_NAME_LENGTH))).toEqual({ ok: true });
    const tooLong = validateConstantName("a".repeat(MAX_CONSTANT_NAME_LENGTH + 1));
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.error).toContain("too long");
  });

  it("rejects empty and non-string names", () => {
    for (const bad of ["", "   ", null, undefined, 42, {}, []]) {
      const result = validateConstantName(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("non-empty string");
    }
  });

  it("rejects names with whitespace", () => {
    for (const bad of [" tax", "tax ", "tax rate", "tax\trate"]) {
      expect(validateConstantName(bad).ok).toBe(false);
    }
  });

  it("rejects a leading digit", () => {
    const result = validateConstantName("1rate");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("start with a letter or underscore");
  });

  it("rejects punctuation", () => {
    const result = validateConstantName("tax-rate");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("letters, digits and underscores");
  });

  it("rejects reserved words regardless of case", () => {
    for (const bad of ["true", "FALSE", "now", "Today", "item", "index"]) {
      const result = validateConstantName(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("reserved");
    }
  });

  it("rejects built-in function names regardless of case", () => {
    for (const bad of ["max", "Abs", "prop", "FiltER"]) {
      const result = validateConstantName(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("built-in function");
    }
  });
});

describe("collectConstants", () => {
  it("collects bare identifiers in first-seen order", () => {
    expect(collectConstants("TaxRate + Currency + TaxRate")).toEqual(["TaxRate", "Currency"]);
  });

  it("dedupes case-insensitively, keeping the first spelling", () => {
    expect(collectConstants("PI + pi + Pi")).toEqual(["PI"]);
  });

  it("ignores identifiers inside string literals", () => {
    expect(collectConstants("prop(\"TaxRate\") + 'Currency'")).toEqual([]);
    expect(collectConstants('"TaxRate" + TaxRate')).toEqual(["TaxRate"]);
  });

  it("ignores escaped quotes inside string literals", () => {
    expect(collectConstants('"a \\" b" + Real')).toEqual(["Real"]);
  });

  it("ignores function-call names, even with whitespace", () => {
    expect(collectConstants("max(1, 2) + round (TaxRate)")).toEqual(["TaxRate"]);
  });

  it("ignores keywords and engine-scoped names", () => {
    expect(collectConstants("true + false + now + today + item + index")).toEqual([]);
  });

  it("returns an empty list for blank input", () => {
    expect(collectConstants("")).toEqual([]);
    expect(collectConstants("   ")).toEqual([]);
  });

  it("keeps unknown identifiers and does not descend into map expressions", () => {
    expect(collectConstants("fare + TaxRate")).toEqual(["fare", "TaxRate"]);
    expect(collectConstants('map(list, "item + TaxRate")')).toEqual(["list"]);
  });
});

describe("resolveConstants", () => {
  it("substitutes numbers, strings and booleans as literals", () => {
    expect(resolve("TaxRate * total", REGISTRY)).toBe("0.2 * total");
    expect(resolve("Currency + name", REGISTRY)).toBe('"$" + name');
    expect(resolve("Enabled && ok", REGISTRY)).toBe("true && ok");
  });

  it("matches names case-insensitively", () => {
    expect(resolve("taxrate + TAXRATE", REGISTRY)).toBe("0.2 + 0.2");
  });

  it("leaves unknown identifiers untouched", () => {
    expect(resolve("VAT * TaxRate", REGISTRY)).toBe("VAT * 0.2");
  });

  it("does not substitute inside string literals", () => {
    expect(resolve('prop("TaxRate") + TaxRate', REGISTRY)).toBe('prop("TaxRate") + 0.2');
  });

  it("serializes list values recursively", () => {
    expect(resolve("Rates", REGISTRY)).toBe("[0.1, 0.2]");
    expect(resolve("Nested", [{ name: "Nested", value: [1, [2, 3]] }])).toBe("[1, [2, 3]]");
  });

  it("ignores registry entries with invalid names", () => {
    const registry: NamedConstant[] = [
      { name: "1bad", value: 1 },
      { name: "ok", value: 2 },
    ];
    expect(resolve("1bad + ok", registry)).toBe("1bad + 2");
  });

  it("lets later entries win for case-insensitive duplicates", () => {
    const registry: NamedConstant[] = [
      { name: "Rate", value: 1 },
      { name: "rate", value: 2 },
    ];
    expect(resolve("Rate", registry)).toBe("2");
  });

  it("does not mutate its registry", () => {
    const registry: NamedConstant[] = [{ name: "Rate", value: 1 }];
    const snapshot = JSON.stringify(registry);
    resolveConstants("Rate", registry);
    expect(JSON.stringify(registry)).toBe(snapshot);
  });

  it("handles an empty expression", () => {
    expect(resolveConstants("", REGISTRY)).toEqual({ ok: true, expression: "" });
    expect(resolveConstants("   ", REGISTRY)).toEqual({ ok: true, expression: "   " });
  });

  it("expands exponent-notation numbers into plain decimals", () => {
    expect(resolve("Small", [{ name: "Small", value: 1e-7 }])).toBe("0.0000001");
    const huge = resolveConstants("Huge", [{ name: "Huge", value: 1e21 }]);
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect(huge.error).toContain("unsupported");
  });

  it("reports unsupported values instead of emitting them", () => {
    const result = resolveConstants("Bad", [{ name: "Bad", value: {} as unknown as FormulaValue }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("unsupported");
  });

  it("round-trips through the formula engine", () => {
    const tax = evaluate(resolve("TaxRate * amount", REGISTRY), { amount: 50 });
    expect(tax).toBeCloseTo(10, 10);
    expect(evaluate(resolve("Currency + total", REGISTRY), { total: 5 })).toBe("$5");
    expect(evaluate(resolve("Delta + x", [{ name: "Delta", value: -5 }]), { x: 10 })).toBe(5);
    const escaped = resolveConstants("label", [{ name: "label", value: 'He said "hi"\\path' }]);
    expect(escaped.ok).toBe(true);
    if (escaped.ok) expect(evaluate(escaped.expression)).toBe('He said "hi"\\path');
  });
});

describe("DEFAULT_CONSTANTS", () => {
  it("holds valid, case-insensitively unique names", () => {
    const seen = new Set<string>();
    for (const constant of DEFAULT_CONSTANTS) {
      expect(validateConstantName(constant.name)).toEqual({ ok: true });
      const key = constant.name.toLowerCase();
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("exposes evaluable math constants", () => {
    const pi = DEFAULT_CONSTANTS.find((entry) => entry.name === "PI");
    expect(pi?.value).toBe(Math.PI);
    const resolved = resolveConstants("PI * r * r", DEFAULT_CONSTANTS);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      const result = evaluate(resolved.expression, { r: 2 });
      expect(typeof result).toBe("number");
      if (typeof result === "number") expect(result).toBeCloseTo(Math.PI * 4, 10);
    }
  });
});
