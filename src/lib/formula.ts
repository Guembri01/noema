/**
 * A small, dependency-free formula language for database FORMULA properties.
 * Supports property references via `prop("Name")`, rollup references via
 * `rollup("Name")` (typed results supplied through `FormulaOptions.rollups`),
 * workspace-level named constants by bare name, arithmetic, comparisons,
 * boolean logic, string concatenation with `+`, array literals, and a set of
 * functions (math, text, logic, date, regex, list). Pure and unit-tested.
 *
 * Errors are values, not exceptions: bad syntax, unknown functions, division
 * by zero, type mismatches and sandbox violations all surface as friendly
 * structured results (`#ERROR: …`) from `evaluateFormula`.
 *
 * Date inputs are ISO strings or epoch milliseconds (`now`); zone-less forms
 * are read as UTC and all date output (formatDate, dateAdd, …) is UTC, so
 * results never depend on the host timezone.
 */

import { DEFAULT_CONSTANTS } from "@/lib/formula-constants";
import {
  cacheSize,
  createFormulaCache,
  getCached,
  invalidateAll,
  invalidateByProperty,
  setCached,
  type FormulaCache,
} from "@/lib/formula-cache";

export type FormulaValue = number | string | boolean | FormulaValue[];
export type FormulaScope = Record<string, FormulaValue>;

/** A structured in-expression error; its message always starts with `#ERROR: `. */
export type FormulaErrorValue = {
  kind: "error";
  message: string;
};

export type FormulaOptions = {
  /** Workspace-level named constants, resolved by bare identifier. */
  constants?: Record<string, unknown>;
  /**
   * Typed rollup results, resolved by the `rollup("Name")` reference form
   * (case-insensitive). A missing or nullish rollup reads as an empty string,
   * mirroring how `prop()` treats an absent property, so `empty()` stays a
   * meaningful check.
   */
  rollups?: Record<string, FormulaValue | null | undefined>;
};

export type FormulaResult =
  | { ok: true; value: FormulaValue }
  | { ok: false; error: string };

/** Bounds for pathological input: no user formula legitimately exceeds these. */
export const MAX_FORMULA_LENGTH = 10_000;
export const MAX_FORMULA_DEPTH = 256;
/** Bounds recursion through map()/filter() expression strings. */
export const MAX_NESTED_EVAL_DEPTH = 6;

/** Bounds for the sandboxed regex functions. */
export const MAX_REGEX_PATTERN_LENGTH = 200;
export const MAX_REGEX_TEXT_LENGTH = 5_000;

/** Maximum JSON depth accepted when coercing named constants. */
const MAX_CONSTANT_DEPTH = 8;

/**
 * The registry every evaluation starts from: `@/lib/formula-constants` owns the
 * default named constants (PI, E, TAU), folded here into a name → value map
 * once. They are read by bare name just like caller-supplied constants, and a
 * caller constant of the same name shadows the built-in, so the public API
 * stays backward compatible while those names stop being unknown identifiers.
 */
const BUILTIN_CONSTANTS: Readonly<Record<string, unknown>> = Object.fromEntries(
  DEFAULT_CONSTANTS.map((constant) => [constant.name, constant.value] as const),
);


/** Internal evaluation value: any formula value plus an error. Lists never contain errors. */
type ExprValue = FormulaValue | FormulaErrorValue;

function isError(value: unknown): value is FormulaErrorValue {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as FormulaErrorValue).kind === "error"
  );
}

function errorValue(detail: string): FormulaErrorValue {
  return {
    kind: "error",
    message: detail.startsWith("#ERROR:") ? detail : `#ERROR: ${detail}`,
  };
}

/** Numbers only; NaN surfaces as a type mismatch instead of poisoning results. */
function checkedNumber(result: number): number | FormulaErrorValue {
  return Number.isNaN(result) ? errorValue("type mismatch") : result;
}

/** Builds a list, propagating the first error element instead of nesting errors. */
function makeList(items: ExprValue[]): FormulaValue | FormulaErrorValue {
  for (const item of items) {
    if (isError(item)) return item;
  }
  return items as FormulaValue[];
}

function asList(value: ExprValue | undefined): FormulaValue[] | FormulaErrorValue {
  return Array.isArray(value) ? value : errorValue("type mismatch");
}

/** Converts an untyped named constant into a formula value (or an error). */
function coerceConstant(value: unknown, depth: number): FormulaValue | FormulaErrorValue {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isNaN(value) ? errorValue("type mismatch") : value;
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_CONSTANT_DEPTH) return errorValue("type mismatch");
    return makeList(value.map((item) => coerceConstant(item, depth + 1)));
  }
  return errorValue("type mismatch");
}

