/**
 * Formula editor authoring support (formula-engine.md §6 — autocomplete +
 * signature help).
 *
 * Pure, dependency-free helpers a text editor composes to help a human write a
 * formula: lex a half-typed expression, decide what the caret is sitting on,
 * offer ranked completions and signature help, apply an insertion, surface
 * syntax / unknown-name diagnostics with ranges, and normalise spacing.
 *
 *   • `tokenizeFormula`      — lex into tokens plus recoverable syntax errors
 *   • `contextAt`            — what is the caret asking for?
 *   • `suggestCompletions`   — ranked functions-then-properties list
 *   • `signatureHelp`        — label, parameters and active parameter
 *   • `diagnose`             — syntax + unknown-function/identifier ranges
 *   • `applyCompletion`      — splice an item in and place the caret
 *   • `formatFormula`        — normalise spacing (unary/binary aware)
 *
 * Everything is total: broken or partial input never throws, so it is safe to
 * call on every keystroke. Only the catalog's *names* are imported (as a type),
 * never its behaviour or the evaluator.
 *
 * Red-first unit-pinned by `src/lib/formula-editor.test.ts`.
 */

import type { FormulaFunction } from "@/lib/formula-function-catalog";

export type FormulaTokenKind = "ident" | "number" | "string" | "op" | "paren" | "comma";

/** A lexical slice of the source; `text` is the exact source substring. */
export type FormulaToken = {
  readonly kind: FormulaTokenKind;
  readonly text: string;
  readonly start: number;
  readonly end: number;
};

/** A recoverable lexing problem; ranges are `[start, end)` offsets. */
export type FormulaSyntaxError = {
  readonly message: string;
  readonly start: number;
  readonly end: number;
};

export type TokenizeResult = {
  readonly tokens: FormulaToken[];
  readonly errors: FormulaSyntaxError[];
};

/** Two-character operators, matched before their single-character prefixes. */
const TWO_CHAR_OPERATORS = ["==", "!=", "<=", ">=", "&&", "||"] as const;

/** Single-character operators (after the two-character pass). */
const SINGLE_OPERATORS = "+-*/%<>!";

type OpenBracket = { readonly char: "(" | "["; readonly index: number };

/**
 * Lex a formula into tokens plus recoverable errors. Never throws: an
 * unterminated string runs to the end of the input, an unexpected character is
 * recorded and skipped, and unbalanced parentheses/brackets are reported.
 * Whitespace is dropped from the token stream but preserved in every token's
 * `text` and offsets, so the source can always be reconstructed.
 */
