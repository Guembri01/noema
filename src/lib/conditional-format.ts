/**
 * Conditional formatting / row colour rules (docs/MISSING_FEATURES.md §3,
 * "Conditional formatting" and "Row color rules").
 *
 * A `FormatRule` pairs a condition on one property with a style. This module is
 * the pure brain behind a rules editor and a table renderer:
 *
 * - `parseFormatRule`  — read an untrusted saved rule (JSON) into a `FormatRule`,
 *                        dropping anything unsafe; `null` when unusable.
 * - `validateFormatRule` — check a rule against the live schema (unknown
 *                        property/operator, unsafe style, duplicate priority).
 * - `evaluateRule`     — does one rule's condition hold for a row?
 * - `resolveRowStyle`  — the winning row style (first match by priority) plus
 *                        every rule id that matched.
 * - `reorderRules`     — immutable drag-to-reorder that keeps `priority` in
 *                        step with the array order.
 * - `describeRule`     — a human summary for the rules list.
 * - `toCss`            — safe inline CSS: named tokens and hex only, never
 *                        arbitrary CSS.
 *
 * No DB, no DOM, no React. Property values use the JSON shapes documented in
 * `src/server/actions/database.ts` (`{ text }`, `{ number }`, `{ optionId }`,
 * `{ optionIds }`, `{ checked }`, `{ start }`, …), so a row can be passed in
 * as-is and unknown shapes are treated as empty rather than throwing.
 *
 * Priority is **ascending**: `0` is the strongest rule and the first matching
 * rule by priority wins. `resolveRowStyle` sorts by priority; ties keep their
 * original order (a stable sort).
 */

/** The palette allowlist: the only named colours a rule may use. */
export const COLOR_TOKENS = [
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];

const COLOR_TOKEN_SET: ReadonlySet<string> = new Set(COLOR_TOKENS);

/** 3- or 6-digit hex, the only non-named colour syntax accepted. */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Whether `value` is a colour a rule may carry: a `COLOR_TOKENS` name or a hex
 * literal. Everything else (`url(...)`, `var(...)`, `expression(...)`, a
 * declaration-injection payload, a non-string) is rejected.
 */
export function isSafeColor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (COLOR_TOKEN_SET.has(value) || HEX_COLOR.test(value))
  );
}

/** Condition operators a rule may use (mirrors the filter vocabulary). */
export const CONDITION_OPS = [
  "is",
  "is_not",
  "contains",
  "does_not_contain",
  "starts_with",
  "ends_with",
  "is_empty",
  "is_not_empty",
  "gt",
  "gte",
  "lt",
  "lte",
] as const;

export type ConditionOp = (typeof CONDITION_OPS)[number];

const CONDITION_OP_SET: ReadonlySet<string> = new Set(CONDITION_OPS);

/** Whether `value` is a known condition operator (untrusted-JSON safe). */
export function isConditionOp(value: unknown): value is ConditionOp {
  return typeof value === "string" && CONDITION_OP_SET.has(value);
}

export type FormatTarget = "row" | "cell";

export type FormatCondition = {
  op: ConditionOp;
  /** Comparison operand; unused by `is_empty` / `is_not_empty`. */
  value?: string;
};

export type FormatStyle = {
  /** Cell/row background colour: a `COLOR_TOKENS` name or hex. */
  background?: string;
  /** Text colour: a `COLOR_TOKENS` name or hex. */
  text?: string;
  bold?: boolean;
  italic?: boolean;
};

export type FormatRule = {
  id: string;
  /** Optional label shown in the rules list. */
  name?: string;
  /** `false` disables the rule; absent means enabled. */
  enabled?: boolean;
  target: FormatTarget;
  /**
   * The property the condition tests. For a `cell` rule it is also the cell to
   * paint. Kept optional so `parseFormatRule` can round-trip a rule missing it
   * and `validateFormatRule` can report the gap.
   */
  propertyId?: string;
  condition: FormatCondition;
  style: FormatStyle;
  /** Ascending precedence: `0` wins. */
  priority: number;
};

/** The schema slice validation needs. Structurally compatible with `QueryProperty`. */
export type FormatProperty = { id: string; name: string; type?: string };

/** A DBRow-shaped row: values keyed by property id. */
export type FormatRow = {
  propertyValues: { propertyId: string; value: unknown }[];
};

/** How a rule reads a property value out of a row. */
export type PropertyValueLookup<TRow> = (row: TRow, propertyId: string) => unknown;

