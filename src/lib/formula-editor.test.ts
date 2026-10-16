import { describe, expect, it } from "vitest";

import { FORMULA_FUNCTIONS } from "./formula-function-catalog";
import {
  applyCompletion,
  contextAt,
  diagnose,
  formatFormula,
  signatureHelp,
  suggestCompletions,
  tokenizeFormula,
  type FormulaCompletionItem,
  type FormulaContext,
} from "./formula-editor";

/**
 * Formula editor authoring support (formula-engine.md §6). Pure, dependency-free
 * helpers an editor composes to lex a half-typed expression, decide where the
 * caret is, offer completions and signature help, apply an insertion, surface
 * diagnostics and normalise spacing. Everything is deterministic and total
 * (never throws on broken input) so the UI can call it on every keystroke.
 */

/** Split a `|`-marked source into `[source, caret]`. */
function at(marked: string): [string, number] {
  const caret = marked.indexOf("|");
  return [marked.slice(0, caret) + marked.slice(caret + 1), caret];
}

const ctx = (marked: string): FormulaContext => {
  const [source, caret] = at(marked);
  return contextAt(source, caret);
};

const sources = { properties: ["Estimate", "Status", "Due date"] };

const mustHelp = (name: string, argIndex: number) => {
  const help = signatureHelp(FORMULA_FUNCTIONS, name, argIndex);
  if (help === null) throw new Error(`expected signature help for '${name}'`);
  return help;
};

describe("tokenizeFormula", () => {
  it("lexes a call with kinds and offsets", () => {
    const { tokens, errors } = tokenizeFormula("abs(1)");
    expect(errors).toEqual([]);
    expect(tokens).toEqual([
      { kind: "ident", text: "abs", start: 0, end: 3 },
      { kind: "paren", text: "(", start: 3, end: 4 },
      { kind: "number", text: "1", start: 4, end: 5 },
      { kind: "paren", text: ")", start: 5, end: 6 },
    ]);
  });

  it("returns nothing for empty and blank input", () => {
    expect(tokenizeFormula("")).toEqual({ tokens: [], errors: [] });
    expect(tokenizeFormula("   \t\n ").tokens).toEqual([]);
  });

  it("keeps underscores and decimals in number tokens", () => {
    const { tokens, errors } = tokenizeFormula("1_000.5 .5 12");
    expect(errors).toEqual([]);
    expect(tokens.map((token) => token.text)).toEqual(["1_000.5", ".5", "12"]);
    expect(tokens.every((token) => token.kind === "number")).toBe(true);
  });

  it("lexes single- and double-quoted strings verbatim", () => {
    const src = '"a" \'b\' "c\\"d"';
    const { tokens, errors } = tokenizeFormula(src);
    expect(errors).toEqual([]);
    expect(tokens.map((token) => token.text)).toEqual(['"a"', "'b'", '"c\\"d"']);
    expect(tokens.every((token) => token.kind === "string")).toBe(true);
  });

  it("reports an unterminated string but still emits a token", () => {
    const { tokens, errors } = tokenizeFormula('prop("abc');
    const unterminated = errors.find((error) => error.message.includes("unterminated"));
    expect(unterminated).toMatchObject({ start: 5, end: 9 });
    expect(tokens[2]).toMatchObject({ kind: "string", text: '"abc', start: 5, end: 9 });
  });

  it("lexes two-character operators as one token", () => {
    const { tokens } = tokenizeFormula("a==b!=c&&d||e<=f>=g");
    expect(
      tokens.filter((token) => token.kind === "op").map((token) => token.text),
    ).toEqual(["==", "!=", "&&", "||", "<=", ">="]);
  });

  it("lexes commas as their own kind", () => {
    const { tokens } = tokenizeFormula("if(a,b,c)");
    expect(tokens.filter((token) => token.kind === "comma").map((token) => token.text)).toEqual([
      ",",
      ",",
    ]);
  });

  it("reports an unexpected character with its range and keeps scanning", () => {
    const { tokens, errors } = tokenizeFormula("1 @ 2");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("@");
    expect(errors[0]).toMatchObject({ start: 2, end: 3 });
    expect(tokens.map((token) => token.kind)).toEqual(["number", "number"]);
  });

  it("reports an unclosed parenthesis", () => {
    const { errors } = tokenizeFormula("abs(1");
    expect(errors.some((error) => error.message.includes(")"))).toBe(true);
  });

  it("reports an unexpected closing parenthesis", () => {
    const { errors } = tokenizeFormula("1)");
    expect(errors.some((error) => error.message.toLowerCase().includes("unexpected"))).toBe(true);
  });

  it("lexes nested calls without error", () => {
    const { tokens, errors } = tokenizeFormula("if(a, abs(b))");
    expect(errors).toEqual([]);
    expect(tokens.filter((token) => token.kind === "paren")).toHaveLength(4);
  });
});

