/**
 * Pure, testable validation for database cell values.
 *
 * A property carries optional constraints in its `config` (`min`/`max` for
 * NUMBER, `minLength`/`maxLength`/`pattern` for TEXT, `options` for
 * SELECT/MULTI_SELECT) plus a `required` flag; a cell holds a wrapped value
 * (`{ text }`, `{ number }`, `{ optionId }`, `{ optionIds }`, `{ start, end }`,
 * `{ checked }`, …). This module decides whether one value satisfies its
 * property and aggregates those decisions for a row and for a batch of rows.
 *
 * Design rules (docs/specs/database-deep.md R89.29 "required validation";
 * docs/FEATURE_MATRIX.md §3 "Number property … validation basic"):
 *
 * - **Fail-safe by contract.** Stored config and rows round-trip through the DB
 *   as untrusted JSON, so every field is checked at runtime. Nothing here ever
 *   throws: a null property, an odd value, an unparseable number or an invalid
 *   `pattern` is tolerated — an unknown property type is permissive.
 * - **Empty means missing.** `null`, `undefined`, an empty/whitespace string,
 *   an empty array and a wrapped value whose only contents are empty are all
 *   "missing". An (un)checked checkbox always counts as present.
 * - **Constraints are inclusive** (`min`/`max`, `minLength`/`maxLength`) and
 *   only run for the property type they belong to.
 * - **A stored `pattern` is never applied unbounded.** A pattern that does
 *   not compile, and a pattern whose backtracking can explode (a quantified
 *   group with an alternation or a nested quantifier), are both ignored: the
 *   constraint does not run, so a pattern can neither reject every value nor
 *   freeze the editor that evaluates it.
 *
 * No DB, no routes, no React — a cell editor can import this directly and a
 * server action can re-validate with the exact same rules.
 */

import { MAX_REGEX_EVALUATION_MS, estimatedRegexSteps } from "./formula";

/** Machine-readable reason a cell value was rejected. */
export type CellErrorCode =
  /** A `required` property has an empty value. */
  | "REQUIRED"
  /** NUMBER below `config.min`. */
  | "MIN"
  /** NUMBER above `config.max`. */
  | "MAX"
  /** TEXT shorter than `config.minLength`. */
  | "MIN_LENGTH"
  /** TEXT longer than `config.maxLength`. */
  | "MAX_LENGTH"
  /** TEXT that does not match `config.pattern`. */
  | "PATTERN"
  /** SELECT/MULTI_SELECT value not among `config.options`. */
  | "SELECT_OPTION"
  /** DATE whose `end` is before its `start`. */
  | "DATE_RANGE";

export type CellError = {
  code: CellErrorCode;
  message: string;
};

/** `ok: true` when the value satisfies every rule; otherwise the failures. */
export type CellValidation =
  | { ok: true }
  | { ok: false; errors: CellError[] };

/** The issues found on one property of one row (only failing properties). */
export type PropertyIssue = {
  propertyId: string;
  propertyName: string;
  errors: CellError[];
};

/** The issues found across one row of a batch (only rows with issues). */
export type RowIssues = {
  rowId: string | null;
  issues: PropertyIssue[];
};

/** What this module actually reads from a property; every field is untrusted. */
type NormalizedProperty = {
  id: string;
  name: string;
  type: string;
  required: boolean;
  primary: boolean;
  config: Record<string, unknown>;
};

/**
 * Coerce an untrusted property into the fields the validators use. Returns
 * `null` for anything that is not an object, which callers treat as "no rule to
 * enforce" (permissive) rather than an error.
 */
function asProperty(input: unknown): NormalizedProperty | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const name = raw.name;
  const type = raw.type;
  const config = raw.config;
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    name: typeof name === "string" && name.trim() !== "" ? name : "Value",
    type: typeof type === "string" ? type : "",
    required: raw.required === true,
    primary:
      !!config &&
      typeof config === "object" &&
      !Array.isArray(config) &&
      (config as Record<string, unknown>).primary === true,
    config:
      config && typeof config === "object" && !Array.isArray(config)
        ? (config as Record<string, unknown>)
        : {},
  };
}

/**
 * Whether a value is "empty" for required purposes. Strings are trimmed,
 * arrays must have content, and a wrapped value counts as empty only when every
 * one of its own fields is empty (so `{ checked: false }` and `{ number: 0 }`
 * are present). Guarded against cycles and pathological nesting.
 */