export type EvaluateOptions<TRow> = {
  /** Override value extraction; defaults to the DBRow `propertyValues` lookup. */
  propertyValueFor?: PropertyValueLookup<TRow>;
};

/* --- parsing -------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Keep only the safe parts of an untrusted style object: safe colours and
 * strictly-`true` booleans. Everything else is dropped, so a poisoned value can
 * never reach `toCss`.
 */
function sanitizeStyle(raw: unknown): FormatStyle {
  const record = asRecord(raw);
  const style: FormatStyle = {};
  if (!record) return style;
  if (isSafeColor(record.background)) style.background = record.background;
  if (isSafeColor(record.text)) style.text = record.text;
  if (record.bold === true) style.bold = true;
  if (record.italic === true) style.italic = true;
  return style;
}

function sanitizeCondition(raw: Record<string, unknown>): FormatCondition {
  const condition: FormatCondition = { op: raw.op as ConditionOp };
  if (typeof raw.value === "string") condition.value = raw.value;
  return condition;
}

function toPriority(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : 0;
}

/**
 * Read an untrusted saved rule. Returns `null` when the input cannot form a
 * usable rule (not an object, no id, unknown operator); unsafe style values
 * are stripped rather than failing the whole rule.
 */
export function parseFormatRule(raw: unknown): FormatRule | null {
  const record = asRecord(raw);
  if (!record) return null;

  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (id === "") return null;

  const condition = asRecord(record.condition);
  if (!condition || !isConditionOp(condition.op)) return null;

  const rule: FormatRule = {
    id,
    target: record.target === "cell" ? "cell" : "row",
    condition: sanitizeCondition(condition),
    style: sanitizeStyle(record.style),
    priority: toPriority(record.priority),
  };

  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (name !== "") rule.name = name;
  if (typeof record.enabled === "boolean") rule.enabled = record.enabled;
  const propertyId = typeof record.propertyId === "string" ? record.propertyId.trim() : "";
  if (propertyId !== "") rule.propertyId = propertyId;

  return rule;
}

/* --- validation ----------------------------------------------------------- */

export type FormatRuleIssueCode =
  | "missing_id"
  | "unknown_property"
  | "unknown_operator"
  | "dangerous_style"
  | "duplicate_priority";

export type FormatRuleIssue = {
  code: FormatRuleIssueCode;
  message: string;
  /** Dotted path of the offending field, for a form to highlight. */
  field?: string;
};

export type FormatRuleValidationContext = {
  /** Known properties; when present, `propertyId` must resolve. */
  properties?: readonly FormatProperty[];
  /** Sibling rules; when present, `priority` must be unique (ignoring self). */
  rules?: readonly FormatRule[];
};

export type FormatRuleValidation = {
  valid: boolean;
  issues: FormatRuleIssue[];
};

/**
 * Validate one rule against the database schema and its sibling rules.
 * Returns every issue found (empty `issues` means valid). Never throws, even
 * on structurally malformed input.
 */