describe("contextAt", () => {
  it("reports a root context for empty input", () => {
    const context = ctx("|");
    expect(context.kind).toBe("root");
    expect(context.prefix).toBe("");
    expect(context.argIndex).toBe(0);
  });

  it("reports a root context after a top-level operator", () => {
    expect(ctx("1 + |").kind).toBe("root");
    expect(ctx("1 + |").prefix).toBe("");
  });

  it("reports a function context while a bare name is typed", () => {
    const context = ctx("ro|");
    expect(context.kind).toBe("function");
    expect(context.prefix).toBe("ro");
    expect(context.start).toBe(0);
    expect(context.end).toBe(2);
  });

  it("stays a function context when a call name is still being typed", () => {
    const context = ctx("ro|und(");
    expect(context.kind).toBe("function");
    expect(context.prefix).toBe("ro");
  });

  it("reports an arg context inside a call", () => {
    const context = ctx("round(|");
    expect(context.kind).toBe("arg");
    expect(context.functionName).toBe("round");
    expect(context.argIndex).toBe(0);
    expect(context.prefix).toBe("");
  });

  it("advances the argument index after a comma", () => {
    const context = ctx("round(1, |");
    expect(context.kind).toBe("arg");
    expect(context.functionName).toBe("round");
    expect(context.argIndex).toBe(1);
  });

  it("tracks the innermost enclosing call", () => {
    const context = ctx("if(a, abs(|");
    expect(context.kind).toBe("arg");
    expect(context.functionName).toBe("abs");
    expect(context.argIndex).toBe(0);
  });

  it("carries the argument prefix and replacement range", () => {
    const context = ctx("round(va|)");
    expect(context.kind).toBe("arg");
    expect(context.prefix).toBe("va");
    expect(context.start).toBe(6);
    expect(context.end).toBe(8);
  });

  it("reports a property context just after prop(\"", () => {
    const context = ctx('prop("|');
    expect(context.kind).toBe("property");
    expect(context.functionName).toBe("prop");
    expect(context.argIndex).toBe(0);
    expect(context.prefix).toBe("");
    expect(context.start).toBe(6);
    expect(context.end).toBe(6);
  });

  it("carries the partial property prefix inside the string", () => {
    const context = ctx('prop("Es|');
    expect(context.kind).toBe("property");
    expect(context.prefix).toBe("Es");
    expect(context.start).toBe(6);
    expect(context.end).toBe(8);
  });

  it("reports a property context for the rollup reference form", () => {
    const context = ctx('rollup("|');
    expect(context.kind).toBe("property");
    expect(context.functionName).toBe("rollup");
  });

  it("is an arg context, not a property context, in later prop arguments", () => {
    const context = ctx('prop("A", |');
    expect(context.kind).toBe("arg");
    expect(context.argIndex).toBe(1);
  });

  it("clamps out-of-range carets without throwing", () => {
    expect(contextAt("1+1", -5).kind).toBe("root");
    expect(contextAt("1+1", 99).kind).toBe("root");
  });
});

