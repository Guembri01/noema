/**
 * A small, dependency-free formula language for database FORMULA properties.
 * Supports property references via `prop("Name")`, arithmetic, comparisons,
 * boolean logic, string concatenation with `+`, and a set of functions.
 * Pure and unit-tested.
 */

export type FormulaValue = number | string | boolean;
export type FormulaScope = Record<string, FormulaValue>;

export type FormulaResult =
  | { ok: true; value: FormulaValue }
  | { ok: false; error: string };

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
    if ("+-*/%<>()!,".includes(char)) {
      tokens.push({ kind: "op", value: char });
      i += 1;
      continue;
    }
    throw new Error(`Unexpected character "${char}"`);
  }
  tokens.push({ kind: "eof" });
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly scope: FormulaScope,
  ) {}

  parse(): FormulaValue {
    const value = this.or();
    if (this.peek().kind !== "eof") throw new Error("Unexpected trailing input");
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

  private or(): FormulaValue {
    let left = this.and();
    while (this.eat("||")) {
      const right = this.and();
      left = Boolean(left) || Boolean(right);
    }
    return left;
  }

  private and(): FormulaValue {
    let left = this.equality();
    while (this.eat("&&")) {
      const right = this.equality();
      left = Boolean(left) && Boolean(right);
    }
    return left;
  }

  private equality(): FormulaValue {
    let left = this.comparison();
    for (;;) {
      if (this.eat("==")) left = left === this.comparison();
      else if (this.eat("!=")) left = left !== this.comparison();
      else break;
    }
    return left;
  }

  private comparison(): FormulaValue {
    let left = this.additive();
    for (;;) {
      if (this.eat("<=")) left = Number(left) <= Number(this.additive());
      else if (this.eat(">=")) left = Number(left) >= Number(this.additive());
      else if (this.eat("<")) left = Number(left) < Number(this.additive());
      else if (this.eat(">")) left = Number(left) > Number(this.additive());
      else break;
    }
    return left;
  }

  private additive(): FormulaValue {
    let left = this.multiplicative();
    for (;;) {
      if (this.eat("+")) {
        const right = this.multiplicative();
        left =
          typeof left === "string" || typeof right === "string"
            ? `${left}${right}`
            : Number(left) + Number(right);
      } else if (this.eat("-")) {
        left = Number(left) - Number(this.multiplicative());
      } else break;
    }
    return left;
  }

  private multiplicative(): FormulaValue {
    let left = this.unary();
    for (;;) {
      if (this.eat("*")) left = Number(left) * Number(this.unary());
      else if (this.eat("/")) left = Number(left) / Number(this.unary());
      else if (this.eat("%")) left = Number(left) % Number(this.unary());
      else break;
    }
    return left;
  }

  private unary(): FormulaValue {
    if (this.eat("!")) return !Boolean(this.unary());
    if (this.eat("-")) return -Number(this.unary());
    return this.primary();
  }

  private primary(): FormulaValue {
    const token = this.peek();
    if (token.kind === "number" || token.kind === "string") {
      this.pos += 1;
      return token.value;
    }
    if (token.kind === "op" && token.value === "(") {
      this.pos += 1;
      const value = this.or();
      if (!this.eat(")")) throw new Error("Missing closing parenthesis");
      return value;
    }
    if (token.kind === "ident") {
      this.pos += 1;
      const name = token.value.toLowerCase();
      if (name === "true") return true;
      if (name === "false") return false;
      if (this.peek().kind === "op" && (this.peek() as { value: string }).value === "(") {
        this.pos += 1;
        const args: FormulaValue[] = [];
        if (!this.eat(")")) {
          args.push(this.or());
          while (this.eat(",")) args.push(this.or());
          if (!this.eat(")")) throw new Error("Missing closing parenthesis");
        }
        return this.call(name, args);
      }
      if (name === "now") return Date.now();
      if (name === "today") return new Date().toISOString().slice(0, 10);
      throw new Error(`Unknown identifier "${token.value}"`);
    }
    throw new Error("Unexpected end of expression");
  }

  private call(name: string, args: FormulaValue[]): FormulaValue {
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
        return String(args[0] ?? "").length;
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
      default:
        throw new Error(`Unknown function "${name}"`);
    }
  }
}

export function evaluateFormula(expression: string, scope: FormulaScope = {}): FormulaResult {
  const source = (expression ?? "").trim();
  if (!source) return { ok: false, error: "Empty formula" };
  try {
    const value = new Parser(tokenize(source), scope).parse();
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