export function tokenizeFormula(src: string): TokenizeResult {
  const tokens: FormulaToken[] = [];
  const errors: FormulaSyntaxError[] = [];
  const open: OpenBracket[] = [];
  let index = 0;

  while (index < src.length) {
    const char = src[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (/[0-9.]/.test(char)) {
      let end = index;
      while (end < src.length && /[0-9._]/.test(src[end])) end += 1;
      tokens.push({ kind: "number", text: src.slice(index, end), start: index, end });
      index = end;
      continue;
    }

    if (char === '"' || char === "'") {
      const quote = char;
      let end = index + 1;
      let terminated = false;
      while (end < src.length) {
        if (src[end] === "\\" && end + 1 < src.length) {
          end += 2;
          continue;
        }
        if (src[end] === quote) {
          end += 1;
          terminated = true;
          break;
        }
        end += 1;
      }
      tokens.push({ kind: "string", text: src.slice(index, end), start: index, end });
      if (!terminated) {
        errors.push({
          message: `unterminated string literal (missing closing ${quote})`,
          start: index,
          end,
        });
      }
      index = end;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      let end = index;
      while (end < src.length && /[A-Za-z0-9_]/.test(src[end])) end += 1;
      tokens.push({ kind: "ident", text: src.slice(index, end), start: index, end });
      index = end;
      continue;
    }

    const two = src.slice(index, index + 2);
    if ((TWO_CHAR_OPERATORS as readonly string[]).includes(two)) {
      tokens.push({ kind: "op", text: two, start: index, end: index + 2 });
      index += 2;
      continue;
    }

    if (char === ",") {
      tokens.push({ kind: "comma", text: ",", start: index, end: index + 1 });
      index += 1;
      continue;
    }

    if (char === "(" || char === ")" || char === "[" || char === "]") {
      const kind: FormulaTokenKind = char === "(" || char === ")" ? "paren" : "op";
      tokens.push({ kind, text: char, start: index, end: index + 1 });
      if (char === "(" || char === "[") {
        open.push({ char, index });
      } else {
        const top = open[open.length - 1];
        const expected = char === ")" ? "(" : "[";
        if (top !== undefined && top.char === expected) {
          open.pop();
        } else {
          errors.push({ message: `unexpected '${char}'`, start: index, end: index + 1 });
        }
      }
      index += 1;
      continue;
    }

    if (SINGLE_OPERATORS.includes(char)) {
      tokens.push({ kind: "op", text: char, start: index, end: index + 1 });
      index += 1;
      continue;
    }

    errors.push({ message: `unexpected character '${char}'`, start: index, end: index + 1 });
    index += 1;
  }

  for (const bracket of open) {
    const closing = bracket.char === "(" ? ")" : "]";
    errors.push({
      message: `missing closing '${closing}'`,
      start: bracket.index,
      end: bracket.index + 1,
    });
  }
  errors.sort((left, right) => left.start - right.start || left.end - right.end);

  return { tokens, errors };
}

export type FormulaContextKind = "function" | "property" | "root" | "arg";

/** What the caret is asking for, plus the fragment a completion should replace. */
export type FormulaContext = {
  readonly kind: FormulaContextKind;
  /** Identifier or partial string content immediately before the caret. */
  readonly prefix: string;
  /** Argument index within the enclosing call (0 outside any call). */
  readonly argIndex: number;
  /** Lowercased enclosing call name for `arg`/`property` contexts. */
  readonly functionName?: string;
  /** Start offset of the fragment a completion replaces. */
  readonly start: number;
  /** End offset of the fragment a completion replaces (the clamped caret). */
  readonly end: number;
};

type CallFrame = { name: string; argIndex: number };

/**
 * Classify the caret position. Inside a `prop("…")`/`rollup("…")` first-argument
 * string the result is `property` (property names); inside any other call it is
 * `arg` (with `functionName`/`argIndex`); a bare identifier at the top level is
 * `function`; everything else is `root`. The caret is clamped into range and the
 * returned `start`/`end` delimit the text a completion should replace.
 */
export function contextAt(src: string, caret: number): FormulaContext {
  const pos = Math.max(0, Math.min(caret, src.length));
  const { tokens } = tokenizeFormula(src);

  const stack: CallFrame[] = [];
  let previous: FormulaToken | undefined;
  let active: FormulaToken | undefined;

  for (const token of tokens) {
    if (token.start >= pos) break;

    if (token.end <= pos) {
      if (token.text === "(" || token.text === "[") {
        let name = "";
        if (token.text === "(" && previous !== undefined && previous.kind === "ident") {
          name = previous.text.toLowerCase();
        }
        stack.push({ name, argIndex: 0 });
      } else if (token.text === ")" || token.text === "]") {
        stack.pop();
      } else if (token.kind === "comma" && stack.length > 0) {
        stack[stack.length - 1].argIndex += 1;
      }
      previous = token;
    }

    if ((token.kind === "ident" || token.kind === "string") && pos <= token.end) {
      active = token;
    }
  }

  const frame = stack[stack.length - 1];
  const functionName = frame !== undefined && frame.name !== "" ? frame.name : undefined;
  const argIndex = frame?.argIndex ?? 0;

  if (active !== undefined && active.kind === "string") {
    const isReferenceString =
      frame !== undefined && (frame.name === "prop" || frame.name === "rollup") && frame.argIndex === 0;
    if (isReferenceString) {
      const contentStart = active.start + 1;
      return {
        kind: "property",
        prefix: src.slice(contentStart, pos),
        argIndex: 0,
        functionName: frame.name,
        start: contentStart,
        end: pos,
      };
    }
    return { kind: functionName === undefined ? "root" : "arg", prefix: "", argIndex, functionName, start: pos, end: pos };
  }

  if (active !== undefined && active.kind === "ident") {
    const prefix = src.slice(active.start, pos);
    return {
      kind: functionName === undefined ? "function" : "arg",
      prefix,
      argIndex,
      functionName,
      start: active.start,
      end: pos,
    };
  }

  return { kind: functionName === undefined ? "root" : "arg", prefix: "", argIndex, functionName, start: pos, end: pos };
}

export type FormulaCompletionKind = "function" | "property";

/** One ranked completion; `replaceRange` is `[start, end)` in the source. */
export type FormulaCompletionItem = {
  readonly label: string;
  readonly kind: FormulaCompletionKind;
  readonly detail: string;
  readonly insertText: string;
  readonly replaceRange: { readonly start: number; readonly end: number };
};

export type CompletionSources = {
  /** Property names of the current database, offered as references. */
  readonly properties?: readonly string[];
};

/** Locale-independent ordering, case-insensitive with a raw tiebreak. */
function compareIgnoreCase(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a !== b) return a < b ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Rank completions for a context: functions first, then properties, each group
 * prefix-matched case-insensitively and sorted alphabetically for a fully
 * deterministic order. Inside a `property` context only property names are
 * offered (and the insertion closes the string); elsewhere a property inserts a
 * complete `prop("Name")` reference and a function inserts `name()`.
 */
export function suggestCompletions(
  catalog: readonly FormulaFunction[],
  sources: CompletionSources,
  ctx: FormulaContext,
): FormulaCompletionItem[] {
  const replaceRange = { start: ctx.start, end: ctx.end };
  const needle = ctx.prefix.toLowerCase();
  const propertyContext = ctx.kind === "property";
  const items: FormulaCompletionItem[] = [];

  if (!propertyContext) {
    const functions = catalog
      .filter((entry) => entry.name.startsWith(needle))
      .slice()
      .sort((left, right) => compareIgnoreCase(left.name, right.name));
    for (const entry of functions) {
      items.push({
        label: entry.name,
        kind: "function",
        detail: entry.signature,
        insertText: `${entry.name}()`,
        replaceRange,
      });
    }
  }

  const properties = (sources.properties ?? [])
    .filter((name) => name.toLowerCase().startsWith(needle))
    .slice()
    .sort(compareIgnoreCase);
  for (const name of properties) {
    items.push({
      label: name,
      kind: "property",
      detail: "property",
      insertText: propertyContext ? `${name}")` : `prop("${name}")`,
      replaceRange,
    });
  }

  return items;
}

export type SignatureHelp = {
  readonly label: string;
  readonly parameters: string[];
  readonly activeParameter: number;
  readonly doc: string;
};

/** Split a signature like `round(value, digits?)` into `["value", "digits?"]`. */
function parseParameters(signature: string): string[] {
  const open = signature.indexOf("(");
  const close = signature.lastIndexOf(")");
  if (open < 0 || close <= open) return [];
  const inner = signature.slice(open + 1, close).trim();
  if (inner === "") return [];
  return inner
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/**
 * Signature help for a call: the full label, the parameter labels, the active
 * parameter (clamped into range) and the function's one-line doc. Returns
 * `null` for a name the catalog does not know; lookup is case-insensitive.
 */
export function signatureHelp(
  catalog: readonly FormulaFunction[],
  functionName: string,
  argIndex: number,
): SignatureHelp | null {
  const needle = functionName.trim().toLowerCase();
  const entry = catalog.find((candidate) => candidate.name === needle);
  if (entry === undefined) return null;
  const parameters = parseParameters(entry.signature);
  const activeParameter =
    parameters.length === 0 ? 0 : Math.min(Math.max(argIndex, 0), parameters.length - 1);
  return {
    label: entry.signature,
    parameters,
    activeParameter,
    doc: entry.description,
  };
}

export type FormulaDiagnosticCode = "syntax" | "unknown_function" | "unknown_identifier";

/** A range-anchored problem for the editor's error line / squiggles. */
export type FormulaDiagnostic = {
  readonly message: string;
  readonly start: number;
  readonly end: number;
  readonly severity: "error";
  readonly code: FormulaDiagnosticCode;
};

/** Bare identifiers the language owns: literals and map()/filter() variables. */
const KEYWORD_IDENTIFIERS = new Set(["true", "false", "now", "today", "item", "index"]);

/** Reference-form calls the evaluator exposes but the catalog does not list. */
const EXTRA_CALLS = new Set(["rollup"]);

/**
 * Diagnose an expression against the catalog: lexing errors become `syntax`
 * diagnostics, call-shaped names absent from the catalog become
 * `unknown_function`, and bare identifiers that are not keywords become
 * `unknown_identifier`. All ranges are `[start, end)` and the result is ordered
 * by position. Unknown bare identifiers are expected until a constant registry
 * explains them, so an editor may merge this with its own name resolution.
 */
export function diagnose(
  src: string,
  catalog: readonly FormulaFunction[],
): FormulaDiagnostic[] {
  const { tokens, errors } = tokenizeFormula(src);
  const diagnostics: FormulaDiagnostic[] = errors.map((error) => ({
    message: error.message,
    start: error.start,
    end: error.end,
    severity: "error",
    code: "syntax",
  }));

  const knownFunctions = new Set(catalog.map((entry) => entry.name));
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "ident") continue;
    const lower = token.text.toLowerCase();
    const next = tokens[index + 1];
    const isCall = next !== undefined && next.text === "(";
    if (isCall) {
      if (!knownFunctions.has(lower) && !EXTRA_CALLS.has(lower)) {
        diagnostics.push({
          message: `unknown function '${token.text}'`,
          start: token.start,
          end: token.end,
          severity: "error",
          code: "unknown_function",
        });
      }
      continue;
    }
    if (KEYWORD_IDENTIFIERS.has(lower)) continue;
    diagnostics.push({
      message: `unknown identifier '${token.text}'`,
      start: token.start,
      end: token.end,
      severity: "error",
      code: "unknown_identifier",
    });
  }

  return diagnostics;
}

