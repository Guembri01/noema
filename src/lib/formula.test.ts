import { describe, expect, it, vi } from "vitest";
import { evaluateFormula, type FormulaOptions, type FormulaScope } from "@/lib/formula";

const run = (expression: string, scope: FormulaScope = {}, constants?: Record<string, unknown>) =>
  evaluateFormula(expression, scope, constants ? { constants } : {});

const value = (expression: string, scope: FormulaScope = {}, constants?: Record<string, unknown>) => {
  const result = run(expression, scope, constants);
  return result.ok ? result.value : `ERR:${result.error}`;
};

const errorOf = (
  expression: string,
  scope: FormulaScope = {},
  constants?: Record<string, unknown>,
) => {
  const result = run(expression, scope, constants);
  return result.ok ? `OK:${JSON.stringify(result.value)}` : result.error;
};

const valueWith = (
  expression: string,
  scope: FormulaScope = {},
  options: FormulaOptions = {},
) => {
  const result = evaluateFormula(expression, scope, options);
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

describe("formula error states", () => {
  it("returns friendly #ERROR results for division by zero", () => {
    expect(errorOf("1 / 0")).toBe("#ERROR: division by zero");
    expect(errorOf("0 / 0")).toBe("#ERROR: division by zero");
    expect(errorOf("5 % 0")).toBe("#ERROR: division by zero");
    expect(errorOf("1 / 0 + 5")).toBe("#ERROR: division by zero");
  });

  it("names unknown functions and identifiers", () => {
    expect(errorOf('nope("x")')).toBe("#ERROR: unknown function 'nope'");
    expect(errorOf("someProperty")).toBe("#ERROR: unknown identifier 'someProperty'");
    expect(errorOf('prop("Estimate") + nope("x")', { Estimate: 1 })).toBe(
      "#ERROR: unknown function 'nope'",
    );
  });

  it("reports type mismatches for non-numeric arithmetic", () => {
    expect(errorOf('"abc" - 1')).toBe("#ERROR: type mismatch");
    expect(errorOf('"abc" * 2')).toBe("#ERROR: type mismatch");
    expect(errorOf('-"abc"')).toBe("#ERROR: type mismatch");
  });

  it("prefixes syntax errors with #ERROR", () => {
    expect(errorOf("1 +")).toContain("#ERROR:");
    expect(errorOf("(1 + 2")).toContain("#ERROR:");
    expect(errorOf("1 + * 2")).toContain("#ERROR:");
    expect(errorOf('prop("Estimate"')).toContain("#ERROR:");
    expect(errorOf('"unterminated')).toContain("#ERROR:");
  });

  it("propagates error values through operators and functions", () => {
    expect(errorOf("!(1 / 0)")).toBe("#ERROR: division by zero");
    expect(errorOf("1 == 1 / 0")).toBe("#ERROR: division by zero");
    expect(errorOf("1 / 0 > 3")).toBe("#ERROR: division by zero");
    expect(errorOf('upper(nope("x"))')).toBe("#ERROR: unknown function 'nope'");
    expect(errorOf("if(1 / 0, 1, 2)")).toBe("#ERROR: division by zero");
  });

  it("ignores errors from untaken if() branches", () => {
    expect(value("if(false, 1 / 0, 2)")).toBe(2);
    expect(value("if(true, 1, 1 / 0)")).toBe(1);
  });

  it("keeps every failure structured as { ok: false, error }", () => {
    const divZero = evaluateFormula("1 / 0");
    expect(divZero.ok).toBe(false);
    if (!divZero.ok) expect(divZero.error).toBe("#ERROR: division by zero");
    const syntax = evaluateFormula("1 +");
    expect(syntax.ok).toBe(false);
    if (!syntax.ok) expect(syntax.error.startsWith("#ERROR:")).toBe(true);
  });
});

describe("regex functions", () => {
  it("matches text against patterns", () => {
    expect(value('match("Hello", "Hello")')).toBe(true);
    expect(value('match("Hello", "hello")')).toBe(false);
    expect(value('match("Hello", "[Hh]ello")')).toBe(true);
    expect(value('match("abc", "a.c")')).toBe(true);
  });

  it("replaces plain and regex matches", () => {
    expect(value('replace("John Michael", "Michael", "Jack")')).toBe("John Jack");
    expect(value('replace("a1b2", "\\\\d+", "#")')).toBe("a#b#");
    expect(value('replace("John Michael", "(\\\\w+) (\\\\w+)", "$2 $1")')).toBe("Michael John");
    expect(value('replace("abc", "x*", "-")')).toBe("-a-b-c-");
  });

  it("extracts capture groups", () => {
    expect(value('extract("2024-01-15", "(\\\\d+)-(\\\\d+)-(\\\\d+)")')).toEqual([
      "2024",
      "01",
      "15",
    ]);
    expect(value('extract("abc", "b")')).toEqual(["b"]);
    expect(value('extract("hello", "xyz")')).toEqual([]);
    expect(value('join(extract("a1b2", "(\\\\w)(\\\\d)"), "-")')).toBe("a-1-b-2");
  });

  it("rejects invalid patterns with a friendly error", () => {
    expect(errorOf('match("abc", "[")')).toContain("#ERROR: invalid pattern");
    expect(errorOf('replace("abc", "(", "x")')).toContain("#ERROR: invalid pattern");
  });

  it("caps regex pattern and text length", () => {
    expect(errorOf(`match("aaa", "${"a".repeat(201)}")`)).toContain(
      "pattern exceeds maximum length",
    );
    expect(errorOf(`match("${"a".repeat(5001)}", "a")`)).toContain("text exceeds maximum length");
  });

  it("rejects patterns prone to catastrophic backtracking", () => {
    expect(errorOf('match("aaaaaaaaaaaaaaaaaaaa!", "(a+)+$")')).toContain(
      "catastrophic backtracking",
    );
    expect(errorOf('match("aaaaaaaaaaaaaaaaaaaa!", "(x*)*y")')).toContain(
      "catastrophic backtracking",
    );
  });

  it("rejects alternation blowups like (a|aa)+", () => {
    expect(errorOf('match("aaaaaaaaaaaaaaaaaaaa!", "(a|aa)+$")')).toContain(
      "catastrophic backtracking",
    );
    expect(errorOf('replace("aaaaaaaaaaaaaaaaaaaa!", "(a|aa)+$", "x")')).toContain(
      "catastrophic backtracking",
    );
    expect(errorOf('extract("aaaaaaaaaaaaaaaaaaaa!", "(a|aa)+$")')).toContain(
      "catastrophic backtracking",
    );
  });

  it("aborts a regex whose work does not fit into the time budget", () => {
    const text = "a".repeat(1000);
    expect(errorOf(`match("${text}", "a*a*b")`)).toBe(
      "#ERROR: pattern rejected: the estimated work exceeds the 50 ms regex budget",
    );
    expect(errorOf(`replace("${text}", "a*a*b", "x")`)).toContain("budget");
    expect(errorOf(`extract("${text}", "a*a*b")`)).toContain("budget");
  });

  it("aborts a regex evaluation that overruns the wall-clock budget", () => {
    // The clock is pinned so the evaluation is measured as if it took 100 ms.
    const now = vi.spyOn(Date, "now").mockReturnValue(100).mockReturnValueOnce(0);
    try {
      expect(errorOf('match("Budget", "[Bb]udget")')).toBe(
        "#ERROR: regex evaluation exceeded the 50 ms budget",
      );
    } finally {
      now.mockRestore();
    }
  });

  it("keeps a normal regex inside the time budget", () => {
    expect(value('match("Hello", "[Hh]ello")')).toBe(true);
    expect(value('replace("John Michael", "(\\\\w+) (\\\\w+)", "$2 $1")')).toBe("Michael John");
    expect(value('extract("2024-01-15", "(\\\\d+)-(\\\\d+)-(\\\\d+)")')).toEqual([
      "2024",
      "01",
      "15",
    ]);
    // A long text is still evaluated when the pattern cannot blow up.
    expect(value(`match("${"a".repeat(1000)}", "a*b")`)).toBe(false);
  });

  it("allows safe quantified groups", () => {
    expect(value('match("abc", "([a-z]+)")')).toBe(true);
    expect(value('extract("2024", "\\\\d{4}")')).toEqual(["2024"]);
  });

  it("requires a pattern argument", () => {
    expect(errorOf('match("abc")')).toBe("#ERROR: type mismatch");
    expect(errorOf('replace("abc")')).toBe("#ERROR: type mismatch");
  });
});

describe("regex extraction with a group selector", () => {
  it("selects the first match's group by capture index", () => {
    expect(value('extract("2024-01-15", "(\\\\d+)-(\\\\d+)-(\\\\d+)", 2)')).toBe("01");
    expect(value('extract("user@example.com", "@([^@]+)$", 1)')).toBe("example.com");
    // Group 0 is the whole match.
    expect(value('extract("abc123", "\\\\d+", 0)')).toBe("123");
  });

  it("selects a named capture group", () => {
    expect(
      value(
        'extract("2024-01-15", "(?<year>\\\\d{4})-(?<month>\\\\d{2})-(?<day>\\\\d{2})", "month")',
      ),
    ).toBe("01");
    expect(value('extract("id-42", "id-(?<n>\\\\d+)", "n")')).toBe("42");
  });

  it("returns only the first match when a group is selected", () => {
    expect(value('extract("a1 b2", "(\\\\w)(\\\\d)", 1)')).toBe("a");
  });

  it("reads a non-participating or unmatched group as empty", () => {
    expect(value('extract("abc", "(x)?(a)", 1)')).toBe("");
    expect(value('extract("abc", "(\\\\d+)", 1)')).toBe("");
  });

  it("rejects unknown or invalid group selectors", () => {
    expect(errorOf('extract("abc", "(a)", 3)')).toBe("#ERROR: unknown capture group 3");
    expect(errorOf('extract("abc", "(a)", "nope")')).toBe(
      "#ERROR: unknown capture group 'nope'",
    );
    expect(errorOf('extract("abc", "(a)", -1)')).toBe("#ERROR: type mismatch");
    expect(errorOf('extract("abc", "(a)", 1.5)')).toBe("#ERROR: type mismatch");
  });

  it("keeps the no-group list behavior and the sandbox guarantees", () => {
    expect(value('extract("2024-01-15", "(\\\\d+)-(\\\\d+)-(\\\\d+)")')).toEqual([
      "2024",
      "01",
      "15",
    ]);
    expect(errorOf('extract("abc", "[")')).toContain("#ERROR: invalid pattern");
    expect(errorOf('extract("aaaaaaaaaaaaaaaaaaaa!", "(a+)+$", 1)')).toContain(
      "catastrophic backtracking",
    );
  });
});

describe("list functions", () => {
  it("joins lists with a separator", () => {
    expect(value('join([1, 2, 3], "-")')).toBe("1-2-3");
    expect(value('join(["a", "b"], ", ")')).toBe("a, b");
    expect(value("join([1, 2])")).toBe("12");
    expect(value('join([], ", ")')).toBe("");
  });

  it("sorts lists by value, then by type", () => {
    expect(value("sort([10, 2, 1])")).toEqual([1, 2, 10]);
    expect(value('sort(["b", "a"])')).toEqual(["a", "b"]);
    expect(value('sort([true, "b", 2, "a", 1])')).toEqual([1, 2, "a", "b", true]);
    expect(value("sort([])")).toEqual([]);
  });

  it("maps an expression over a list", () => {
    expect(value('map([1, 2, 3], "item * 2")')).toEqual([2, 4, 6]);
    expect(value('map([1, 2], "item + index")')).toEqual([1, 3]);
    expect(value('map([], "item")')).toEqual([]);
  });

  it("filters a list by an expression", () => {
    expect(value('filter([1, 2, 3, 4], "item % 2 == 0")')).toEqual([2, 4]);
    expect(value('filter(["a", "", "b"], "!empty(item)")')).toEqual(["a", "b"]);
  });

  it("composes list functions", () => {
    expect(value('join(map([1, 2, 3], "item * 2"), ", ")')).toBe("2, 4, 6");
    expect(value('length(filter(map([1, 2, 3], "item * 2"), "item > 2"))')).toBe(2);
    expect(value("length([1, 2, 3])")).toBe(3);
  });

  it("maps over nested lists", () => {
    expect(value("map([[1, 2], [3]], 'join(item, \"+\")')")).toEqual(["1+2", "3"]);
  });

  it("rejects non-list arguments with type mismatches", () => {
    expect(errorOf('sort("abc")')).toBe("#ERROR: type mismatch");
    expect(errorOf('map(42, "item")')).toBe("#ERROR: type mismatch");
    expect(errorOf('filter(5, "item")')).toBe("#ERROR: type mismatch");
    expect(errorOf('join("x", ",")')).toBe("#ERROR: type mismatch");
  });

  it("requires string expressions for map and filter", () => {
    expect(errorOf("map([1, 2], 5)")).toBe("#ERROR: type mismatch");
    expect(errorOf("filter([1, 2], false)")).toBe("#ERROR: type mismatch");
  });

  it("propagates errors out of list literals and nested expressions", () => {
    expect(errorOf("[1, 1 / 0]")).toBe("#ERROR: division by zero");
    expect(errorOf('join([1 / 0, 2], ",")')).toBe("#ERROR: division by zero");
    expect(errorOf('map([0, 1], "1 / item")')).toBe("#ERROR: division by zero");
  });

  it("bounds nested expression evaluation depth", () => {
    let nested = "item";
    for (let i = 0; i < 10; i += 1) {
      nested = `map([1], "${nested.replace(/[\\"]/g, (char) => `\\${char}`)}")`;
    }
    expect(errorOf(nested)).toMatch(/nested too deeply/i);
  });
});

describe("named constants", () => {
  it("resolves constants by name", () => {
    expect(value("PI * 2", {}, { PI: 3.14 })).toBe(6.28);
    expect(value('concat(GREETING, " world")', {}, { GREETING: "hello" })).toBe("hello world");
    expect(value("ACTIVE", {}, { ACTIVE: true })).toBe(true);
  });

  it("resolves constants case-insensitively", () => {
    expect(value("tax_rate", {}, { TAX_RATE: 0.2 })).toBe(0.2);
  });

  it("supports list constants", () => {
    expect(value('join(LETTERS, "-")', {}, { LETTERS: ["a", "b", "c"] })).toBe("a-b-c");
    expect(value('map(PRICES, "item * 2")', {}, { PRICES: [1, 10] })).toEqual([2, 20]);
  });

  it("exposes constants to nested map and filter expressions", () => {
    expect(value('map([1, 2], "item + FEE")', {}, { FEE: 10 })).toEqual([11, 12]);
    expect(value('filter([1, 2], "item < LIMIT")', {}, { LIMIT: 2 })).toEqual([1]);
  });

  it("treats nullish constants as empty values", () => {
    expect(value("empty(Settings)", {}, { Settings: null })).toBe(true);
  });

  it("errors on unknown identifiers and non-value constants", () => {
    expect(errorOf("Budget", {}, { Tax: 0.2 })).toBe("#ERROR: unknown identifier 'Budget'");
    expect(errorOf("Config", {}, { Config: { a: 1 } })).toBe("#ERROR: type mismatch");
  });

  it("keeps language keywords ahead of constants", () => {
    expect(value("true", {}, { true: "shadowed" })).toBe(true);
  });
});

describe("rollup-aware references", () => {
  it("resolves a typed rollup by name", () => {
    expect(valueWith('rollup("Total") * 2', {}, { rollups: { Total: 21 } })).toBe(42);
    expect(valueWith('rollup("Rate")', {}, { rollups: { Rate: "83%" } })).toBe("83%");
    expect(valueWith('rollup("Done")', {}, { rollups: { Done: true } })).toBe(true);
  });

  it("matches rollup names case-insensitively", () => {
    expect(valueWith('rollup("total")', {}, { rollups: { Total: 21 } })).toBe(21);
  });

  it("reads missing or nullish rollups as empty", () => {
    expect(valueWith('rollup("Ghost")', {}, { rollups: { Total: 1 } })).toBe("");
    expect(valueWith('rollup("Total")', {}, { rollups: { Total: null } })).toBe("");
    expect(valueWith('empty(rollup("Total"))', {}, { rollups: { Total: null } })).toBe(true);
  });

  it("falls back to the row scope when no typed rollup is provided", () => {
    expect(value('rollup("Total") + 1', { Total: 4 })).toBe(5);
  });

  it("composes with arithmetic and list results", () => {
    expect(valueWith('round(rollup("Total") * 100)', {}, { rollups: { Total: 0.83 } })).toBe(83);
    expect(
      valueWith('join(rollup("Tags"), "-")', {}, { rollups: { Tags: ["a", "b"] } }),
    ).toBe("a-b");
  });
});

describe("math functions", () => {
  it("rounds toward positive and negative infinity with ceil and floor", () => {
    expect(value("ceil(1.2)")).toBe(2);
    expect(value("ceil(-1.2)")).toBe(-1);
    expect(value("ceil(4)")).toBe(4);
    expect(value("ceil(0)")).toBe(0);
    expect(value("floor(1.8)")).toBe(1);
    expect(value("floor(-1.8)")).toBe(-2);
    expect(value("floor(0)")).toBe(0);
  });

  it("raises to a power and takes square roots", () => {
    expect(value("pow(2, 10)")).toBe(1024);
    expect(value("pow(5, 0)")).toBe(1);
    expect(value("pow(-2, 3)")).toBe(-8);
    expect(value("pow(0.5, 2)")).toBe(0.25);
    expect(value("sqrt(9)")).toBe(3);
    expect(value("sqrt(0)")).toBe(0);
    expect(value("round(sqrt(2), 4)")).toBe(1.4142);
  });

  it("keeps existing abs/round/min/max behavior", () => {
    expect(value("abs(-7)")).toBe(7);
    expect(value("abs(0)")).toBe(0);
    expect(value("round(3.14159, 2)")).toBe(3.14);
    expect(value("round(2.5)")).toBe(3);
    expect(value("min(3, 1, 2)")).toBe(1);
    expect(value("max(3, 1, 2)")).toBe(3);
  });

  it("returns error values for non-numeric or invalid math arguments", () => {
    expect(errorOf('ceil("abc")')).toBe("#ERROR: type mismatch");
    expect(errorOf('floor("abc")')).toBe("#ERROR: type mismatch");
    expect(errorOf('sqrt("abc")')).toBe("#ERROR: type mismatch");
    expect(errorOf('pow("abc", 2)')).toBe("#ERROR: type mismatch");
    expect(errorOf('pow(2, "abc")')).toBe("#ERROR: type mismatch");
    expect(errorOf("ceil()")).toBe("#ERROR: type mismatch");
    expect(errorOf("pow(2)")).toBe("#ERROR: type mismatch");
    expect(errorOf("sqrt(-4)")).toBe("#ERROR: type mismatch");
    expect(errorOf("ceil(1 / 0)")).toBe("#ERROR: division by zero");
  });
});

describe("text functions", () => {
  it("slices text with positive, negative and clamped indexes", () => {
    expect(value('slice("hello", 1, 3)')).toBe("el");
    expect(value('slice("hello", 2)')).toBe("llo");
    expect(value('slice("hello", 0)')).toBe("hello");
    expect(value('slice("hello", 3, 3)')).toBe("");
    expect(value('slice("hello", 4, 2)')).toBe("");
    expect(value('slice("hello", -3)')).toBe("llo");
    expect(value('slice("hello", 1, -1)')).toBe("ell");
    expect(value('slice("hello", -100, 100)')).toBe("hello");
    expect(value('slice("", 0, 3)')).toBe("");
    expect(value('slice("hello", 5)')).toBe("");
  });

  it("trims surrounding whitespace", () => {
    expect(value('trim("  padded  ")')).toBe("padded");
    expect(value('trim("padded")')).toBe("padded");
    expect(value('trim("   ")')).toBe("");
    expect(value("trim(42)")).toBe("42");
    expect(value("trim()")).toBe("");
  });

  it("keeps concat/upper/lower and the regex replace untouched", () => {
    expect(value('concat("a", 1, true)')).toBe("a1true");
    expect(value('upper(" mixed ")')).toBe(" MIXED ");
    expect(value('lower("MIXED")')).toBe("mixed");
    expect(value('replace("a1b2", "\\\\d+", "#")')).toBe("a#b#");
    expect(value('replace("John Michael", "(\\\\w+) (\\\\w+)", "$2 $1")')).toBe("Michael John");
  });

  it("rejects missing or non-numeric slice indexes", () => {
    expect(errorOf('slice("hello")')).toBe("#ERROR: type mismatch");
    expect(errorOf('slice("hello", "x")')).toBe("#ERROR: type mismatch");
    expect(errorOf('slice("hello", 1, "y")')).toBe("#ERROR: type mismatch");
    expect(errorOf('slice("hello", 1 / 0)')).toBe("#ERROR: division by zero");
  });
});

describe("logic functions (ifs)", () => {
  it("returns the first matching branch", () => {
    expect(value('ifs(1 > 2, "a", 2 > 1, "b", "c")')).toBe("b");
    expect(value('ifs(true, "yes", false, "no")')).toBe("yes");
    expect(value('ifs(1 == 1, "first", 1 == 1, "second")')).toBe("first");
    expect(value('ifs(false, "a", true, "b", "fallback")')).toBe("b");
  });

  it("uses the trailing fallback when no condition matches", () => {
    expect(value('ifs(false, 1, false, 2, "none")')).toBe("none");
    expect(value('ifs(false, "pair value", "fallback")')).toBe("fallback");
    expect(value("ifs(false, 1, 2)")).toBe(2);
    expect(value('ifs(true, "only")')).toBe("only");
  });

  it("errors when nothing matches and no fallback is given", () => {
    expect(errorOf("ifs(false, 1)")).toBe("#ERROR: no matching condition");
    expect(errorOf("ifs(false, 1, false, 2)")).toBe("#ERROR: no matching condition");
    expect(errorOf("ifs()")).toBe("#ERROR: type mismatch");
    expect(errorOf("ifs(true)")).toBe("#ERROR: type mismatch");
  });

  it("propagates errors only from conditions and branches it consults", () => {
    expect(errorOf('ifs(1 / 0, "a", true, "b")')).toBe("#ERROR: division by zero");
    expect(errorOf('ifs(true, 1 / 0, "b")')).toBe("#ERROR: division by zero");
    expect(value('ifs(true, "a", 1 / 0, "b")')).toBe("a");
    expect(value('ifs(false, 1 / 0, "taken")')).toBe("taken");
    expect(errorOf('ifs(1 / 0, "a")')).toBe("#ERROR: division by zero");
  });
});

describe("date functions", () => {
  it("parses and normalizes dates with date()", () => {
    expect(value('date("2024-01-15")')).toBe("2024-01-15T00:00:00.000Z");
    expect(value('date("2024-01-15T10:30:00")')).toBe("2024-01-15T10:30:00.000Z");
    expect(value('date("2024-01-15 10:30:00")')).toBe("2024-01-15T10:30:00.000Z");
    expect(value('date("2024-01-15T10:30:00Z")')).toBe("2024-01-15T10:30:00.000Z");
    expect(value('date("2024-01-15T10:30:00+02:00")')).toBe("2024-01-15T08:30:00.000Z");
    expect(value("date(0)")).toBe("1970-01-01T00:00:00.000Z");
  });

  it("rejects invalid or non-date inputs with error values", () => {
    expect(errorOf('date("not a date")')).toBe("#ERROR: invalid date");
    expect(errorOf('date("2024-02-30")')).toBe("#ERROR: invalid date");
    expect(errorOf('date("2024-13-01")')).toBe("#ERROR: invalid date");
    expect(errorOf('date("")')).toBe("#ERROR: invalid date");
    expect(errorOf("date(true)")).toBe("#ERROR: type mismatch");
    expect(errorOf("date([1])")).toBe("#ERROR: type mismatch");
    expect(errorOf("date()")).toBe("#ERROR: type mismatch");
  });

  it("adds days, weeks, hours and minutes", () => {
    expect(value('formatDate(dateAdd("2024-01-15", 3, "days"), "YYYY-MM-DD")')).toBe(
      "2024-01-18",
    );
    expect(value('formatDate(dateAdd("2024-01-28", 1, "weeks"), "YYYY-MM-DD")')).toBe(
      "2024-02-04",
    );
    expect(value('formatDate(dateAdd("2024-01-15T10:00:00Z", 90, "minutes"), "YYYY-MM-DD HH:mm")')).toBe(
      "2024-01-15 11:30",
    );
    expect(value('formatDate(dateAdd("2024-01-15", 5, "hours"), "YYYY-MM-DD HH:mm")')).toBe(
      "2024-01-15 05:00",
    );
    expect(value('formatDate(dateAdd("2024-01-15", -2, "days"), "YYYY-MM-DD")')).toBe(
      "2024-01-13",
    );
    expect(value('formatDate(dateAdd("2024-01-15", 0, "days"), "YYYY-MM-DD")')).toBe(
      "2024-01-15",
    );
    expect(value('dateAdd("2024-01-15", 1, "days")')).toBe("2024-01-16T00:00:00.000Z");
  });

  it("adds months and years calendar-safely across boundaries", () => {
    // Jan 31 + 1 month clamps into the short month instead of stepping 30 days.
    expect(value('formatDate(dateAdd("2024-01-31", 1, "months"), "YYYY-MM-DD")')).toBe(
      "2024-02-29",
    );
    expect(value('formatDate(dateAdd("2023-01-31", 1, "months"), "YYYY-MM-DD")')).toBe(
      "2023-02-28",
    );
    expect(value('formatDate(dateAdd("2024-03-31", -1, "months"), "YYYY-MM-DD")')).toBe(
      "2024-02-29",
    );
    expect(value('formatDate(dateAdd("2024-02-29", 1, "years"), "YYYY-MM-DD")')).toBe(
      "2025-02-28",
    );
    expect(value('formatDate(dateAdd("2024-12-15", 1, "months"), "YYYY-MM-DD")')).toBe(
      "2025-01-15",
    );
    expect(value('formatDate(dateAdd("2024-01-15", 14, "months"), "YYYY-MM-DD")')).toBe(
      "2025-03-15",
    );
  });

  it("subtracts units with dateSubtract", () => {
    expect(value('formatDate(dateSubtract("2024-03-01", 1, "days"), "YYYY-MM-DD")')).toBe(
      "2024-02-29",
    );
    expect(value('formatDate(dateSubtract("2024-03-01", 1, "months"), "YYYY-MM-DD")')).toBe(
      "2024-02-01",
    );
    expect(value('formatDate(dateSubtract("2024-01-01", 1, "years"), "YYYY-MM-DD")')).toBe(
      "2023-01-01",
    );
    expect(value('formatDate(dateSubtract("2024-01-15", -3, "days"), "YYYY-MM-DD")')).toBe(
      "2024-01-18",
    );
  });

  it("rejects invalid dateAdd/dateSubtract arguments", () => {
    expect(errorOf('dateAdd("not a date", 1, "days")')).toBe("#ERROR: invalid date");
    expect(errorOf('dateAdd("2024-01-15", "soon", "days")')).toBe("#ERROR: type mismatch");
    expect(errorOf('dateAdd("2024-01-15", 1)')).toBe("#ERROR: type mismatch");
    expect(errorOf('dateAdd(true, 1, "days")')).toBe("#ERROR: type mismatch");
    expect(errorOf('dateAdd("2024-01-15", 1, "fortnights")')).toBe(
      "#ERROR: unknown date unit 'fortnights'",
    );
    expect(errorOf('dateSubtract("2024-01-15", 1, "decades")')).toBe(
      "#ERROR: unknown date unit 'decades'",
    );
  });

  it("measures whole days, weeks, hours and minutes with dateBetween", () => {
    expect(value('dateBetween("2024-01-15", "2024-01-10", "days")')).toBe(5);
    expect(value('dateBetween("2024-01-10", "2024-01-15", "days")')).toBe(-5);
    expect(value('dateBetween("2024-01-15", "2024-01-15", "days")')).toBe(0);
    expect(value('dateBetween("2024-02-01", "2024-01-15", "days")')).toBe(17);
    expect(value('dateBetween("2024-01-20", "2024-01-06", "weeks")')).toBe(2);
    expect(value('dateBetween("2024-01-19", "2024-01-06", "weeks")')).toBe(1);
    expect(value('dateBetween("2024-01-15T05:30:00Z", "2024-01-15T04:00:00Z", "minutes")')).toBe(
      90,
    );
    expect(value('dateBetween("2024-01-15T05:30:00Z", "2024-01-15T04:00:00Z", "hours")')).toBe(1);
    // Partial units truncate toward zero.
    expect(value('dateBetween("2024-01-16T12:00:00Z", "2024-01-15T00:00:00Z", "days")')).toBe(1);
    expect(value('dateBetween("2024-01-15T00:00:00Z", "2024-01-16T12:00:00Z", "days")')).toBe(-1);
    expect(value('dateBetween("2024-01-15T00:00:00Z", "2024-01-15T12:00:00Z", "days")')).toBe(0);
    expect(value('dateBetween("2024-01-15T12:00:00Z", "2024-01-15T00:00:00Z", "days")')).toBe(0);
  });

  it("measures whole months and years with calendar clamping", () => {
    expect(value('dateBetween("2024-03-15", "2024-01-15", "months")')).toBe(2);
    expect(value('dateBetween("2024-03-10", "2024-01-15", "months")')).toBe(1);
    expect(value('dateBetween("2024-02-01", "2024-01-31", "months")')).toBe(0);
    // Round-trips dateAdd's clamp: Jan 31 + 1 month = Feb 29 (2024 is a leap year).
    expect(value('dateBetween("2024-02-29", "2024-01-31", "months")')).toBe(1);
    expect(value('dateBetween("2024-01-15", "2025-01-15", "months")')).toBe(-12);
    expect(value('dateBetween("2025-01-15", "2024-01-15", "years")')).toBe(1);
    expect(value('dateBetween("2025-01-14", "2024-01-15", "years")')).toBe(0);
    expect(value('dateBetween("2024-01-15", "2025-01-14", "years")')).toBe(0);
  });

  it("rejects invalid dates and units in dateBetween", () => {
    expect(errorOf('dateBetween("nope", "2024-01-01", "days")')).toBe("#ERROR: invalid date");
    expect(errorOf('dateBetween("2024-01-02", "nope", "days")')).toBe("#ERROR: invalid date");
    expect(errorOf('dateBetween(true, "2024-01-01", "days")')).toBe("#ERROR: type mismatch");
    expect(errorOf('dateBetween("2024-01-02", "2024-01-01")')).toBe("#ERROR: type mismatch");
    expect(errorOf('dateBetween("2024-01-02", "2024-01-01", "centuries")')).toBe(
      "#ERROR: unknown date unit 'centuries'",
    );
  });

  it("formats dates by explicit token substitution", () => {
    expect(value('formatDate("2024-03-05T07:08:09Z", "YYYY-MM-DD")')).toBe("2024-03-05");
    expect(value('formatDate("2024-03-05T07:08:09Z", "DD/MM/YYYY HH:mm:ss")')).toBe(
      "05/03/2024 07:08:09",
    );
    expect(value('formatDate("2024-03-05T07:08:09Z", "YYYYMMDD")')).toBe("20240305");
    expect(value('formatDate("2024-03-05T07:08:09Z", "ss:mm:HH DD MM YYYY")')).toBe(
      "09:08:07 05 03 2024",
    );
    expect(value('formatDate("2024-12-25T23:59:59Z", "YYYY-MM-DD HH:mm:ss")')).toBe(
      "2024-12-25 23:59:59",
    );
    // Zone-less inputs are read as UTC, so formatting never depends on the host zone.
    expect(value('formatDate("2024-01-15T10:30:00", "YYYY-MM-DD HH:mm")')).toBe(
      "2024-01-15 10:30",
    );
    expect(value('formatDate(0, "YYYY-MM-DD")')).toBe("1970-01-01");
    // Dispatch is case-insensitive, like every other function in the registry.
    expect(value('FORMATDATE("2024-01-01", "YYYY")')).toBe("2024");
  });

  it("rejects invalid dates and patterns in formatDate", () => {
    expect(errorOf('formatDate("not a date", "YYYY")')).toBe("#ERROR: invalid date");
    expect(errorOf('formatDate("2024-02-30", "YYYY-MM-DD")')).toBe("#ERROR: invalid date");
    expect(errorOf('formatDate("2024-01-01", "YY-MM-DD")')).toBe(
      "#ERROR: invalid format pattern: unknown token 'YY'",
    );
    expect(errorOf('formatDate("2024-01-01", "day")')).toBe(
      "#ERROR: invalid format pattern: unknown token 'day'",
    );
    expect(errorOf('formatDate("2024-01-01")')).toBe("#ERROR: type mismatch");
    expect(errorOf('formatDate("2024-01-01", 5)')).toBe("#ERROR: type mismatch");
    expect(errorOf('formatDate(true, "YYYY")')).toBe("#ERROR: type mismatch");
  });
});

describe("formula-editor error messages", () => {
  it("locates an unexpected character", () => {
    expect(errorOf("1 @ 2")).toBe('#ERROR: unexpected character "@" (position 3)');
  });

  it("names the unclosed delimiter so the editor can point at it", () => {
    expect(errorOf("(1 + 2")).toBe("#ERROR: missing closing parenthesis ')'");
    expect(errorOf("[1, 2")).toBe("#ERROR: missing closing bracket ']'");
    expect(errorOf('"abc')).toBe(
      '#ERROR: unterminated string literal (missing closing ")',
    );
  });

  it("explains what a dangling operator is missing", () => {
    expect(errorOf("1 +")).toBe("#ERROR: unexpected end of expression: expected a value");
    expect(errorOf("concat(1,")).toBe("#ERROR: unexpected end of expression: expected a value");
  });
});
