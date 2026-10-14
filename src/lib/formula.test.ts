import { describe, expect, it } from "vitest";
import { evaluateFormula } from "@/lib/formula";

const value = (expression: string, scope = {}) => {
  const result = evaluateFormula(expression, scope);
  return result.ok ? result.value : `ERR:${result.error}`;
};

describe("formula engine", () => {
  it("does arithmetic with precedence", () => {
    expect(value("1 + 2 * 3")).toBe(7);
    expect(value("(1 + 2) * 3")).toBe(9);
    expect(value("10 % 3")).toBe(1);
    expect(value("-4 + 1")).toBe(-3);
  });

  it("compares and combines booleans", () => {
    expect(value("5 > 3")).toBe(true);
    expect(value("5 <= 3")).toBe(false);
    expect(value("1 == 1 && 2 > 1")).toBe(true);
    expect(value("1 == 2 || 2 > 1")).toBe(true);
    expect(value("!(1 == 2)")).toBe(true);
  });

  it("references properties", () => {
    expect(value('prop("Estimate") * 2', { Estimate: 5 })).toBe(10);
    expect(value('concat(prop("Name"), "!")', { Name: "Ada" })).toBe("Ada!");
    expect(value('upper(prop("Name"))', { Name: "ada" })).toBe("ADA");
  });

  it("supports string concatenation with +", () => {
    expect(value('"a" + "b"')).toBe("ab");
  });

  it("implements helper functions", () => {
    expect(value('if(prop("Done"), "yes", "no")', { Done: true })).toBe("yes");
    expect(value('length("hello")')).toBe(5);
    expect(value('contains("Hello world", "WORLD")')).toBe(true);
    expect(value('empty("")')).toBe(true);
    expect(value('round(3.14159, 2)')).toBe(3.14);
    expect(value('min(3, 1, 2)')).toBe(1);
    expect(value('max(3, 1, 2)')).toBe(3);
    expect(value('abs(-7)')).toBe(7);
  });

  it("reports errors instead of throwing", () => {
    expect(value("1 +")).toContain("ERR:");
    expect(value('nope("x")')).toContain("ERR:");
    expect(value("")).toContain("ERR:");
    expect(value("(1 + 2")).toContain("ERR:");
  });
});