export type AppliedCompletion = {
  readonly text: string;
  /** Caret offset into `text`; inside the parentheses for a function call. */
  readonly caret: number;
};

/**
 * Splice a completion into the source, replacing its `replaceRange`. The caret
 * lands after the inserted text, except a function call (which ends with `()`)
 * places it between the parentheses so the first argument can be typed at once.
 */
export function applyCompletion(src: string, item: FormulaCompletionItem): AppliedCompletion {
  const { start, end } = item.replaceRange;
  const text = src.slice(0, start) + item.insertText + src.slice(end);
  let caret = start + item.insertText.length;
  if (item.kind === "function" && item.insertText.endsWith("()")) caret -= 1;
  return { text, caret };
}

/** True when an operator contributes no operand of its own (unary `!`/`-`). */
function computeUnary(tokens: readonly FormulaToken[]): boolean[] {
  return tokens.map((token, index) => {
    if (token.kind !== "op") return false;
    if (token.text === "!") return true;
    if (token.text !== "-") return false;
    const previous = index > 0 ? tokens[index - 1] : undefined;
    if (previous === undefined) return true;
    if (previous.kind === "op" || previous.kind === "comma") return true;
    return previous.text === "(" || previous.text === "[";
  });
}

/** Whitespace to emit before `cur`, given the previous token and unary flags. */
function connector(
  previous: FormulaToken | undefined,
  cur: FormulaToken,
  curUnary: boolean,
  prevUnary: boolean,
): string {
  if (previous === undefined) return "";
  if (cur.kind === "comma") return "";
  if (cur.text === ")" || cur.text === "]") return "";
  if (previous.text === "(" || previous.text === "[") return "";
  if (previous.kind === "comma") return " ";
  if (cur.text === "(" || cur.text === "[") {
    return previous.kind === "ident" || previous.text === ")" || previous.text === "]" ? "" : " ";
  }
  if (curUnary) return previous.kind === "op" && !prevUnary ? " " : "";
  if (prevUnary) return "";
  return " ";
}

/**
 * Normalise spacing: one space around binary operators, none inside
 * parentheses/brackets/calls, one after commas, and unary `-`/`!` attached to
 * their operand. Tokens (names, numbers, string literals) are preserved
 * verbatim; input that fails to lex is returned unchanged rather than mangled.
 */
export function formatFormula(src: string): string {
  const { tokens, errors } = tokenizeFormula(src);
  if (errors.length > 0) return src;

  const unary = computeUnary(tokens);
  let output = "";
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = index > 0 ? tokens[index - 1] : undefined;
    output += connector(previous, token, unary[index], index > 0 ? unary[index - 1] : false);
    output += token.text;
  }
  return output;
}
