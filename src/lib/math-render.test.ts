import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_MACRO_DEPTH,
  DEFAULT_MAX_MACRO_LENGTH,
  describeMath,
  expandMacros,
  parseMath,
  restrictCommands,
  splitMathText,
  toKatexInput,
  validateLatex,
} from "./math-render";

/* ------------------------------------------------------------------ helpers */

function asScript(node: ReturnType<typeof parseMath>["nodes"][number]) {
  if (node.type !== "script") throw new Error(`expected script, got ${node.type}`);
  return node;
}

function asCommand(node: ReturnType<typeof parseMath>["nodes"][number]) {
  if (node.type !== "command") throw new Error(`expected command, got ${node.type}`);
  return node;
}

function asEnvironment(node: ReturnType<typeof parseMath>["nodes"][number]) {
  if (node.type !== "environment") throw new Error(`expected environment, got ${node.type}`);
  return node;
}

/* ------------------------------------------------------------ expandMacros */

describe("expandMacros", () => {
  it("returns input unchanged when no macros are defined", () => {
    const result = expandMacros("\\alpha + \\beta");
    expect(result.latex).toBe("\\alpha + \\beta");
    expect(result.applied).toEqual([]);
    expect(result.cycles).toEqual([]);
    expect(result.depthExceeded).toBe(false);
  });

  it("handles empty input", () => {
    expect(expandMacros("")).toEqual({
      latex: "",
      applied: [],
      cycles: [],
      depthExceeded: false,
    });
  });

  it("expands a simple macro", () => {
    const result = expandMacros("\\RR", { macros: { RR: "\\mathbb{R}" } });
    expect(result.latex).toBe("\\mathbb{R}");
    expect(result.applied).toEqual(["RR"]);
  });

  it("normalizes macro keys that carry a leading backslash", () => {
    const result = expandMacros("\\RR", { macros: { "\\RR": "\\mathbb{R}" } });
    expect(result.latex).toBe("\\mathbb{R}");
  });

  it("expands nested macros", () => {
    const result = expandMacros("\\f", { macros: { f: "\\g", g: "x^2" } });
    expect(result.latex).toBe("x^2");
    expect(result.applied).toEqual(["f", "g"]);
  });

  it("leaves unknown macros untouched", () => {
    const result = expandMacros("\\unknown{a}");
    expect(result.latex).toBe("\\unknown{a}");
  });

  it("supports a parameterized macro with #1", () => {
    const result = expandMacros("\\vect{v}", { macros: { vect: "\\mathbf{#1}" } });
    expect(result.latex).toBe("\\mathbf{v}");
    expect(result.applied).toEqual(["vect"]);
  });

  it("substitutes multiple parameters", () => {
    const result = expandMacros("\\pair{a}{b}", { macros: { pair: "(#1,#2)" } });
    expect(result.latex).toBe("(a,b)");
  });

  it("expands macros inside macro arguments", () => {
    const result = expandMacros("\\vect{\\sq{x}}", {
      macros: { vect: "\\mathbf{#1}", sq: "#1^2" },
    });
    expect(result.latex).toBe("\\mathbf{x^2}");
  });

  it("registers inline \\newcommand definitions", () => {
    const result = expandMacros("\\newcommand{\\R}{\\mathbb{R}}\\R");
    expect(result.latex).toBe("\\mathbb{R}");
    expect(result.applied).toEqual(["R"]);
  });

  it("lets an inline \\renewcommand override a provided macro", () => {
    const result = expandMacros("\\renewcommand{\\R}{new}\\R", { macros: { R: "old" } });
    expect(result.latex).toBe("new");
  });

  it("registers inline \\def definitions", () => {
    const result = expandMacros("\\def\\R{new}\\R");
    expect(result.latex).toBe("new");
  });

  it("guards against a direct self-cycle", () => {
    const result = expandMacros("\\a", { macros: { a: "\\a" } });
    expect(result.cycles).toEqual(["a"]);
    expect(result.latex).toBe("\\a");
  });

  it("guards against a mutual cycle", () => {
    const result = expandMacros("\\a", { macros: { a: "\\b", b: "\\a" } });
    expect(result.cycles).toEqual(["a"]);
    expect(result.latex).toBe("\\a");
  });

  it("records applied macro names in first-use order", () => {
    const result = expandMacros("\\R \\Z", { macros: { R: "\\mathbb{R}", Z: "\\mathbb{Z}" } });
    expect(result.applied).toEqual(["R", "Z"]);
  });

  it("stops after the configured depth bound", () => {
    const chain: Record<string, string> = {};
    const names = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    for (let n = 0; n < names.length; n++) {
      chain[names[n]] = n === names.length - 1 ? "x" : `\\${names[n + 1]}`;
    }
    const result = expandMacros("\\a", { macros: chain, maxDepth: 3 });
    expect(result.depthExceeded).toBe(true);
    expect(result.latex).toContain("\\d");
    expect(result.applied).toEqual(["a", "b", "c"]);
  });

  it("exposes a default depth bound", () => {
    expect(DEFAULT_MAX_MACRO_DEPTH).toBeGreaterThan(0);
  });

  it("stops output growth at the length bound", () => {
    const result = expandMacros("\\a", {
      macros: { a: "\\b\\b", b: "x".repeat(100) },
      maxDepth: 20,
      maxLength: 250,
    });
    expect(result.latex.length).toBeLessThanOrEqual(250);
    expect(result.truncated).toBe(true);
    expect(DEFAULT_MAX_MACRO_LENGTH).toBeGreaterThanOrEqual(250);
  });
});