describe("suggestCompletions", () => {
  it("lists every function before every property for an empty prefix", () => {
    const items = suggestCompletions(FORMULA_FUNCTIONS, sources, ctx("|"));
    const lastFunction = items.map((item) => item.kind).lastIndexOf("function");
    const firstProperty = items.findIndex((item) => item.kind === "property");
    expect(lastFunction).toBeLessThan(firstProperty);
    expect(items.filter((item) => item.kind === "function")).toHaveLength(
      FORMULA_FUNCTIONS.length,
    );
    expect(items.filter((item) => item.kind === "property")).toHaveLength(3);
  });

  it("prefix-matches functions and properties case-insensitively", () => {
    const items = suggestCompletions(
      FORMULA_FUNCTIONS,
      { properties: ["Date", "Status"] },
      ctx("dat|"),
    );
    expect(items.map((item) => item.label)).toContain("date");
    expect(items.map((item) => item.label)).toContain("Date");
    expect(items.every((item) => item.label.toLowerCase().startsWith("dat"))).toBe(true);
  });

  it("orders functions alphabetically, then properties alphabetically", () => {
    const items = suggestCompletions(
      FORMULA_FUNCTIONS,
      { properties: ["Zeta", "alpha"] },
      ctx("|"),
    );
    const functions = items.filter((item) => item.kind === "function").map((item) => item.label);
    expect(functions).toEqual([...functions].sort());
    expect(
      items.filter((item) => item.kind === "property").map((item) => item.label),
    ).toEqual(["alpha", "Zeta"]);
  });

  it("marks a function item with its signature and an empty call", () => {
    const item = suggestCompletions(FORMULA_FUNCTIONS, { properties: [] }, ctx("abs|")).find(
      (candidate) => candidate.kind === "function",
    );
    expect(item?.insertText).toBe("abs()");
    expect(item?.detail).toBe("abs(value)");
    expect(item?.replaceRange).toEqual({ start: 0, end: 3 });
  });

  it("inserts a complete prop() reference for a property in value position", () => {
    const item = suggestCompletions(
      FORMULA_FUNCTIONS,
      { properties: ["Estimate"] },
      ctx("Est|"),
    ).find((candidate) => candidate.kind === "property");
    expect(item?.insertText).toBe('prop("Estimate")');
    expect(item?.replaceRange).toEqual({ start: 0, end: 3 });
  });

  it("offers only properties inside a prop() string", () => {
    const items = suggestCompletions(
      FORMULA_FUNCTIONS,
      { properties: ["Estimate", "Status"] },
      ctx('prop("|'),
    );
    expect(items.every((item) => item.kind === "property")).toBe(true);
    expect(items).toHaveLength(2);
  });

  it("inserts a bare, string-closing name inside a prop() string", () => {
    const item = suggestCompletions(
      FORMULA_FUNCTIONS,
      { properties: ["Estimate"] },
      ctx('prop("Es|'),
    ).find((candidate) => candidate.kind === "property");
    expect(item?.insertText).toBe('Estimate")');
    expect(item?.replaceRange).toEqual({ start: 6, end: 8 });
  });

  it("returns nothing when nothing matches the prefix", () => {
    expect(suggestCompletions(FORMULA_FUNCTIONS, sources, ctx("zzz|"))).toEqual([]);
  });
});

describe("signatureHelp", () => {
  it("parses parameters and tracks the active one", () => {
    const help = mustHelp("if", 1);
    expect(help.label).toBe("if(condition, then, else)");
    expect(help.parameters).toEqual(["condition", "then", "else"]);
    expect(help.activeParameter).toBe(1);
    expect(help.doc).toContain("Picks");
  });

  it("looks the function up case-insensitively", () => {
    expect(signatureHelp(FORMULA_FUNCTIONS, "ABS", 0)?.label).toBe("abs(value)");
  });

  it("keeps optional markers in parameter labels", () => {
    expect(mustHelp("round", 0).parameters).toEqual(["value", "digits?"]);
  });

  it("clamps the active parameter for variadic and over-long positions", () => {
    expect(mustHelp("min", 5).activeParameter).toBe(1);
    expect(mustHelp("abs", 9).activeParameter).toBe(0);
  });

  it("returns null for an unknown function", () => {
    expect(signatureHelp(FORMULA_FUNCTIONS, "nope", 0)).toBeNull();
  });
});

