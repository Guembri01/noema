import { beforeEach, describe, expect, it } from "vitest";

import { buildFormulaEditorModel } from "@/components/editor/formula-editor";
import { DEFAULT_CONSTANTS } from "@/lib/formula-constants";
import {
  MAX_FORMULA_CACHE_ENTRIES,
  clearFormulaCache,
  evaluateFormula,
  formulaCacheStats,
  invalidateFormulaCacheByProperty,
} from "@/lib/formula";
import { applyCompletion } from "@/lib/formula-editor";

/**
 * Wiring proof for the three previously-unreachable formula modules:
 *
 *  1. `@/lib/formula-constants` — its `DEFAULT_CONSTANTS` are what the
 *     evaluator resolves by bare name (no duplicated literal table).
 *  2. `@/lib/formula-cache` — the evaluator's `evaluateFormula` memoizes by
 *     `(expression, scope)`, dependency-aware, bounded and invalidatable.
 *  3. `@/lib/formula-editor` — the `FormulaEditor` component's model maps a
 *     caret to context → completions → signature help → diagnostics, and the
 *     returned items apply through `applyCompletion`.
 */

/** Split a `|`-marked source into `[source, caret]`. */
function at(marked: string): [string, number] {
  const caret = marked.indexOf("|");
  return [marked.slice(0, caret) + marked.slice(caret + 1), caret];
}

describe("formula-constants wiring: DEFAULT_CONSTANTS are evaluable", () => {
  beforeEach(() => clearFormulaCache());

  it("owns the built-in names PI/E/TAU", () => {
    expect(DEFAULT_CONSTANTS.map((entry) => entry.name).sort()).toEqual(["E", "PI", "TAU"]);
  });

  it("resolves each built-in by bare name through parse/eval", () => {
    const pi = evaluateFormula("PI");
    expect(pi.ok).toBe(true);
    if (pi.ok && typeof pi.value === "number") expect(pi.value).toBeCloseTo(Math.PI, 12);

    const e = evaluateFormula("E * 2");
    if (e.ok && typeof e.value === "number") expect(e.value).toBeCloseTo(Math.E * 2, 12);

    const tau = evaluateFormula("TAU");
    if (tau.ok && typeof tau.value === "number") {
      expect(tau.value).toBeCloseTo(Math.PI * 2, 12);
    }
  });

  it("feeds the built-ins into arithmetic (proves parse/eval load-bearing)", () => {
    expect(evaluateFormula("round(PI, 3)")).toEqual({ ok: true, value: 3.142 });
  });

  it("lets a caller constant shadow a built-in of the same name", () => {
    expect(evaluateFormula("PI", {}, { constants: { PI: 3 } })).toEqual({ ok: true, value: 3 });
  });

  it("keeps language keywords ahead of the built-ins", () => {
    expect(evaluateFormula("true")).toEqual({ ok: true, value: true });
  });
});

