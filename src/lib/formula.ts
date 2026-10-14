/**
 * A small, dependency-free formula language for database FORMULA properties.
 * Supports property references via `prop("Name")`, workspace-level named
 * constants by bare name, arithmetic, comparisons, boolean logic, string
 * concatenation with `+`, array literals, and a set of functions (math, text,
 * logic, regex, list). Pure and unit-tested.
 *
 * Errors are values, not exceptions: bad syntax, unknown functions, division
 * by zero, type mismatches and sandbox violations all surface as friendly
 * structured results (`#ERROR: …`) from `evaluateFormula`.
 */

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

/** Capture groups of every match; falls back to full matches when there are none. */
function regexExtract(text: string, pattern: string): FormulaValue | FormulaErrorValue {
  const regex = compileBoundedRegex(text, pattern, "g");
  if (isError(regex)) return regex;
  const groups: string[] = [];
  let found: RegExpExecArray | null = regex.exec(text);
  while (found !== null) {
    const match = found.slice(1).filter((group) => group !== undefined);
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
      if (j >= input.length) throw new Error("unterminated string literal");
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
    throw new Error(`unexpected character "${char}"`);
  }
  tokens.push({ kind: "eof" });
  return tokens;
}

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly scope: FormulaScope,
    private readonly constants: Record<string, unknown>,
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
      if (!this.eat(")")) throw new Error("missing closing parenthesis");
      return value;
    }
    if (token.kind === "op" && token.value === "[") {
      this.pos += 1;
      const items: ExprValue[] = [];
      if (!this.eat("]")) {
        items.push(this.or());
        while (this.eat(",")) items.push(this.or());
        if (!this.eat("]")) throw new Error("missing closing bracket");
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
          if (!this.eat(")")) throw new Error("missing closing parenthesis");
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
    throw new Error("unexpected end of expression");
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

  private call(name: string, args: ExprValue[], displayName: string): ExprValue {
    if (name === "if") {
      const condition = args[0];
      if (isError(condition)) return condition;
      // if() is branch-selecting: errors in untaken branches never surface.
      return Boolean(condition) ? args[1] : args[2];
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
      { constants: this.constants },
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
        return regexExtract(String(args[0] ?? ""), String(pattern));
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
    const value = new Parser(tokenize(source), scope, options.constants ?? {}, evalDepth).parse();
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
 * Evaluates `expression` against row values (`scope`, read via `prop()`) and
 * optional workspace `constants` (read by bare name). Never throws: bad
 * syntax, unknown functions, division by zero, type mismatches and sandbox
 * violations all come back as `ok: false` with a friendly `#ERROR: …` message.
 */
export function evaluateFormula(
  expression: string,
  scope: FormulaScope = {},
  options: FormulaOptions = {},
): FormulaResult {
  return runFormula(expression, scope, options, 0);
}