describe("diagnose", () => {
  it("reports nothing for a well-formed formula", () => {
    expect(diagnose('if(prop("Estimate") > 3, abs(-1), "no")', FORMULA_FUNCTIONS)).toEqual([]);
  });

  it("flags unknown function calls with their range", () => {
    const diagnostics = diagnose("mystery(1)", FORMULA_FUNCTIONS);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe("unknown_function");
    expect(diagnostics[0].message).toContain("mystery");
    expect(diagnostics[0]).toMatchObject({ start: 0, end: 7, severity: "error" });
  });

  it("flags unknown identifiers with their range", () => {
    const diagnostics = diagnose("1 + foo", FORMULA_FUNCTIONS);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe("unknown_identifier");
    expect(diagnostics[0]).toMatchObject({ start: 4, end: 7 });
  });

  it("accepts keywords and the rollup reference form", () => {
    expect(diagnose('rollup("A") + true', FORMULA_FUNCTIONS)).toEqual([]);
  });

  it("surfaces tokenizer syntax errors as error diagnostics", () => {
    const diagnostics = diagnose('prop("A', FORMULA_FUNCTIONS);
    expect(diagnostics.length).toBeGreaterThanOrEqual(1);
    expect(diagnostics.every((diagnostic) => diagnostic.code === "syntax")).toBe(true);
    expect(diagnostics[0].severity).toBe("error");
  });
});

describe("applyCompletion", () => {
  const functionItem: FormulaCompletionItem = {
    label: "abs",
    kind: "function",
    detail: "abs(value)",
    insertText: "abs()",
    replaceRange: { start: 0, end: 3 },
  };

  it("replaces the prefix and puts the caret inside the new call", () => {
    const applied = applyCompletion("abs", functionItem);
    expect(applied.text).toBe("abs()");
    expect(applied.caret).toBe(4);
  });

  it("puts the caret after a property insertion", () => {
    const applied = applyCompletion("Est", {
      label: "Estimate",
      kind: "property",
      detail: "property",
      insertText: 'prop("Estimate")',
      replaceRange: { start: 0, end: 3 },
    });
    expect(applied.text).toBe('prop("Estimate")');
    expect(applied.caret).toBe(applied.text.length);
  });

  it("keeps the untouched tail of the source", () => {
    const applied = applyCompletion("1 + x", {
      label: "2",
      kind: "property",
      detail: "property",
      insertText: "2",
      replaceRange: { start: 4, end: 5 },
    });
    expect(applied.text).toBe("1 + 2");
    expect(applied.caret).toBe(5);
  });

  it("inserts at an empty range", () => {
    const applied = applyCompletion("", {
      ...functionItem,
      replaceRange: { start: 0, end: 0 },
    });
    expect(applied.text).toBe("abs()");
    expect(applied.caret).toBe(4);
  });
});

describe("formatFormula", () => {
  it("normalises arithmetic spacing", () => {
    expect(formatFormula("1+2*3")).toBe("1 + 2 * 3");
  });

  it("drops inner call spacing and adds one after commas", () => {
    expect(formatFormula("abs(  1,2 )")).toBe("abs(1, 2)");
  });

  it("keeps string literals verbatim", () => {
    expect(formatFormula('prop( "Estimate" )')).toBe('prop("Estimate")');
  });

  it("spaces comparison and boolean operators", () => {
    expect(formatFormula("a<2&&b>=3")).toBe("a < 2 && b >= 3");
  });

  it("attaches unary operators to their operand", () => {
    expect(formatFormula("-1")).toBe("-1");
    expect(formatFormula("!a")).toBe("!a");
    expect(formatFormula("1 - -2")).toBe("1 - -2");
  });

  it("formats array literals", () => {
    expect(formatFormula("[1,2,3]")).toBe("[1, 2, 3]");
  });

  it("returns the input unchanged when it cannot be tokenized", () => {
    expect(formatFormula('prop("A')).toBe('prop("A');
  });

  it("collapses blank input to the empty string", () => {
    expect(formatFormula("   ")).toBe("");
  });
});