/* ------------------------------------------------------------ validateLatex */

describe("validateLatex", () => {
  it("reports nothing for clean latex", () => {
    expect(validateLatex("\\frac{a}{b} + c")).toEqual([]);
  });

  it("reports nothing for a balanced known environment", () => {
    expect(validateLatex("\\begin{matrix}a & b \\\\ c & d\\end{matrix}")).toEqual([]);
  });

  it("flags an unclosed brace with its index", () => {
    const issues = validateLatex("{a");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "unbalanced-brace", index: 0 });
  });

  it("flags a stray closing brace with its index", () => {
    const issues = validateLatex("a}");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "unbalanced-brace", index: 1 });
  });

  it("flags an unknown environment", () => {
    const issues = validateLatex("\\begin{foo}x\\end{foo}");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "unknown-environment", index: 0 });
  });

  it("flags an unclosed environment", () => {
    const issues = validateLatex("\\begin{matrix}x");
    expect(issues.map((i) => i.code)).toContain("unclosed-environment");
  });

  it("flags a stray environment end", () => {
    const issues = validateLatex("x\\end{matrix}");
    expect(issues.map((i) => i.code)).toContain("unexpected-environment-end");
  });

  it("flags a mismatched environment end", () => {
    const issues = validateLatex("\\begin{matrix}x\\end{align}");
    expect(issues.map((i) => i.code)).toContain("unclosed-environment");
  });

  it("flags banned \\write18", () => {
    const issues = validateLatex("\\write18{rm}");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "banned-command", index: 0 });
  });

  it("flags banned \\input", () => {
    const issues = validateLatex("\\input{file}");
    expect(issues.map((i) => i.code)).toEqual(["banned-command"]);
  });

  it("flags banned \\include", () => {
    const issues = validateLatex("\\include{chapter}");
    expect(issues.map((i) => i.code)).toEqual(["banned-command"]);
  });

  it("does not flag a command that merely starts with a banned prefix", () => {
    expect(validateLatex("\\inputfoo")).toEqual([]);
  });
});

/* ---------------------------------------------------------- restrictCommands */