export function validateFormatRule(
  rule: FormatRule,
  context: FormatRuleValidationContext = {},
): FormatRuleValidation {
  const issues: FormatRuleIssue[] = [];

  const id = typeof rule.id === "string" ? rule.id.trim() : "";
  if (id === "") {
    issues.push({ code: "missing_id", message: "A rule needs an id.", field: "id" });
  }

  const propertyId = typeof rule.propertyId === "string" ? rule.propertyId : "";
  if (context.properties) {
    const known = propertyId !== "" && context.properties.some((p) => p.id === propertyId);
    if (!known) {
      issues.push({
        code: "unknown_property",
        message: `Unknown property "${propertyId}".`,
        field: "propertyId",
      });
    }
  }

  if (!isConditionOp(rule.condition?.op)) {
    issues.push({
      code: "unknown_operator",
      message: "Unknown condition operator.",
      field: "condition.op",
    });
  }

  const style = rule.style ?? {};
  for (const field of ["background", "text"] as const) {
    const value = style[field];
    if (value !== undefined && !isSafeColor(value)) {
      issues.push({
        code: "dangerous_style",
        message: `Unsafe ${field} colour.`,
        field: `style.${field}`,
      });
    }
  }
  for (const field of ["bold", "italic"] as const) {
    const value = style[field];
    if (value !== undefined && typeof value !== "boolean") {
      issues.push({
        code: "dangerous_style",
        message: `${field} must be a boolean.`,
        field: `style.${field}`,
      });
    }
  }

  if (context.rules) {
    const duplicate = context.rules.some(
      (other) => other !== rule && other.id !== rule.id && other.priority === rule.priority,
    );
    if (duplicate) {
      issues.push({
        code: "duplicate_priority",
        message: `Priority ${rule.priority} is already used by another rule.`,
        field: "priority",
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

/* --- evaluation ----------------------------------------------------------- */

type Comparable = string | number | boolean | string[] | null;

/**
 * Normalize a stored property value into something comparable. Mirrors the
 * unwrapping in `aggregations.ts`; unknown shapes become `null` (= empty).
 */
export function toComparable(value: unknown): Comparable {
  if (value === null || value === undefined) return null;
  const kind = typeof value;
  if (kind === "number") return Number.isFinite(value as number) ? (value as number) : null;
  if (kind === "string" || kind === "boolean") return value as string | boolean;
  if (kind !== "object") return null;

  const record = value as Record<string, unknown>;
  if (typeof record.number === "number") {
    return Number.isFinite(record.number) ? record.number : null;
  }
  if (typeof record.checked === "boolean") return record.checked;
  if (typeof record.text === "string") return record.text.trim() === "" ? null : record.text;
  if (typeof record.optionId === "string") return record.optionId;
  if (typeof record.start === "string") return record.start;

  const list = [record.optionIds, record.names, record.pageIds].find(Array.isArray) as
    | unknown[]
    | undefined;
  if (list) {
    const strings = list.filter((entry): entry is string => typeof entry === "string");
    return strings.length > 0 ? strings : null;
  }
  return null;
}

function isEmptyComparable(value: Comparable): boolean {
  if (value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function equals(value: Comparable, target: string): boolean {
  const needle = target.toLowerCase();
  if (Array.isArray(value)) return value.some((entry) => entry.toLowerCase() === needle);
  if (typeof value === "string") return value.toLowerCase() === needle;
  if (typeof value === "number") return String(value) === target;
  if (typeof value === "boolean") return String(value) === needle;
  return false;
}

function contains(value: Comparable, target: string): boolean {
  const needle = target.toLowerCase();
  if (Array.isArray(value)) return value.some((entry) => entry.toLowerCase().includes(needle));
  if (typeof value === "string") return value.toLowerCase().includes(needle);
  return false;
}

function toNumber(value: Comparable): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function matchesCondition(condition: FormatCondition, value: unknown): boolean {
  const comparable = toComparable(value);
  const operand = condition.value ?? "";

  switch (condition.op) {
    case "is_empty":
      return isEmptyComparable(comparable);
    case "is_not_empty":
      return !isEmptyComparable(comparable);
    case "is":
      return equals(comparable, operand);
    case "is_not":
      return !equals(comparable, operand);
    case "contains":
      return contains(comparable, operand);
    case "does_not_contain":
      return !contains(comparable, operand);
    case "starts_with":
      return typeof comparable === "string" && comparable.toLowerCase().startsWith(operand.toLowerCase());
    case "ends_with":
      return typeof comparable === "string" && comparable.toLowerCase().endsWith(operand.toLowerCase());
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const left = toNumber(comparable);
      const right = operand.trim() === "" ? NaN : Number(operand);
      if (left === null || Number.isNaN(right)) return false;
      if (condition.op === "gt") return left > right;
      if (condition.op === "gte") return left >= right;
      if (condition.op === "lt") return left < right;
      return left <= right;
    }
    default:
      // Unknown op reached at runtime (untyped caller): never match.
      return false;
  }
}

/** Default lookup for DBRow-shaped rows. */
function defaultPropertyValueFor(row: unknown, propertyId: string): unknown {
  const record = asRecord(row);
  if (!record || !Array.isArray(record.propertyValues)) return null;
  const entry = record.propertyValues.find(
    (candidate) => asRecord(candidate)?.propertyId === propertyId,
  );
  return asRecord(entry)?.value ?? null;
}

/**
 * Whether `rule`'s condition holds for `row`. A disabled rule never matches,
 * and a rule without a property id matches nothing (there is no value to test)
 * — `validateFormatRule` reports that gap so it surfaces in the editor.
 */
export function evaluateRule<TRow>(
  rule: FormatRule,
  row: TRow,
  options: EvaluateOptions<TRow> = {},
): boolean {
  if (rule.enabled === false) return false;
  const propertyId = rule.propertyId;
  if (typeof propertyId !== "string" || propertyId === "") return false;
  const lookup: PropertyValueLookup<TRow> =
    options.propertyValueFor ?? (defaultPropertyValueFor as PropertyValueLookup<TRow>);
  return matchesCondition(rule.condition, lookup(row, propertyId));
}

export type ResolvedRowStyle = {
  /** The winning rule's style (a fresh object), or `{}` when nothing matched. */
  style: FormatStyle;
  /** Ids of every matching row rule, in priority order. */
  matchedRuleIds: string[];
};

function byPriority(a: FormatRule, b: FormatRule): number {
  return a.priority - b.priority;
}

/**
 * Resolve a row's style from a set of rules. Cell-target rules are ignored
 * (they paint a single cell). The first matching rule by ascending priority
 * wins; `matchedRuleIds` still lists every matching row rule so a UI can show
 * "also matched by …".
 */
export function resolveRowStyle<TRow>(
  rules: readonly FormatRule[],
  row: TRow,
  options: EvaluateOptions<TRow> = {},
): ResolvedRowStyle {
  const ordered = [...rules].sort(byPriority);
  const matchedRuleIds: string[] = [];
  let style: FormatStyle = {};
  let found = false;
  for (const rule of ordered) {
    if (rule.target === "cell") continue;
    if (!evaluateRule(rule, row, options)) continue;
    matchedRuleIds.push(rule.id);
    if (!found) {
      style = { ...rule.style };
      found = true;
    }
  }
  return { style, matchedRuleIds };
}

/* --- ordering ------------------------------------------------------------- */

/**
 * Move the rule with `id` to `index` (clamped to range) and reassign every
 * `priority` to its new position, so the array order — what a drag-and-drop UI
 * shows — stays the source of truth for precedence. Returns a new array; the
 * input is never mutated. Unknown `id` returns a copy, unchanged.
 */
export function reorderRules(
  rules: readonly FormatRule[],
  id: string,
  index: number,
): FormatRule[] {
  const from = rules.findIndex((rule) => rule.id === id);
  if (from === -1) return rules.slice();

  const list = rules.slice();
  const [moved] = list.splice(from, 1);
  const clamped = Math.max(0, Math.min(list.length, Math.trunc(index)));
  list.splice(clamped, 0, moved);

  return list.map((rule, position) =>
    rule.priority === position ? rule : { ...rule, priority: position },
  );
}

/* --- description ---------------------------------------------------------- */

const OP_LABELS: Record<ConditionOp, string> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  does_not_contain: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  is_empty: "is empty",
  is_not_empty: "is not empty",
  gt: "is greater than",
  gte: "is greater than or equal to",
  lt: "is less than",
  lte: "is less than or equal to",
};

function describeStyle(style: FormatStyle): string {
  const parts: string[] = [];
  if (isSafeColor(style.background)) parts.push(`background ${style.background}`);
  if (isSafeColor(style.text)) parts.push(`text ${style.text}`);
  if (style.bold === true) parts.push("bold");
  if (style.italic === true) parts.push("italic");
  return parts.length > 0 ? parts.join(", ") : "no style";
}

/**
 * A one-line human summary, e.g.
 * `Overdue: When Due is less than "today" → row: background red, bold`.
 */
export function describeRule(
  rule: FormatRule,
  options: { propertyName?: string } = {},
): string {
  const property = options.propertyName ?? rule.propertyId ?? "property";
  const op = OP_LABELS[rule.condition.op] ?? String(rule.condition.op);
  const hasValue = rule.condition.value !== undefined && rule.condition.value !== "";
  const valuePart = hasValue ? ` "${rule.condition.value}"` : "";
  const target = rule.target === "cell" ? "cell" : "row";
  const name = rule.name?.trim();
  const prefix = name ? `${name}: ` : "";
  const suffix = rule.enabled === false ? " (disabled)" : "";
  return `${prefix}When ${property} ${op}${valuePart} → ${target}: ${describeStyle(rule.style)}${suffix}`;
}

/* --- CSS ------------------------------------------------------------------ */

/**
 * Render a style as safe inline CSS declarations (`background-color:green;
 * color:#fff;font-weight:700;font-style:italic`). Only allowlisted names and
 * hex survive; anything else is dropped, so the output can never contain a
 * declaration-injection payload. An empty style renders as `""`.
 */
export function toCss(style: FormatStyle | null | undefined): string {
  if (!style) return "";
  const declarations: string[] = [];
  if (isSafeColor(style.background)) declarations.push(`background-color:${style.background}`);
  if (isSafeColor(style.text)) declarations.push(`color:${style.text}`);
  if (style.bold === true) declarations.push("font-weight:700");
  if (style.italic === true) declarations.push("font-style:italic");
  return declarations.join(";");
}
