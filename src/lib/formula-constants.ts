/**
 * Named constants for the formula language.
 *
 * A database can carry a small registry of named constants (a tax rate, a
 * currency symbol, a shared threshold) that formulas reference by bare name.
 * This module is the pure, dependency-free home for that registry:
 *
 *   • `validateConstantName` — is this a legal, non-shadowed constant name?
 *   • `collectConstants`     — which bare names does this expression reference?
 *   • `resolveConstants`     — inline every referenced constant as a literal,
 *                              leaving strings, unknown names and function
 *                              calls untouched.
 *
 * It never evaluates anything and never imports the evaluator (it only takes
 * `FormulaValue` as a type), so an editor, a formatter and the runner can all
 * share one definition of "what a constant is".
 *
 * `resolveConstants` matches the evaluator's own resolution order exactly:
 * names are case-insensitive, and nested `map()`/`filter()` expression strings
 * are left intact (the evaluator resolves constants inside them at run time).
 *
 * Red-first unit-pinned by `src/lib/formula-constants.test.ts`.
 */

import { findFunction } from "@/lib/formula-function-catalog";
import type { FormulaValue } from "@/lib/formula";

/** Longest accepted constant name; names are identifiers, so this is ample. */
export const MAX_CONSTANT_NAME_LENGTH = 64;

/** Deepest list nesting serialised before a value is treated as unsupported. */
const MAX_CONSTANT_VALUE_DEPTH = 8;

/** One entry in a per-database constant registry. */
export type NamedConstant = {
  /** Identifier-shaped, case-insensitively unique, not a built-in. */
  readonly name: string;
  /** The value substituted for the name; any formula value is allowed. */
  readonly value: FormulaValue;
};

/** Result of {@link validateConstantName}: `error` is safe to show verbatim. */
export type ConstantNameValidation = { ok: true } | { ok: false; error: string };

/** Result of {@link resolveConstants}. */
export type ResolveConstantsResult =
  | { ok: true; expression: string }
  | { ok: false; error: string };

/**
 * Bare identifiers the evaluator owns, so a constant may never claim them:
 * the boolean/clock literals plus the `map()`/`filter()` item variables.
 * Built-in function names are added dynamically from the catalog.
 */
const RESERVED_IDENTIFIERS = new Set(["true", "false", "now", "today", "item", "index"]);

/** True when `name` would be shadowed by a keyword or a built-in function. */
function isReservedIdentifier(name: string): boolean {
  const lower = name.toLowerCase();
  return RESERVED_IDENTIFIERS.has(lower) || findFunction(lower) !== undefined;
}

/**
 * Validate a constant name for storage. A valid name is an identifier
 * (`[A-Za-z_][A-Za-z0-9_]*`), at most {@link MAX_CONSTANT_NAME_LENGTH}
 * characters, and neither a reserved word (`true`, `now`, `item`, …) nor a
 * built-in function name (`max`, `prop`, …). Lookups are case-insensitive, so
 * the reserved checks are too. Never throws.
 */
export function validateConstantName(name: unknown): ConstantNameValidation {
  if (typeof name !== "string" || name.trim() === "") {
    return { ok: false, error: "constant name must be a non-empty string" };
  }
  if (name.length > MAX_CONSTANT_NAME_LENGTH) {
    return {
      ok: false,
      error: `constant name is too long (maximum ${MAX_CONSTANT_NAME_LENGTH} characters)`,
    };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    if (/^[0-9]/.test(name)) {
      return {
        ok: false,
        error: `invalid constant name '${name}': must start with a letter or underscore`,
      };
    }
    return {
      ok: false,
      error: `invalid constant name '${name}': may only contain letters, digits and underscores`,
    };
  }
  if (RESERVED_IDENTIFIERS.has(name.toLowerCase())) {
    return { ok: false, error: `'${name}' is a reserved word and cannot be a constant name` };
  }
  if (findFunction(name) !== undefined) {
    return { ok: false, error: `'${name}' is a built-in function and cannot be a constant name` };
  }
  return { ok: true };
}

/** A lexical slice of an expression: literal text, a whole string, or a name. */
type Segment =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "ident"; readonly value: string };

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;

/**
 * Split an expression into text, whole string literals (quotes and escapes
 * included) and identifiers. Consecutive punctuation/whitespace collapses into
 * one text segment. An unterminated string runs to the end of the input, which
 * keeps the scanner total rather than throwing on half-typed formulas.
 */