describe("restrictCommands", () => {
  it("strips \\input and its argument", () => {
    const out = restrictCommands("\\input{secret} x");
    expect(out).not.toContain("input");
    expect(out).not.toContain("secret");
    expect(out).toContain("x");
  });

  it("strips \\write18 and its argument", () => {
    const out = restrictCommands("\\write18{rm -rf /}");
    expect(out).not.toContain("write18");
    expect(out).not.toContain("rm");
  });

  it("strips \\include and its argument", () => {
    expect(restrictCommands("\\include{chapter}")).not.toContain("chapter");
  });

  it("strips optional bracket arguments too", () => {
    expect(restrictCommands("\\input[opt]{file}")).toBe("");
  });

  it("leaves safe latex untouched", () => {
    expect(restrictCommands("\\frac{a}{b}")).toBe("\\frac{a}{b}");
  });

  it("removes multiple banned commands in one pass", () => {
    const out = restrictCommands("\\input{a}\\include{b}ok");
    expect(out).not.toContain("input");
    expect(out).not.toContain("include");
    expect(out).toContain("ok");
  });
});

/* ---------------------------------------------------------------- parseMath */

describe("parseMath", () => {
  it("parses a command with group arguments", () => {
    const result = parseMath("\\frac{a}{b}");
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    const node = asCommand(result.nodes[0]);
    expect(node.name).toBe("frac");
    expect(node.args).toHaveLength(2);
  });

  it("builds a superscript node", () => {
    const node = asScript(parseMath("x^2").nodes[0]);
    expect(node.kind).toBe("sup");
    expect(node.base).toMatchObject({ type: "text", value: "x" });
    expect(node.argument[0]).toMatchObject({ type: "text", value: "2" });
  });

  it("nests a superscript inside a group", () => {
    const outer = asScript(parseMath("x^{a^b}").nodes[0]);
    const inner = asScript(outer.argument[0]);
    expect(inner.kind).toBe("sup");
    expect(inner.base).toMatchObject({ type: "text", value: "a" });
    expect(inner.argument[0]).toMatchObject({ type: "text", value: "b" });
  });

  it("binds a subscript after a superscript to the same base", () => {
    const node = asScript(parseMath("x_i^2").nodes[0]);
    expect(node.kind).toBe("sup");
    const base = asScript(node.base as NonNullable<typeof node.base>);
    expect(base.kind).toBe("sub");
  });

  it("parses a matrix environment into rows and cells", () => {
    const env = asEnvironment(parseMath("\\begin{matrix}a & b \\\\ c & d\\end{matrix}").nodes[0]);
    expect(env.name).toBe("matrix");
    expect(env.rows).toHaveLength(2);
    expect(env.rows[0].cells).toHaveLength(2);
    expect(env.rows[1].cells).toHaveLength(2);
  });

  it("parses an align environment", () => {
    const env = asEnvironment(parseMath("\\begin{align}a &= b \\\\ c &= d\\end{align}").nodes[0]);
    expect(env.name).toBe("align");
    expect(env.rows).toHaveLength(2);
    expect(env.rows[0].cells).toHaveLength(2);
  });

  it("reports an unterminated group with an index", () => {
    const result = parseMath("{a");
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatchObject({ index: 0 });
    expect(result.errors[0].message).toContain("Unterminated");
  });

  it("reports an unexpected closing brace", () => {
    const result = parseMath("a}");
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatchObject({ index: 1 });
    expect(result.errors[0].message).toContain("Unexpected");
  });

  it("merges adjacent text characters into one text node", () => {
    const result = parseMath("abc");
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({ type: "text", value: "abc" });
  });
});

/* -------------------------------------------------------------- toKatexInput */

describe("toKatexInput", () => {
  it("keeps $...$ inline and strips the delimiters", () => {
    expect(toKatexInput("$x^2$")).toEqual({ latex: "x^2", displayMode: false });
  });

  it("detects display mode from $$...$$", () => {
    expect(toKatexInput("$$\\int x$$")).toEqual({ latex: "\\int x", displayMode: true });
  });

  it("detects display mode from \\[...\\]", () => {
    expect(toKatexInput("\\[\\frac{a}{b}\\]")).toEqual({
      latex: "\\frac{a}{b}",
      displayMode: true,
    });
  });

  it("treats \\(...\\) as inline", () => {
    expect(toKatexInput("\\(y\\)")).toEqual({ latex: "y", displayMode: false });
  });

  it("applies macros to the emitted latex", () => {
    expect(toKatexInput("$\\RR$", { macros: { RR: "\\mathbb{R}" } })).toEqual({
      latex: "\\mathbb{R}",
      displayMode: false,
    });
  });

  it("strips banned commands from the emitted latex", () => {
    const result = toKatexInput("\\input{secret} x");
    expect(result.latex).not.toContain("input");
    expect(result.latex).toContain("x");
  });
});