/** Deterministic sort order: numbers, then strings, then booleans, then lists. */
function typeRank(value: FormulaValue): number {
  if (typeof value === "number") return 0;
  if (typeof value === "string") return 1;
  if (typeof value === "boolean") return 2;
  return 3;
}

function compareValues(a: FormulaValue, b: FormulaValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return typeRank(a) - typeRank(b);
}

/**
 * Best-effort guard against catastrophic backtracking: rejects quantified
 * groups whose body itself contains a quantifier (e.g. `(a+)+`). Escapes and
 * character classes are skipped. Conservative on purpose; combined with the
 * pattern and text caps it keeps matching bounded for formula workloads.
 */
function hasNestedQuantifiers(pattern: string): boolean {
  const groupStarts: number[] = [];
  let inClass = false;
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      i += 1;
      continue;
    }
    if (char === "[") {
      inClass = true;
      i += 1;
      continue;
    }
    if (char === "(") {
      groupStarts.push(i);
      i += 1;
      continue;
    }
    if (char === ")") {
      const start = groupStarts.pop();
      const quantifier = pattern[i + 1];
      if (
        start !== undefined &&
        (quantifier === "+" || quantifier === "*" || quantifier === "{") &&
        /[+*?{]/.test(pattern.slice(start + 1, i))
      ) {
        return true;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return false;
}

/** Compiles a regex for formula use, or a friendly error when unsafe/invalid. */
function compileBoundedRegex(
  text: string,
  pattern: string,
  flags: string,
): RegExp | FormulaErrorValue {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    return errorValue(`pattern exceeds maximum length (${MAX_REGEX_PATTERN_LENGTH})`);
  }
  if (text.length > MAX_REGEX_TEXT_LENGTH) {
    return errorValue(`text exceeds maximum length (${MAX_REGEX_TEXT_LENGTH})`);
  }
  if (hasNestedQuantifiers(pattern)) {
    return errorValue("pattern rejected: nested quantifiers risk catastrophic backtracking");
  }
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    return errorValue(`invalid pattern: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function regexMatch(text: string, pattern: string): boolean | FormulaErrorValue {
  const regex = compileBoundedRegex(text, pattern, "");
  if (isError(regex)) return regex;
  return regex.test(text);
}

/** Capture-group metadata for a pattern: how many groups exist and their names. */
type CaptureGroupInfo = { count: number; names: string[] };

/**
 * Scans `pattern` for capturing groups without compiling it: counts plain `(…)`
 * groups and collects `(?<name>…)` names, skipping escapes and character
 * classes. Used to reject an unknown `group` argument with a clear message
 * instead of silently returning an empty value.
 */
function scanCaptureGroups(pattern: string): CaptureGroupInfo {
  const names: string[] = [];
  let count = 0;
  let inClass = false;
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      i += 1;
      continue;
    }
    if (char === "[") {
      inClass = true;
      i += 1;
      continue;
    }
    if (char === "(") {
      if (pattern[i + 1] === "?") {
        // `(?<name>` is a named capture; `(?<=`/`(?<!` are lookbehind.
        if (
          pattern[i + 2] === "<" &&
          pattern[i + 3] !== "=" &&
          pattern[i + 3] !== "!"
        ) {
          count += 1;
          let j = i + 3;
          let name = "";
          while (j < pattern.length && pattern[j] !== ">") {
            name += pattern[j];
            j += 1;
          }
          if (name.length > 0) names.push(name);
        }
      } else {
        count += 1;
      }
    }
    i += 1;
  }
  return { count, names };
}

/**
 * Capture groups of every match; falls back to full matches when there are
 * none.
 *
 * With `group` given, only that capture is returned from the first match: a
 * numeric index (`0` is the whole match, `1` the first group) or a
 * `(?<name>…)` label. A group that exists but did not participate in the match
 * reads as an empty string; an unknown group, an invalid pattern or a violated
 * sandbox bound is a friendly error value. Never throws.
 */
function regexExtract(
  text: string,
  pattern: string,
  group?: number | string,
): FormulaValue | FormulaErrorValue {
  const regex = compileBoundedRegex(text, pattern, "g");
  if (isError(regex)) return regex;
  if (group !== undefined) {
    const info = scanCaptureGroups(pattern);
    if (typeof group === "number") {
      if (!Number.isInteger(group) || group < 0) return errorValue("type mismatch");
      if (group > info.count) return errorValue(`unknown capture group ${group}`);
    } else if (!info.names.includes(group)) {
      return errorValue(`unknown capture group '${group}'`);
    }
    const found = regex.exec(text);
    if (found === null) return "";
    const selected =
      typeof group === "number" ? found[group] : found.groups?.[group];
    return selected ?? "";
  }
  const groups: string[] = [];
  let found: RegExpExecArray | null = regex.exec(text);
  while (found !== null) {
    const match = found.slice(1).filter((value) => value !== undefined);
    groups.push(...(match.length > 0 ? match : [found[0]]));
    if (found[0] === "") regex.lastIndex += 1; // zero-width matches stay bounded
    found = regex.exec(text);
  }
  return groups;
}

/** Replaces every match; `$1`/`$&` in the replacement reference capture groups. */
function regexReplace(
  text: string,
  pattern: string,
  replacement: string,
): string | FormulaErrorValue {
  const regex = compileBoundedRegex(text, pattern, "g");
  if (isError(regex)) return regex;
  return text.replace(regex, replacement);
}

/** Units accepted by the date functions. */
type DateUnit = "days" | "weeks" | "months" | "years" | "hours" | "minutes";

const DATE_UNITS: readonly DateUnit[] = [
  "days",
  "weeks",
  "months",
  "years",
  "hours",
  "minutes",
];

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Parses a date argument: an ISO string or epoch milliseconds (the `now`
 * keyword). Zone-less forms — bare `YYYY-MM-DD` and date-times without an
 * offset — are read as UTC so results never depend on the host timezone,
 * matching how `today` emits `toISOString()` day strings. Only strict ISO
 * shapes are accepted; `Date.parse`'s lenient natural-language forms
 * ("March 5, 2024") parse in local time and are therefore rejected as invalid
 * dates. Never throws.
 */
function parseDateValue(value: ExprValue | undefined): Date | FormulaErrorValue {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return errorValue("type mismatch");
    const epoch = new Date(value);
    return Number.isNaN(epoch.getTime()) ? errorValue("invalid date") : epoch;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return errorValue("invalid date");
    const source = trimmed.replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T");
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(source);
    const zoneless = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(source);
    const zoned =
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(
        source,
      );
    if (!dateOnly && !zoneless && !zoned) return errorValue("invalid date");
    const parsed = new Date(zoneless ? `${source}Z` : source);
    if (Number.isNaN(parsed.getTime())) return errorValue("invalid date");
    // Date-only inputs can silently overflow (`new Date("2024-02-30")` lands on
    // March 1), so the normalized day must round-trip or the input is invalid.
    if (dateOnly && parsed.toISOString().slice(0, 10) !== source) {
      return errorValue("invalid date");
    }
    return parsed;
  }
  return errorValue("type mismatch");
}

/** Validates a date-function unit argument (`days`, `weeks`, `months`, …). */
function parseDateUnit(value: ExprValue | undefined): DateUnit | FormulaErrorValue {
  if (typeof value !== "string") return errorValue("type mismatch");
  const unit = DATE_UNITS.find((candidate) => candidate === value.toLowerCase());
  return unit ?? errorValue(`unknown date unit '${value}'`);
}

/** Days in the given UTC calendar month. */
function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * Adds whole calendar months, clamping the day of month so month/year steps
 * stay calendar-safe: Jan 31 + 1 month → Feb 28/29, never a fixed 30-day
 * step. Fractional amounts truncate toward zero; out-of-range results come
 * back as Invalid Date, which callers surface as an error value.
 */
function addCalendarMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  result.setUTCDate(Math.min(day, daysInUtcMonth(result.getUTCFullYear(), result.getUTCMonth())));
  return result;
}

/**
 * Shifts `date` by `amount` in `unit`: calendar units (months/years) clamp
 * like `addCalendarMonths`, time units add exact elapsed milliseconds.
 */
function shiftDate(date: Date, amount: number, unit: DateUnit): Date {
  switch (unit) {
    case "days":
      return new Date(date.getTime() + amount * MS_PER_DAY);
    case "weeks":
      return new Date(date.getTime() + amount * 7 * MS_PER_DAY);
    case "hours":
      return new Date(date.getTime() + amount * MS_PER_HOUR);
    case "minutes":
      return new Date(date.getTime() + amount * MS_PER_MINUTE);
    case "months":
      return addCalendarMonths(date, Math.trunc(amount));
    case "years":
      return addCalendarMonths(date, Math.trunc(amount) * 12);
  }
}

/** Whole calendar months from `earlier` to `later` (signed, exact by clamping). */
function calendarMonthsBetween(later: Date, earlier: Date): number {
  const raw =
    (later.getUTCFullYear() - earlier.getUTCFullYear()) * 12 +
    (later.getUTCMonth() - earlier.getUTCMonth());
  const anchor = addCalendarMonths(earlier, raw);
  if (raw > 0 && anchor.getTime() > later.getTime()) return raw - 1;
  if (raw < 0 && anchor.getTime() < later.getTime()) return raw + 1;
  return raw;
}

/**
 * Whole `unit`s from `earlier` to `later`, truncated toward zero so partial
 * units never round away from zero (1.9 days → 1, −1.9 days → −1). Months and
 * years count calendar units with dateAdd's clamping, so
 * `dateBetween(dateAdd(d, n, u), d, u)` round-trips to `n`.
 */
function wholeUnitsBetween(later: Date, earlier: Date, unit: DateUnit): number {
  const elapsed = later.getTime() - earlier.getTime();
  let whole: number;
  switch (unit) {
    case "days":
      whole = Math.trunc(elapsed / MS_PER_DAY);
      break;
    case "weeks":
      whole = Math.trunc(elapsed / (7 * MS_PER_DAY));
      break;
    case "hours":
      whole = Math.trunc(elapsed / MS_PER_HOUR);
      break;
    case "minutes":
      whole = Math.trunc(elapsed / MS_PER_MINUTE);
      break;
    case "months":
      whole = calendarMonthsBetween(later, earlier);
      break;
    case "years":
      whole = Math.trunc(calendarMonthsBetween(later, earlier) / 12);
      break;
  }
  // Truncating a sub-unit negative span yields -0; a zero span must read +0.
  return whole === 0 ? 0 : whole;
}

/** Tokens understood by formatDate(). */
const FORMAT_TOKENS = ["YYYY", "MM", "DD", "HH", "mm", "ss"] as const;

/**
 * Renders `date` in UTC by explicit token substitution (YYYY, MM, DD, HH, mm,
 * ss); every other character passes through literally and any other letter
 * sequence is an invalid pattern. UTC keeps the output independent of the host
 * timezone. `date` must already be valid — this never sees Invalid Date.
 */
function formatDateValue(date: Date, pattern: string): string | FormulaErrorValue {
  const iso = date.toISOString();
  const parts: Record<(typeof FORMAT_TOKENS)[number], string> = {
    YYYY: iso.slice(0, 4),
    MM: iso.slice(5, 7),
    DD: iso.slice(8, 10),
    HH: iso.slice(11, 13),
    mm: iso.slice(14, 16),
    ss: iso.slice(17, 19),
  };
  let output = "";
  let index = 0;
  while (index < pattern.length) {
    const token = FORMAT_TOKENS.find((candidate) => pattern.startsWith(candidate, index));
    if (token !== undefined) {
      output += parts[token];
      index += token.length;
      continue;
    }
    const unknownRun = /^[A-Za-z]+/.exec(pattern.slice(index));
    if (unknownRun !== null) {
      return errorValue(`invalid format pattern: unknown token '${unknownRun[0]}'`);
    }
    output += pattern[index];
    index += 1;
  }
  return output;
}

type Token =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "ident"; value: string }
  | { kind: "op"; value: string }
  | { kind: "eof" };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const char = input[i];
    if (/\s/.test(char)) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(char)) {
      let j = i;
      while (j < input.length && /[0-9._]/.test(input[j])) j += 1;
      tokens.push({ kind: "number", value: Number(input.slice(i, j).replace(/_/g, "")) });
      i = j;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let j = i + 1;
      let value = "";
      while (j < input.length && input[j] !== quote) {
        if (input[j] === "\\" && j + 1 < input.length) {
          value += input[j + 1];
          j += 2;
          continue;
        }
        value += input[j];
        j += 1;
      }
      if (j >= input.length) throw new Error(`unterminated string literal (missing closing ${quote})`);
      tokens.push({ kind: "string", value });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      tokens.push({ kind: "ident", value: input.slice(i, j) });
      i = j;
      continue;
    }
    const two = input.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) {
      tokens.push({ kind: "op", value: two });
      i += 2;
      continue;
    }
    if ("+-*/%<>()[],!".includes(char)) {
      tokens.push({ kind: "op", value: char });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character "${char}" (position ${i + 1})`);
  }
  tokens.push({ kind: "eof" });
  return tokens;
}

/**
 * ifs(cond1, val1, …, fallback?): selects like `if` — pairs are consulted in
 * order and only up to the first true condition, so errors in untaken pairs
 * never surface (an error condition propagates, since it decides control
 * flow). An odd argument count leaves a trailing fallback; with no match and
 * no fallback the result is an error value.
 */
function selectIfs(args: ExprValue[]): ExprValue {
  if (args.length < 2) return errorValue("type mismatch");
  const hasFallback = args.length % 2 === 1;
  const pairCount = hasFallback ? (args.length - 1) / 2 : args.length / 2;
  for (let pair = 0; pair < pairCount; pair += 1) {
    const condition = args[pair * 2];
    if (isError(condition)) return condition;
    if (Boolean(condition)) return args[pair * 2 + 1];
  }
  if (hasFallback) return args[args.length - 1];
  return errorValue("no matching condition");
}

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly scope: FormulaScope,
    private readonly constants: Record<string, unknown>,
    private readonly rollups: Record<string, FormulaValue | null | undefined>,
    private readonly evalDepth: number,
  ) {}

  parse(): ExprValue {
    const value = this.or();
    if (this.peek().kind !== "eof") throw new Error("unexpected trailing input");
    return value;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private eat(value: string): boolean {
    const token = this.peek();
    if (token.kind === "op" && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private or(): ExprValue {
    let left = this.and();
    while (this.eat("||")) {
      const right = this.and();
      if (isError(left)) return left;
      if (isError(right)) return right;
      left = Boolean(left) || Boolean(right);
    }
    return left;
  }

  private and(): ExprValue {
    let left = this.equality();
    while (this.eat("&&")) {
      const right = this.equality();
      if (isError(left)) return left;
      if (isError(right)) return right;
      left = Boolean(left) && Boolean(right);
    }
    return left;
  }

  private equality(): ExprValue {
    let left = this.comparison();
    for (;;) {
      let operator: "==" | "!=" | null = null;
      if (this.eat("==")) operator = "==";
      else if (this.eat("!=")) operator = "!=";
      if (operator === null) return left;
      const right = this.comparison();
      if (isError(left)) return left;
      if (isError(right)) return right;
      left = operator === "==" ? left === right : left !== right;
    }
  }

  private comparison(): ExprValue {
    let left = this.additive();
    for (;;) {
      let operator: "<=" | ">=" | "<" | ">" | null = null;
      if (this.eat("<=")) operator = "<=";
      else if (this.eat(">=")) operator = ">=";
      else if (this.eat("<")) operator = "<";
      else if (this.eat(">")) operator = ">";
      if (operator === null) return left;
      const right = this.additive();
      if (isError(left)) return left;
      if (isError(right)) return right;
      const a = Number(left);
      const b = Number(right);
      if (operator === "<=") left = a <= b;
      else if (operator === ">=") left = a >= b;
      else if (operator === "<") left = a < b;
      else left = a > b;
    }
  }

  private additive(): ExprValue {
    let left = this.multiplicative();
    for (;;) {
      if (this.eat("+")) {
        const right = this.multiplicative();
        if (isError(left)) return left;
        if (isError(right)) return right;
        if (Array.isArray(left) || Array.isArray(right)) return errorValue("type mismatch");
        left =
          typeof left === "string" || typeof right === "string"
            ? `${left}${right}`
            : checkedNumber(Number(left) + Number(right));
      } else if (this.eat("-")) {
        const right = this.multiplicative();
        if (isError(left)) return left;
        if (isError(right)) return right;
        left = checkedNumber(Number(left) - Number(right));
      } else break;
    }
    return left;
  }

  private multiplicative(): ExprValue {
    let left = this.unary();
    for (;;) {
      if (this.eat("*")) {
        const right = this.unary();
        if (isError(left)) return left;
        if (isError(right)) return right;
        left = checkedNumber(Number(left) * Number(right));
      } else if (this.eat("/")) {
        const right = this.unary();
        if (isError(left)) return left;
        if (isError(right)) return right;
        const divisor = Number(right);
        if (divisor === 0) return errorValue("division by zero");
        left = checkedNumber(Number(left) / divisor);
      } else if (this.eat("%")) {
        const right = this.unary();
        if (isError(left)) return left;
        if (isError(right)) return right;
        const divisor = Number(right);
        if (divisor === 0) return errorValue("division by zero");
        left = checkedNumber(Number(left) % divisor);
      } else break;
    }
    return left;
  }

  private unary(): ExprValue {
    // Every recursive-descent cycle funnels through unary(), so counting here
    // bounds both parenthesis/call/array nesting and chains like "!!!!…".
    this.depth += 1;
    if (this.depth > MAX_FORMULA_DEPTH) throw new Error("expression nested too deeply");
    try {
      if (this.eat("!")) {
        const operand = this.unary();
        if (isError(operand)) return operand;
        return !Boolean(operand);
      }
      if (this.eat("-")) {
        const operand = this.unary();
        if (isError(operand)) return operand;
        return checkedNumber(-Number(operand));
      }
      return this.primary();
    } finally {
      this.depth -= 1;
    }
  }

  private primary(): ExprValue {
    const token = this.peek();
    if (token.kind === "number" || token.kind === "string") {
      this.pos += 1;
      return token.value;
    }
    if (token.kind === "op" && token.value === "(") {
      this.pos += 1;
      const value = this.or();
      if (!this.eat(")")) throw new Error("missing closing parenthesis ')'");
      return value;
    }
    if (token.kind === "op" && token.value === "[") {
      this.pos += 1;
      const items: ExprValue[] = [];
      if (!this.eat("]")) {
        items.push(this.or());
        while (this.eat(",")) items.push(this.or());
        if (!this.eat("]")) throw new Error("missing closing bracket ']'");
      }
      return makeList(items);
    }
    if (token.kind === "ident") {
      this.pos += 1;
      const name = token.value.toLowerCase();
      if (name === "true") return true;
      if (name === "false") return false;
      const next = this.peek();
      if (next.kind === "op" && next.value === "(") {
        this.pos += 1;
        const args: ExprValue[] = [];
        if (!this.eat(")")) {
          args.push(this.or());
          while (this.eat(",")) args.push(this.or());
          if (!this.eat(")")) throw new Error("missing closing parenthesis ')'");
        }
        return this.call(name, args, token.value);
      }
      const scoped = this.scopeValue(token.value);
      if (scoped !== undefined) return scoped;
      const constant = this.constantFor(token.value);
      if (constant !== undefined) return constant;
      if (name === "now") return Date.now();
      if (name === "today") return new Date().toISOString().slice(0, 10);
      return errorValue(`unknown identifier '${token.value}'`);
    }
    throw new Error("unexpected end of expression: expected a value");
  }

  private scopeValue(name: string): FormulaValue | undefined {
    const key = Object.keys(this.scope).find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
    return key === undefined ? undefined : this.scope[key];
  }

  private constantFor(name: string): ExprValue | undefined {
    const key = Object.keys(this.constants).find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
    if (key === undefined) return undefined;
    return coerceConstant(this.constants[key], 0);
  }

  /** Typed rollup value for `name` (case-insensitive); nullish reads as empty. */
  private rollupValue(name: string): FormulaValue | undefined {
    const key = Object.keys(this.rollups).find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
    if (key === undefined) return undefined;
    const value = this.rollups[key];
    return value === null || value === undefined ? "" : value;
  }

  private call(name: string, args: ExprValue[], displayName: string): ExprValue {
    if (name === "if") {
      const condition = args[0];
      if (isError(condition)) return condition;
      // if() is branch-selecting: errors in untaken branches never surface.
      return Boolean(condition) ? args[1] : args[2];
    }
    if (name === "ifs") {
      // ifs() is pair-selecting like if(): only consulted pairs can surface
      // errors, so it must run before the eager argument-error sweep below.
      return selectIfs(args);
    }
    for (const arg of args) {
      if (isError(arg)) return arg;
    }
    const result = this.invoke(name, args, displayName);
    return typeof result === "number" && Number.isNaN(result) ? errorValue("type mismatch") : result;
  }

  /** Evaluates a map()/filter() expression string against one list element. */
  private evalNested(expr: string, item: FormulaValue, index: number): ExprValue {
    const result = runFormula(
      expr,
      { ...this.scope, item, index },
      { constants: this.constants, rollups: this.rollups },
      this.evalDepth + 1,
    );
    return result.ok ? result.value : errorValue(result.error);
  }

  private invoke(name: string, args: ExprValue[], displayName: string): ExprValue {
    switch (name) {
      case "prop": {
        const key = String(args[0] ?? "");
        const found = Object.keys(this.scope).find(
          (candidate) => candidate.toLowerCase() === key.toLowerCase(),
        );
        return found ? this.scope[found] : "";
      }
      case "rollup": {
        // Rollup-aware reference form: typed rollup results win, then the row
        // scope (rollups already projected there resolve too).
        const key = String(args[0] ?? "");
        return this.rollupValue(key) ?? this.scopeValue(key) ?? "";
      }
      case "if":
        return Boolean(args[0]) ? args[1] : args[2];
      case "concat":
        return args.map((a) => String(a)).join("");
      case "length":
        return Array.isArray(args[0]) ? args[0].length : String(args[0] ?? "").length;
      case "upper":
        return String(args[0] ?? "").toUpperCase();
      case "lower":
        return String(args[0] ?? "").toLowerCase();
      case "contains":
        return String(args[0] ?? "").toLowerCase().includes(String(args[1] ?? "").toLowerCase());
      case "empty":
        return String(args[0] ?? "").trim() === "";
      case "slice": {
        const start = Number(args[1]);
        if (!Number.isFinite(start)) return errorValue("type mismatch");
        const text = String(args[0] ?? "");
        if (args[2] === undefined) return text.slice(start);
        const end = Number(args[2]);
        if (!Number.isFinite(end)) return errorValue("type mismatch");
        // String.slice natively supports negative (from-the-end) indexes and
        // clamps out-of-range ones.
        return text.slice(start, end);
      }
      case "trim":
        return String(args[0] ?? "").trim();
      case "abs":
        return Math.abs(Number(args[0]));
      case "round": {
        const digits = args[1] === undefined ? 0 : Number(args[1]);
        const factor = 10 ** digits;
        return Math.round(Number(args[0]) * factor) / factor;
      }
      case "min":
        return Math.min(...args.map(Number));
      case "max":
        return Math.max(...args.map(Number));
      case "ceil":
        return checkedNumber(Math.ceil(Number(args[0])));
      case "floor":
        return checkedNumber(Math.floor(Number(args[0])));
      case "sqrt":
        return checkedNumber(Math.sqrt(Number(args[0])));
      case "pow":
        return checkedNumber(Math.pow(Number(args[0]), Number(args[1])));
      case "date": {
        const parsed = parseDateValue(args[0]);
        if (isError(parsed)) return parsed;
        return parsed.toISOString();
      }
      case "dateadd":
      case "datesubtract": {
        const parsed = parseDateValue(args[0]);
        if (isError(parsed)) return parsed;
        const amount = Number(args[1]);
        if (!Number.isFinite(amount)) return errorValue("type mismatch");
        const unit = parseDateUnit(args[2]);
        if (isError(unit)) return unit;
        const shifted = shiftDate(parsed, name === "datesubtract" ? -amount : amount, unit);
        if (Number.isNaN(shifted.getTime())) return errorValue("invalid date");
        return shifted.toISOString();
      }
      case "datebetween": {
        const later = parseDateValue(args[0]);
        if (isError(later)) return later;
        const earlier = parseDateValue(args[1]);
        if (isError(earlier)) return earlier;
        const unit = parseDateUnit(args[2]);
        if (isError(unit)) return unit;
        return wholeUnitsBetween(later, earlier, unit);
      }
      case "formatdate": {
        const parsed = parseDateValue(args[0]);
        if (isError(parsed)) return parsed;
        const pattern = args[1];
        if (typeof pattern !== "string") return errorValue("type mismatch");
        return formatDateValue(parsed, pattern);
      }
      case "match": {
        const pattern = args[1];
        if (pattern === undefined) return errorValue("type mismatch");
        return regexMatch(String(args[0] ?? ""), String(pattern));
      }
      case "replace": {
        const pattern = args[1];
        if (pattern === undefined) return errorValue("type mismatch");
        return regexReplace(String(args[0] ?? ""), String(pattern), String(args[2] ?? ""));
      }
      case "extract": {
        const pattern = args[1];
        if (pattern === undefined) return errorValue("type mismatch");
        const group = args[2];
        if (group === undefined) {
          return regexExtract(String(args[0] ?? ""), String(pattern));
        }
        if (typeof group !== "number" && typeof group !== "string") {
          return errorValue("type mismatch");
        }
        return regexExtract(String(args[0] ?? ""), String(pattern), group);
      }
      case "sort": {
        const list = asList(args[0]);
        if (isError(list)) return list;
        return [...list].sort(compareValues);
      }
      case "join": {
        const list = asList(args[0]);
        if (isError(list)) return list;
        return list.map((item) => String(item)).join(args[1] === undefined ? "" : String(args[1]));
      }
      case "map": {
        const list = asList(args[0]);
        if (isError(list)) return list;
        const expr = args[1];
        if (typeof expr !== "string") return errorValue("type mismatch");
        const mapped: FormulaValue[] = [];
        for (let index = 0; index < list.length; index += 1) {
          const item = this.evalNested(expr, list[index], index);
          if (isError(item)) return item;
          mapped.push(item);
        }
        return mapped;
      }
      case "filter": {
        const list = asList(args[0]);
        if (isError(list)) return list;
        const expr = args[1];
        if (typeof expr !== "string") return errorValue("type mismatch");
        const kept: FormulaValue[] = [];
        for (let index = 0; index < list.length; index += 1) {
          const item = this.evalNested(expr, list[index], index);
          if (isError(item)) return item;
          if (Boolean(item)) kept.push(list[index]);
        }
        return kept;
      }
      default:
        return errorValue(`unknown function '${displayName}'`);
    }
  }
}

function runFormula(
  expression: string,
  scope: FormulaScope,
  options: FormulaOptions,
  evalDepth: number,
): FormulaResult {
  const source = (expression ?? "").trim();
  if (!source) return { ok: false, error: errorValue("empty formula").message };
  if (source.length > MAX_FORMULA_LENGTH) {
    return { ok: false, error: errorValue("formula exceeds maximum length").message };
  }
  if (evalDepth > MAX_NESTED_EVAL_DEPTH) {
    return { ok: false, error: errorValue("expression nested too deeply").message };
  }
  try {
    const value = new Parser(
      tokenize(source),
      scope,
      effectiveConstants(options.constants),
      options.rollups ?? {},
      evalDepth,
    ).parse();
    if (isError(value)) return { ok: false, error: value.message };
    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      error: errorValue(error instanceof Error ? error.message : String(error)).message,
    };
  }
}

/**
 * The constants an evaluation may read: `@/lib/formula-constants`'s defaults
 * overlaid by the caller's registry (so a caller constant shadows a built-in of
 * the same name, and vice versa the built-ins are always available).
 */
function effectiveConstants(caller: Record<string, unknown> | undefined): Record<string, unknown> {
  return caller === undefined ? { ...BUILTIN_CONSTANTS } : { ...BUILTIN_CONSTANTS, ...caller };
}

/**
 * Bounded memoisation of `(expression, scope)` results. The row-evaluation path
 * (`database-view`) calls {@link evaluateFormula} with only an expression and a
 * row scope, so repeated rows recompute nothing; `@/lib/formula-cache` keys each
 * entry by the *properties the expression actually reads*, so editing an
 * unrelated cell never misses. Only calls that depend on nothing but their text
 * and scope values are memoized (see {@link isMemoizable}).
 */
export const MAX_FORMULA_CACHE_ENTRIES = 1_000;

let resultCache: FormulaCache<FormulaResult> = createFormulaCache<FormulaResult>();
let cacheHits = 0;
let cacheMisses = 0;

/** Wall-clock keywords: an expression using them must never be reused. */
const VOLATILE_KEYWORDS = /\b(?:now|today)\b/i;

/**
 * Only an expression whose result depends on nothing but its text and scope
 * values can be keyed by `(expression, scope)`: `now`/`today` move with the
 * clock, and `constants`/`rollups` are not part of the cache key.
 */
function isMemoizable(expression: string, options: FormulaOptions): boolean {
  if (VOLATILE_KEYWORDS.test(expression)) return false;
  if (options.constants !== undefined && Object.keys(options.constants).length > 0) return false;
  if (options.rollups !== undefined && Object.keys(options.rollups).length > 0) return false;
  return true;
}

export type FormulaCacheStats = {
  readonly hits: number;
  readonly misses: number;
  readonly size: number;
};

/** Cache counters, for diagnostics and tests. */
export function formulaCacheStats(): FormulaCacheStats {
  return { hits: cacheHits, misses: cacheMisses, size: cacheSize(resultCache) };
}

/** Drop every memoised result and reset the counters. */
export function clearFormulaCache(): void {
  resultCache = createFormulaCache<FormulaResult>();
  cacheHits = 0;
  cacheMisses = 0;
}

/** Drop the memoised results whose expressions read `property` (case-insensitive). */
export function invalidateFormulaCacheByProperty(property: string): void {
  resultCache = invalidateByProperty(resultCache, property);
}

/**
 * Evaluates `expression` against row values (`scope`, read via `prop()`),
 * optional workspace `constants` (read by bare name) and typed rollup results
 * (`options.rollups`, read via `rollup("Name")`). Never throws: bad
 * syntax, unknown functions, division by zero, type mismatches and sandbox
 * violations all come back as `ok: false` with a friendly `#ERROR: …` message.
 *
 * Results with no `constants`/`rollups` and no `now`/`today` are memoized by
 * `(expression, scope)` in a bounded cache; use {@link clearFormulaCache} and
 * {@link invalidateFormulaCacheByProperty} to drop entries, and
 * {@link formulaCacheStats} to observe hit/miss counts. Returned values are
 * shared with the cache, so callers must treat them as read-only.
 */
export function evaluateFormula(
  expression: string,
  scope: FormulaScope = {},
  options: FormulaOptions = {},
): FormulaResult {
  const memoize = isMemoizable(expression, options);
  if (memoize) {
    const cached = getCached(resultCache, expression, scope);
    if (cached !== undefined) {
      cacheHits += 1;
      return cached;
    }
    cacheMisses += 1;
  }
  const result = runFormula(expression, scope, options, 0);
  if (memoize) {
    if (cacheSize(resultCache) >= MAX_FORMULA_CACHE_ENTRIES) {
      resultCache = invalidateAll(resultCache);
    }
    resultCache = setCached(resultCache, expression, scope, result);
  }
  return result;
}
