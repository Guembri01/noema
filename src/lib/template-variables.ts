import type { RichNode } from "./blocks";

/**
 * Template variable substitution (docs/specs/templates.md §D, R31.17-R31.19).
 *
 * A template's text may carry `{{name}}` tokens, optionally with a fallback —
 * `{{name|fallback}}` — so an instantiated page reads sensibly even when a
 * value is unknown. Everything here is pure and deterministic: no clock, no
 * globals, no mutation of inputs, no `eval` (the same whitelist posture as
 * `formula.ts`). This module is the shared resolver a template button, the
 * database row-template planner and the recurrence materialiser all call, so
 * they can never disagree about what a token means.
 *
 * The token grammar is intentionally tiny: a name (`[\w.-]+`, surrounding
 * whitespace ignored), then an optional `|` and a literal fallback up to the
 * closing `}}`. Anything malformed — `{{}}`, an unclosed `{{name`, nested
 * braces — is left **verbatim**, so a half-typed template never silently
 * loses text.
 *
 * **Missing variables become the empty string** when no fallback is given (a
 * present-but-empty value is *present*, so it also wins over the fallback).
 * This is the deliberate opposite of `row-buttons.ts`'s
 * `interpolateButtonText`, which keeps unknown tokens visible for an author to
 * fix; here the text is being *materialised*, so a lingering `{{token}}` in the
 * output would be a bug rather than a hint.
 */

/** A value a token can resolve to; `null`/`undefined` count as "missing". */
export type TemplateVariableValue = string | number | boolean;

/** The variables available to `interpolate`, keyed by token name. */
export type TemplateContext = Record<string, TemplateVariableValue | null | undefined>;

/** A `{{name}}` or `{{name|fallback}}` token occurrence. */
export interface TemplateToken {
  /** Token name without braces or fallback, whitespace trimmed. */
  name: string;
  /** Literal fallback text, or `undefined` when the token had no `|`. */
  fallback: string | undefined;
  /** The matched source text, e.g. `"{{name|fallback}}"`. */
  token: string;
  /** Zero-based index of the match in the source text. */
  index: number;
}

/** A validation problem, addressable by variable name in a template editor. */
export interface TemplateIssue {
  code: "unknown_variable";
  /** The unrecognised variable name. */
  name: string;
  /** The first occurrence's source text. */
  token: string;
  /** Zero-based index of the first occurrence. */
  index: number;
}

/** Options for `validateTemplate`. */
export interface TemplateValidationOptions {
  /** Names considered defined; unknown tokens are reported against it. */
  knownVars?: Iterable<string>;
}

/**
 * Fresh token regex per call: a module-level global regex carries `lastIndex`
 * between `matchAll`/`exec`, a state leak that would make results depend on
 * call order. A factory sidesteps it entirely.
 */