function segmentExpression(source: string): Segment[] {
  const segments: Segment[] = [];
  let text = "";
  let index = 0;

  const flushText = (): void => {
    if (text !== "") {
      segments.push({ kind: "text", value: text });
      text = "";
    }
  };

  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'") {
      flushText();
      let literal = char;
      let end = index + 1;
      while (end < source.length) {
        const inner = source[end];
        literal += inner;
        if (inner === "\\" && end + 1 < source.length) {
          literal += source[end + 1];
          end += 2;
          continue;
        }
        end += 1;
        if (inner === char) break;
      }
      segments.push({ kind: "string", value: literal });
      index = end;
      continue;
    }
    if (IDENT_START.test(char)) {
      flushText();
      let end = index;
      while (end < source.length && IDENT_PART.test(source[end])) end += 1;
      segments.push({ kind: "ident", value: source.slice(index, end) });
      index = end;
      continue;
    }
    text += char;
    index += 1;
  }
  flushText();
  return segments;
}

/** True when the identifier at `index` is a call name (`foo(`), not a value. */
function isCallIdentifier(segments: readonly Segment[], index: number): boolean {
  const next = segments[index + 1];
  return next !== undefined && next.kind === "text" && next.value.trimStart().startsWith("(");
}

/**
 * The bare names an expression references as candidate constants, in
 * first-seen order and deduped case-insensitively (the first spelling wins).
 * String literals, function-call names, reserved words and the evaluator's
 * `item`/`index` variables are all excluded, so the result is exactly the set a
 * registry would need to satisfy. Nested `map()`/`filter()` expression strings
 * are treated as opaque strings and not descended into.
 */
export function collectConstants(expression: string): string[] {
  const segments = segmentExpression(expression);
  const seen = new Set<string>();
  const names: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.kind !== "ident") continue;
    if (isReservedIdentifier(segment.value)) continue;
    if (isCallIdentifier(segments, index)) continue;
    const key = segment.value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(segment.value);
  }
  return names;
}

/** Quote a string as a formula literal, escaping backslashes and quotes. */
function quoteStringLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Render a finite number as a literal the tokenizer can read. `String` uses
 * exponent notation for very small/large magnitudes, which the formula grammar
 * has no syntax for, so those are expanded to plain decimals (or rejected when
 * expansion would lose precision or exceeds the `toFixed` ceiling).
 */
function formatNumberLiteral(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const text = String(value);
  if (!/[eE]/.test(text)) return text;
  const expanded = value.toFixed(20);
  const trimmed = expanded.includes(".")
    ? expanded.replace(/0+$/, "").replace(/\.$/, "")
    : expanded;
  if (trimmed === "" || /[eE]/.test(trimmed) || Number(trimmed) !== value) return null;
  return trimmed;
}

/** Serialise a value as a formula literal, or `null` when it is unsupported. */
function serializeConstantValue(value: unknown, depth: number): string | null {
  if (value === null || value === undefined) return '""';
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return formatNumberLiteral(value);
  if (typeof value === "string") return quoteStringLiteral(value);
  if (Array.isArray(value)) {
    if (depth >= MAX_CONSTANT_VALUE_DEPTH) return null;
    const items: string[] = [];
    for (const item of value) {
      const serialized = serializeConstantValue(item, depth + 1);
      if (serialized === null) return null;
      items.push(serialized);
    }
    return `[${items.join(", ")}]`;
  }
  return null;
}

/**
 * Inline every constant referenced by `expression` as a literal, so the result
 * can be handed to `evaluateFormula` (or stored) without the registry. Names
 * match case-insensitively; unknown names are left verbatim for the evaluator
 * to report, and identifiers inside string literals or in call position are
 * never touched. Entries with an invalid name are ignored, and a later entry
 * wins a case-insensitive duplicate. Returns `{ ok: false, error }` when a
 * referenced value cannot be represented as a formula literal (a non-finite
 * number, an object, an over-deep list, …). Pure: the registry is not mutated.
 */
export function resolveConstants(
  expression: string,
  constants: readonly NamedConstant[],
): ResolveConstantsResult {
  const resolved = new Map<string, FormulaValue>();
  for (const constant of constants) {
    if (!constant || typeof constant !== "object") continue;
    if (!validateConstantName(constant.name).ok) continue;
    resolved.set(constant.name.toLowerCase(), constant.value);
  }

  const segments = segmentExpression(expression);
  const output: string[] = [];
  for (const segment of segments) {
    if (segment.kind !== "ident") {
      output.push(segment.value);
      continue;
    }
    const key = segment.value.toLowerCase();
    if (!resolved.has(key)) {
      output.push(segment.value);
      continue;
    }
    const serialized = serializeConstantValue(resolved.get(key), 0);
    if (serialized === null) {
      return { ok: false, error: `constant '${segment.value}' has an unsupported value` };
    }
    output.push(serialized);
  }
  return { ok: true, expression: output.join("") };
}

/**
 * Constants every database starts with. Kept to universal math values the
 * evaluator does not otherwise provide, so they never shadow workspace data.
 */
export const DEFAULT_CONSTANTS: readonly NamedConstant[] = [
  { name: "PI", value: Math.PI },
  { name: "E", value: Math.E },
  { name: "TAU", value: Math.PI * 2 },
];