/* ------------------------------------------------------------- splitMathText */

describe("splitMathText", () => {
  it("splits text around inline math", () => {
    expect(splitMathText("area is $\\pi r^2$ ok")).toEqual([
      { type: "text", value: "area is ", displayMode: false },
      { type: "math", value: "\\pi r^2", displayMode: false },
      { type: "text", value: " ok", displayMode: false },
    ]);
  });

  it("splits display math", () => {
    expect(splitMathText("before $$x^2$$ after")).toEqual([
      { type: "text", value: "before ", displayMode: false },
      { type: "math", value: "x^2", displayMode: true },
      { type: "text", value: " after", displayMode: false },
    ]);
  });

  it("handles \\(...\\) inline delimiters", () => {
    expect(splitMathText("a \\(b\\) c")).toEqual([
      { type: "text", value: "a ", displayMode: false },
      { type: "math", value: "b", displayMode: false },
      { type: "text", value: " c", displayMode: false },
    ]);
  });

  it("handles \\[...\\] display delimiters", () => {
    const runs = splitMathText("\\[y\\]");
    expect(runs).toEqual([{ type: "math", value: "y", displayMode: true }]);
  });

  it("leaves an escaped dollar as text", () => {
    expect(splitMathText("cost \\$5 today")).toEqual([
      { type: "text", value: "cost \\$5 today", displayMode: false },
    ]);
  });

  it("returns a single text run for plain text", () => {
    expect(splitMathText("hello")).toEqual([
      { type: "text", value: "hello", displayMode: false },
    ]);
  });

  it("accepts an array of runs", () => {
    expect(splitMathText(["a ", "$x$"])).toEqual([
      { type: "text", value: "a ", displayMode: false },
      { type: "math", value: "x", displayMode: false },
    ]);
  });

  it("treats an unterminated delimiter as text", () => {
    expect(splitMathText("a $x")).toEqual([
      { type: "text", value: "a $x", displayMode: false },
    ]);
  });

  it("handles multiple inline runs", () => {
    expect(splitMathText("$a$ and $b$")).toEqual([
      { type: "math", value: "a", displayMode: false },
      { type: "text", value: " and ", displayMode: false },
      { type: "math", value: "b", displayMode: false },
    ]);
  });

  it("returns nothing for empty input", () => {
    expect(splitMathText("")).toEqual([]);
  });
});

/* -------------------------------------------------------------- describeMath */

describe("describeMath", () => {
  it("counts commands and symbols", () => {
    const info = describeMath("\\pi r^2");
    expect(info.commands).toEqual(["pi"]);
    expect(info.symbolCount).toBe(3);
  });

  it("detects superscripts and subscripts", () => {
    const info = describeMath("x_i^2");
    expect(info.hasSuperscript).toBe(true);
    expect(info.hasSubscript).toBe(true);
  });

  it("detects fractions", () => {
    expect(describeMath("\\frac{a}{b}").hasFraction).toBe(true);
  });

  it("detects matrix environments", () => {
    const info = describeMath("\\begin{matrix}a\\end{matrix}");
    expect(info.environments).toEqual(["matrix"]);
    expect(info.hasMatrix).toBe(true);
  });

  it("summarizes block math", () => {
    const info = describeMath("$$x$$");
    expect(info.displayMode).toBe(true);
    expect(info.summary).toContain("block");
  });

  it("reports empty math", () => {
    const info = describeMath("");
    expect(info.empty).toBe(true);
    expect(info.summary).toBe("empty math");
  });
});
