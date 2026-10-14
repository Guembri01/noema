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

  it("rejects over-deep expressions with a controlled error", () => {
    const deep = "(".repeat(3000) + "1" + ")".repeat(3000);
    const result = evaluateFormula(deep);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/nested too deeply/i);
  });

  it("rejects over-long expressions instead of parsing them", () => {
    expect(value("1+".repeat(6000) + "1")).toContain("ERR:");
  });

  it("rejects malformed syntax with a controlled error", () => {
    expect(value("1 + * 2")).toContain("ERR:");
    expect(value(")")).toContain("ERR:");
    expect(value("1 2")).toContain("ERR:");
    expect(value("1 + 2)")).toContain("ERR:");
    expect(value('prop("Estimate"')).toContain("ERR:");
    expect(value(",,")).toContain("ERR:");
    expect(value('"unterminated')).toContain("ERR:");
    expect(value("'unterminated")).toContain("ERR:");
  });

  it("rejects unknown functions and identifiers", () => {
    expect(value('missingFn()')).toContain("ERR:");
    expect(value("SUM(1, 2)")).toContain("ERR:");
    expect(value("someProperty")).toContain("ERR:");
    expect(value('prop("Estimate") + nope("x")', { Estimate: 1 })).toContain("ERR:");
  });

  it("handles string operands", () => {
    expect(value('concat("a", 1, true)')).toBe("a1true");
    expect(value("length(42)")).toBe(2);
    expect(value("upper(true)")).toBe("TRUE");
    expect(value('"a" + 1')).toBe("a1");
    expect(value('1 + "a"')).toBe("1a");
    expect(value('"x" == "x"')).toBe(true);
    expect(value('"a\\"b"')).toBe('a"b');
    expect(value("'single'")).toBe("single");
    expect(value('contains("Hello", "hello")')).toBe(true);
  });

  it("handles boolean operands", () => {
    expect(value('if("no", "y", "n")')).toBe("y");
    expect(value('if(0, "y", "n")')).toBe("n");
    expect(value('if(prop("Flag"), 1, 2)')).toBe(2);
    expect(value('!""')).toBe(true);
    expect(value('!"text"')).toBe(false);
    expect(value("true && !false")).toBe(true);
    expect(value("empty(true)")).toBe(false);
  });

  it("treats missing properties as empty strings", () => {
    expect(value('prop("Ghost")')).toBe("");
    expect(value('empty(prop("Ghost"))')).toBe(true);
    expect(value('concat(prop("Ghost"), "end")')).toBe("end");
    expect(value('prop("ghost")', { Ghost: "boo" })).toBe("boo");
  });

  it("parses nested parentheses", () => {
    expect(value("((((1 + 2)))) * 2")).toBe(6);
    expect(value("(1 + 2) * (3 + 4)")).toBe(21);
    expect(value("((true))")).toBe(true);
    expect(value('if((1 < 2) && (2 < 3), "in", "out")')).toBe("in");
  });

  it("respects operator precedence", () => {
    expect(value("2 * 3 + 4 * 5")).toBe(26);
    expect(value("10 - 3 - 2")).toBe(5);
    expect(value("8 / 4 / 2")).toBe(1);
    expect(value("-2 * 3 + 1")).toBe(-5);
    expect(value("2 + 3 * 4 == 14 && 1 < 2")).toBe(true);
    expect(value("true || false && false")).toBe(true);
    expect(value("1 + 2 == 3")).toBe(true);
    expect(value("!(1 == 1) || 1 < 2")).toBe(true);
  });
});