function tokenRegex(): RegExp {
  return /\{\{\s*([\w.-]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;
}

/** Iterate every well-formed token in `text`, in document order. */
function scanTokens(text: string): TemplateToken[] {
  if (typeof text !== "string" || text === "") return [];
  const tokens: TemplateToken[] = [];
  for (const match of text.matchAll(tokenRegex())) {
    const name = match[1];
    if (name === undefined) continue;
    tokens.push({
      name,
      fallback: match[2],
      token: match[0],
      index: match.index ?? 0,
    });
  }
  return tokens;
}

/** Reads a context value as a string; `undefined` means "not usable". */
function readValue(context: TemplateContext, name: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(context, name)) return undefined;
  const value = context[name];
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  return value ? "true" : "false";
}

/**
 * Replace every `{{name}}` / `{{name|fallback}}` token in `text`.
 *
 * Resolution order per token: a defined, non-nullish context value wins (the
 * empty string is a real value and suppresses the fallback); otherwise the
 * fallback; otherwise the **empty string**. A token that never matched the
 * grammar is returned untouched. `context` is never mutated.
 */
export function interpolate(text: string, context: TemplateContext = {}): string {
  if (typeof text !== "string") return "";
  return text.replace(tokenRegex(), (_match, name: string, fallback: string | undefined) => {
    const value = readValue(context, name);
    if (value !== undefined) return value;
    return fallback !== undefined ? fallback : "";
  });
}

/**
 * The variable names referenced by `text`, in first-appearance order and
 * deduped. Fallback text is never treated as a variable.
 */
export function extractVariables(text: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const { name } of scanTokens(text)) {
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * The names a context can currently supply — its own enumerable keys whose
 * value is not `null`/`undefined` — sorted lexicographically so an autocomplete
 * list is stable.
 */
export function availableVariables(context: TemplateContext = {}): string[] {
  if (!context || typeof context !== "object") return [];
  return Object.keys(context)
    .filter((name) => context[name] !== null && context[name] !== undefined)
    .sort();
}

/**
 * Report template variables that `knownVars` does not define.
 *
 * With no `knownVars` there is nothing to compare against, so the result is
 * empty. Each unknown name is reported once, at its first occurrence, ordered
 * by appearance; known variables and fallbacks never produce issues.
 */
export function validateTemplate(
  text: string,
  options: TemplateValidationOptions = {},
): TemplateIssue[] {
  const known = options.knownVars ? new Set(options.knownVars) : null;
  if (!known) return [];

  const issues: TemplateIssue[] = [];
  const reported = new Set<string>();
  for (const { name, token, index } of scanTokens(text)) {
    if (known.has(name) || reported.has(name)) continue;
    reported.add(name);
    issues.push({ code: "unknown_variable", name, token, index });
  }
  return issues;
}

/** A fresh node with `text` interpolated and `content` mapped recursively. */
function interpolateNode(node: RichNode, context: TemplateContext): RichNode {
  const next: RichNode = { ...node };
  if (typeof node.text === "string") next.text = interpolate(node.text, context);
  if (Array.isArray(node.content)) {
    next.content = node.content.map((child) => interpolateNode(child, context));
  }
  return next;
}

/**
 * Walk a block tree and interpolate every `text` field, returning a fresh tree.
 *
 * Only structure is cloned (nodes, `content` arrays); leaf values such as
 * `attrs`/`marks` are carried by reference and never mutated, so the input tree
 * is untouched and re-rendering is idempotent.
 */
export function interpolateBlocks(
  blocks: readonly RichNode[],
  context: TemplateContext = {},
): RichNode[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.map((block) => interpolateNode(block, context));
}

/** Ambient inputs the built-in variables are derived from. */
export interface BuiltinAmbient {
  /** The calendar day behind `{{date}}`. */
  today?: Date;
  /** The display name behind `{{user}}`. */
  user?: string;
  /** The materialisation instant behind `{{title}}`. */
  now?: Date;
}

/** `YYYY-MM-DD` for a valid `Date`, otherwise `undefined`. */
function isoDay(date: Date | undefined): string | undefined {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

/**
 * The built-in context variables, derived from ambient data.
 *
 * - `date` — the calendar day (`YYYY-MM-DD`, UTC) of `today`, falling back to
 *   `now` when `today` is absent: a page's authoring day.
 * - `title` — the calendar day of `now` only: the default title of a page
 *   materialised by a recurring template (R31.18), which must be stamped with
 *   the **run** day, not the day the template was written.
 * - `user` — the display name, when supplied.
 *
 * A built-in with no usable source is omitted, so `interpolate` treats it as
 * missing (its fallback, or the empty string). Invalid `Date`s are ignored
 * rather than rendered as `NaN`.
 */
export function renderBuiltins(ambient: BuiltinAmbient = {}): TemplateContext {
  const builtins: TemplateContext = {};
  const date = isoDay(ambient.today) ?? isoDay(ambient.now);
  if (date !== undefined) builtins.date = date;
  const title = isoDay(ambient.now);
  if (title !== undefined) builtins.title = title;
  if (typeof ambient.user === "string") builtins.user = ambient.user;
  return builtins;
}