function isBlank(value: unknown, seen?: WeakSet<object>, depth = 0): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (typeof value === "number") return !Number.isFinite(value);
  if (typeof value === "boolean") return false;
  if (typeof value === "function" || typeof value === "symbol") return false;
  if (depth >= 8) return false; // depth/cycle guard: assume present, never recurse forever
  if (typeof value === "object") {
    const visited = seen ?? new WeakSet<object>();
    if (visited.has(value)) return false;
    visited.add(value);
    if (Array.isArray(value)) {
      if (value.length === 0) return true;
      return value.every((entry) => isBlank(entry, visited, depth + 1));
    }
    const entries = Object.values(value as Record<string, unknown>);
    if (entries.length === 0) return true;
    return entries.every((entry) => isBlank(entry, visited, depth + 1));
  }
  return false;
}

/**
 * True when `property` is required and `value` is empty. Non-required
 * properties are never "missing" — there is nothing to enforce.
 */
export function isRequiredMissing(property: unknown, value: unknown): boolean {
  const normalized = asProperty(property);
  if (!normalized || !normalized.required) return false;
  return isBlank(value);
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === "object") {
    return toFiniteNumber((value as Record<string, unknown>).number);
  }
  return null;
}

function toNonNegativeInt(value: unknown): number | null {
  const parsed = toFiniteNumber(value);
  if (parsed === null || parsed < 0) return null;
  return Math.floor(parsed);
}

function toText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const text = (value as Record<string, unknown>).text;
    if (typeof text === "string") return text;
  }
  return null;
}

function toOptionId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const id = (value as Record<string, unknown>).optionId;
    if (typeof id === "string") return id;
  }
  return null;
}

function toOptionIds(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (value && typeof value === "object") {
    const raw = (value as Record<string, unknown>).optionIds;
    if (Array.isArray(raw)) {
      return raw.filter((entry): entry is string => typeof entry === "string");
    }
  }
  return null;
}

function optionIdsOf(options: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(options)) return ids;
  for (const option of options) {
    if (option && typeof option === "object") {
      const id = (option as Record<string, unknown>).id;
      if (typeof id === "string") ids.add(id);
    }
  }
  return ids;
}

function dateRangeOf(value: unknown): { start: string | null; end: string | null } {
  if (typeof value === "string") return { start: value, end: null };
  if (value && typeof value === "object") {
    const raw = value as Record<string, unknown>;
    return {
      start: typeof raw.start === "string" ? raw.start : null,
      end: typeof raw.end === "string" ? raw.end : null,
    };
  }
  return { start: null, end: null };
}

/**
 * Whether a group body holds an alternation (`|`). Escapes and character
 * classes are skipped, so `([a|b])` is not an alternation.
 */
function containsAlternation(body: string): boolean {
  let inClass = false;
  let i = 0;
  while (i < body.length) {
    const char = body[i];
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
    if (char === "|") return true;
    i += 1;
  }
  return false;
}

/**
 * Where the content of the group that opens at `open` starts. A group may
 * carry a prefix — `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`, `(?<name>` — and that
 * prefix is group syntax, not a quantifier on the content.
 */
function groupBodyStart(pattern: string, open: number): number {
  if (pattern[open + 1] !== "?") return open + 1;
  const marker = open + 2;
  if (pattern[marker] === "<") {
    if (pattern[marker + 1] === "=" || pattern[marker + 1] === "!") {
      return marker + 2;
    }
    const close = pattern.indexOf(">", marker);
    return close === -1 ? open + 1 : close + 1;
  }
  if (
    pattern[marker] === ":" ||
    pattern[marker] === "=" ||
    pattern[marker] === "!"
  ) {
    return marker + 1;
  }
  return open + 1; // unknown group syntax: the prefix stays part of the body
}

/**
 * Best-effort guard against catastrophic backtracking: refuses a quantified
 * group whose body can match the same text in more than one way — a nested
 * quantifier (`(a+)+`) or an alternation (`(a|aa)+`). Both are the classic
 * exponential blow-ups, and the alternation carries no inner quantifier, so a
 * quantifier-only check lets it through. Escapes and character classes are
 * skipped. Conservative on purpose: a pattern it refuses is not applied.
 *
 * The same guard stands between a formula and the regex engine
 * (`@/lib/formula`); a stored property pattern is as untrusted as a formula.
 */