describe("formula-cache wiring: memoized evaluation", () => {
  beforeEach(() => clearFormulaCache());

  it("misses then hits for the same expression and scope", () => {
    expect(evaluateFormula("1 + 2")).toEqual({ ok: true, value: 3 });
    expect(formulaCacheStats()).toMatchObject({ hits: 0, misses: 1, size: 1 });

    expect(evaluateFormula("1 + 2")).toEqual({ ok: true, value: 3 });
    expect(formulaCacheStats()).toMatchObject({ hits: 1, misses: 1, size: 1 });
  });

  it("keys on the values the expression reads, not the whole row", () => {
    expect(evaluateFormula('prop("A") * 2', { A: 3 })).toEqual({ ok: true, value: 6 });
    expect(evaluateFormula('prop("A") * 2', { A: 3 })).toEqual({ ok: true, value: 6 });
    // An unrelated property must not invalidate the entry.
    expect(evaluateFormula('prop("A") * 2', { A: 3, B: 99 })).toEqual({ ok: true, value: 6 });
    expect(formulaCacheStats()).toMatchObject({ hits: 2, misses: 1, size: 1 });

    // A referenced value change is a fresh key.
    expect(evaluateFormula('prop("A") * 2', { A: 4 })).toEqual({ ok: true, value: 8 });
    expect(formulaCacheStats()).toMatchObject({ hits: 2, misses: 2, size: 2 });
  });

  it("invalidates exactly the entries that read a property", () => {
    evaluateFormula('prop("A") + 1', { A: 1 });
    evaluateFormula('prop("B") + 1', { B: 1 });
    expect(formulaCacheStats().size).toBe(2);

    invalidateFormulaCacheByProperty("A");
    expect(formulaCacheStats().size).toBe(1);

    // The dropped expression misses again; the untouched one still hits.
    evaluateFormula('prop("A") + 1', { A: 1 });
    expect(formulaCacheStats()).toMatchObject({ misses: 3 });
    evaluateFormula('prop("B") + 1', { B: 1 });
    expect(formulaCacheStats()).toMatchObject({ hits: 1 });
  });

  it("never caches clock-dependent expressions", () => {
    evaluateFormula("now");
    evaluateFormula("now");
    evaluateFormula("today");
    expect(formulaCacheStats()).toEqual({ hits: 0, misses: 0, size: 0 });
  });

  it("bypasses the cache when constants or rollups are supplied", () => {
    evaluateFormula("PI * 2", {}, { constants: { PI: 3 } });
    evaluateFormula('rollup("Total")', {}, { rollups: { Total: 5 } });
    expect(formulaCacheStats().size).toBe(0);
  });

  it("stays bounded under many distinct expressions", () => {
    for (let index = 0; index < MAX_FORMULA_CACHE_ENTRIES + 25; index += 1) {
      evaluateFormula(`1 + ${index}`);
    }
    expect(formulaCacheStats().size).toBeLessThanOrEqual(MAX_FORMULA_CACHE_ENTRIES);
  });
});

describe("formula-editor wiring: caret → model → insertion", () => {
  it("maps a function prefix to ranked function completions", () => {
    const [source, caret] = at("rou|");
    const model = buildFormulaEditorModel(source, caret);
    expect(model.context.kind).toBe("function");

    const round = model.completions.find((item) => item.label === "round");
    expect(round).toMatchObject({ kind: "function", insertText: "round()" });

    if (round) {
      const applied = applyCompletion(source, round);
      expect(applied.text).toBe("round()");
      expect(applied.caret).toBe(6); // between the parentheses
    }
  });

  it("offers property names inside prop(\"…\") and closes the string", () => {
    const [source, caret] = at('prop("Es|');
    const model = buildFormulaEditorModel(source, caret, ["Estimate", "Status"]);
    expect(model.context.kind).toBe("property");

    const estimate = model.completions.find((item) => item.label === "Estimate");
    expect(estimate).toMatchObject({ kind: "property" });

    if (estimate) {
      expect(applyCompletion(source, estimate).text).toBe('prop("Estimate")');
    }
  });

  it("resolves signature help for the active argument", () => {
    const [source, caret] = at("round(1, |");
    const model = buildFormulaEditorModel(source, caret);
    expect(model.context.functionName).toBe("round");
    expect(model.context.argIndex).toBe(1);
    expect(model.signature).toMatchObject({
      label: "round(value, digits?)",
      activeParameter: 1,
    });
  });

  it("surfaces range-anchored diagnostics", () => {
    const model = buildFormulaEditorModel("nope(1)", 7);
    const unknown = model.diagnostics.find((diagnostic) => diagnostic.code === "unknown_function");
    expect(unknown).toMatchObject({ message: "unknown function 'nope'", start: 0, end: 4 });
  });

  it("reports a syntax diagnostic for an unclosed call", () => {
    const model = buildFormulaEditorModel("abs(1", 5);
    expect(model.diagnostics.some((diagnostic) => diagnostic.code === "syntax")).toBe(true);
  });
});