function hasRiskyQuantifiedGroup(pattern: string): boolean {
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
      groupStarts.push(groupBodyStart(pattern, i));
      i += 1;
      continue;
    }
    if (char === ")") {
      const start = groupStarts.pop();
      const quantifier = pattern[i + 1];
      if (
        start !== undefined &&
        (quantifier === "+" || quantifier === "*" || quantifier === "{")
      ) {
        const body = pattern.slice(start, i);
        if (/[+*?{]/.test(body) || containsAlternation(body)) return true;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return false;
}

/**
 * Compile a stored pattern safely. An invalid regex is not an error — it is
 * ignored, so a bad pattern can never reject every value or throw. The same
 * holds for a pattern whose backtracking can explode: the quantifier guard
 * refuses it and the constraint is not applied, so a stored pattern can never
 * freeze the editor that evaluates it.
 */
function safeRegex(pattern: string, text: string): RegExp | null {
  if (hasRiskyQuantifiedGroup(pattern)) return null;
  try {
    // The formula engine's cost model covers the polynomial shapes the group
    // scan misses (`a*a*a*…b`). A stored pattern is as untrusted as a formula,
    // and this check runs before the regex is compiled.
    const steps = estimatedRegexSteps(text, pattern);
    if (!Number.isFinite(steps) || steps > MAX_REGEX_EVALUATION_MS * 1_000_000) {
      return null;
    }
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/** Apply the constraints that belong to `property.type` to a present value. */
function applyTypeConstraints(
  property: NormalizedProperty,
  value: unknown,
  errors: CellError[],
): void {
  const { name } = property;
  switch (property.type) {
    case "NUMBER": {
      const number = toFiniteNumber(value);
      if (number === null) return; // unreadable value: nothing to compare
      const min = toFiniteNumber(property.config.min);
      const max = toFiniteNumber(property.config.max);
      if (min !== null && number < min) {
        errors.push({ code: "MIN", message: `${name} must be at least ${min}.` });
      }
      if (max !== null && number > max) {
        errors.push({ code: "MAX", message: `${name} must be at most ${max}.` });
      }
      return;
    }
    case "TEXT": {
      const text = toText(value);
      if (text === null) return; // not a text cell: constraints do not apply
      const minLength = toNonNegativeInt(property.config.minLength);
      const maxLength = toNonNegativeInt(property.config.maxLength);
      if (minLength !== null && text.length < minLength) {
        errors.push({
          code: "MIN_LENGTH",
          message: `${name} must be at least ${minLength} characters.`,
        });
      }
      if (maxLength !== null && text.length > maxLength) {
        errors.push({
          code: "MAX_LENGTH",
          message: `${name} must be at most ${maxLength} characters.`,
        });
      }
      const pattern = property.config.pattern;
      if (typeof pattern === "string" && pattern !== "") {
        const regex = safeRegex(pattern, text);
        if (regex && !regex.test(text)) {
          errors.push({
            code: "PATTERN",
            message: `${name} does not match the required pattern.`,
          });
        }
      }
      return;
    }
    case "SELECT":
    case "STATUS": {
      const known = optionIdsOf(property.config.options);
      if (known.size === 0) return; // no options configured: cannot judge
      const optionId = toOptionId(value);
      if (optionId !== null && !known.has(optionId)) {
        errors.push({
          code: "SELECT_OPTION",
          message: `${name} must be one of the configured options.`,
        });
      }
      return;
    }
    case "MULTI_SELECT": {
      const known = optionIdsOf(property.config.options);
      if (known.size === 0) return;
      const optionIds = toOptionIds(value);
      if (optionIds && optionIds.some((id) => !known.has(id))) {
        errors.push({
          code: "SELECT_OPTION",
          message: `${name} must only use the configured options.`,
        });
      }
      return;
    }
    case "DATE": {
      const { start, end } = dateRangeOf(value);
      if (start === null || end === null) return; // single date/no range
      const startTime = Date.parse(start);
      const endTime = Date.parse(end);
      if (Number.isFinite(startTime) && Number.isFinite(endTime) && endTime < startTime) {
        errors.push({
          code: "DATE_RANGE",
          message: `${name} must end on or after its start date.`,
        });
      }
      return;
    }
    case "CHECKBOX":
    default:
      return; // checkbox always valid; unknown types are permissive
  }
}

/**
 * Validate one cell value against one property.
 *
 * A missing `required` value short-circuits: an empty cell reports only
 * `REQUIRED`, never a cascade of length/pattern errors. A present optional
 * value with nothing to check is `ok`.
 */
export function validateCell(property: unknown, value: unknown): CellValidation {
  const errors: CellError[] = [];
  try {
    const normalized = asProperty(property);
    if (!normalized) return { ok: true };
    if (normalized.required && isBlank(value)) {
      return {
        ok: false,
        errors: [{ code: "REQUIRED", message: `${normalized.name} is required.` }],
      };
    }
    if (isBlank(value)) return { ok: true };
    applyTypeConstraints(normalized, value, errors);
  } catch {
    // Fail open: an exotic value must never break the caller.
    return { ok: true };
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

/** Read one value from a row, supporting `{ propertyValues }` and plain maps. */
function readRowValue(row: unknown, propertyId: string): unknown {
  if (!row || typeof row !== "object") return undefined;
  const record = row as Record<string, unknown>;
  if (Array.isArray(record.propertyValues)) {
    for (const entry of record.propertyValues) {
      if (entry && typeof entry === "object") {
        const item = entry as Record<string, unknown>;
        if (item.propertyId === propertyId) return item.value;
      }
    }
    return undefined;
  }
  return record[propertyId];
}

/** The value for a property, with the primary-property fallback to row title. */
function valueForRow(row: unknown, property: NormalizedProperty): unknown {
  const direct = readRowValue(row, property.id);
  if (direct !== undefined) return direct;
  if (property.primary && row && typeof row === "object") {
    const title = (row as Record<string, unknown>).title;
    if (typeof title === "string") return { text: title };
  }
  return direct;
}

/** Read a row's identifier, or `null` when it has none. */
function readRowId(row: unknown): string | null {
  if (row && typeof row === "object") {
    const id = (row as Record<string, unknown>).id;
    if (typeof id === "string" && id !== "") return id;
  }
  return null;
}

/**
 * Validate every property against one row. Returns one entry per failing
 * property (in schema order); an empty list means the row is valid. Handles
 * `{ propertyValues }` rows and plain `propertyId → value` maps, and falls back
 * to `row.title` for the primary property.
 */
export function validateRow(properties: unknown, row: unknown): PropertyIssue[] {
  const issues: PropertyIssue[] = [];
  try {
    const list = Array.isArray(properties) ? properties : [];
    for (const candidate of list) {
      const property = asProperty(candidate);
      if (!property) continue;
      const result = validateCell(property, valueForRow(row, property));
      if (!result.ok) {
        issues.push({
          propertyId: property.id,
          propertyName: property.name,
          errors: result.errors,
        });
      }
    }
  } catch {
    return issues;
  }
  return issues;
}

/**
 * Validate a batch of rows. Returns one entry per row that has at least one
 * issue (in input order); rows that are fully valid are omitted. Never throws.
 */
export function validateValues(properties: unknown, rows: unknown): RowIssues[] {
  const out: RowIssues[] = [];
  try {
    const list = Array.isArray(rows) ? rows : [];
    for (const row of list) {
      const issues = validateRow(properties, row);
      if (issues.length > 0) out.push({ rowId: readRowId(row), issues });
    }
  } catch {
    return out;
  }
  return out;
}

/**
 * Aggregate issues into per-property counts, most frequent first (ties broken
 * by property id for a stable order). Accepts the output of `validateRow` or a
 * `RowIssues[]` batch (flattened automatically). Never throws.
 */
export function summarizeIssues(
  issues: unknown,
): { propertyId: string; count: number }[] {
  const counts = new Map<string, number>();
  try {
    const list = Array.isArray(issues) ? issues : [];
    for (const candidate of list) {
      if (!candidate || typeof candidate !== "object") continue;
      const record = candidate as Record<string, unknown>;
      if (Array.isArray(record.issues)) {
        for (const nested of summarizeIssues(record.issues)) {
          counts.set(nested.propertyId, (counts.get(nested.propertyId) ?? 0) + nested.count);
        }
        continue;
      }
      const propertyId = typeof record.propertyId === "string" ? record.propertyId : "";
      const errors = Array.isArray(record.errors) ? record.errors : [];
      if (propertyId === "" || errors.length === 0) continue;
      counts.set(propertyId, (counts.get(propertyId) ?? 0) + errors.length);
    }
  } catch {
    // Fall through with whatever was counted before the failure.
  }
  return [...counts.entries()]
    .map(([propertyId, count]) => ({ propertyId, count }))
    .sort((a, b) => b.count - a.count || a.propertyId.localeCompare(b.propertyId));
}
