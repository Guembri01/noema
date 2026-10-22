/**
 * Conditional formatting for database rows: a pure colour-rule engine.
 *
 * A view lists `RowColorRule`s in priority order; this module decides which
 * rules match a row and resolves the row/cell colours from them. The rule
 * condition is an ordinary flat `Filter`, evaluated by delegating to
 * `applyFilters` on a one-row list, so colour rules always agree with view
 * filters — same operator vocabulary (`is`, `contains`, `is_empty`, `gt`,
 * `before`, …), same semantics (docs/MISSING_FEATURES.md §3 "Conditional
 * formatting" / "Row color rules").
 *
 * Fail-safe by design: a rule whose condition property has been deleted, whose
 * operator or colour is unknown, or whose stored shape is malformed is inert
 * rather than paint every row or throw — `validateRules` reports such rules so
 * a UI can surface them. Nothing here touches the DB or React; a view toolbar
 * can paint a table entirely with these functions.
 */

import {
  applyFilters,
  isFilterOperator,
  operatorsFor,
} from "@/lib/database-query";
import type { Filter, QueryProperty, QueryRow } from "@/lib/database-query";

/**
 * The nine Notion-style tints, in the order the rest of the app offers them
 * (same names as `COLOR_CHOICES` in `@/components/database/database-types` and
 * `BLOCK_COLOR_CATALOGUE` in the editor). Colours are stored as these names — never raw
 * hex — so the CSS owns the values and a dark theme only remaps them.
 */
export const ROW_COLOR_PALETTE = [
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

export type RowColorName = (typeof ROW_COLOR_PALETTE)[number];

/** `"row"` paints the whole row; `"cell"` paints one property's cell. */
export type RowColorRuleTarget = "row" | "cell";

/**
 * A conditional-formatting rule.
 *
 * - `filter` is the condition, in exactly the flat `Filter` shape view filters
 *   use.
 * - `propertyId` is the cell the rule paints when `target` is `"cell"`; it is
 *   ignored for `"row"` rules (which tint the whole row).
 * - `color` is the background tint and `textColor` the optional two-tone text
 *   tint; both are palette names (see `ROW_COLOR_PALETTE`).
 */
export type RowColorRule = {
  id: string;
  propertyId: string;
  filter: Filter;
  color: string;
  textColor?: string;
  target: RowColorRuleTarget;
};

/**
 * The colours resolved for a row or cell.
 *
 * `matchedRuleIds` lists every in-scope rule whose condition matched, in
 * priority order — including rules that lost the precedence tie — so a UI can
 * show why a row is painted.
 */
export type ResolvedColors = {
  backgroundColor?: string;
  textColor?: string;
  matchedRuleIds: string[];
};

export type EvaluateRowColorsOptions = {
  /**
   * Also let `"cell"` rules tint the row (default `false`: cell rules only
   * ever paint their own cell, which `cellColorFor` resolves).
   */
  includeCellRules?: boolean;
};

export type RuleIssueCode =
  /** No usable `id` — the rule cannot be edited or referenced. */
  | "missing_id"
  /** No `filter` condition at all (or one that is not an object). */
  | "missing_filter"
  /** The condition's property is not in the schema (deleted property). */
  | "unknown_filter_property"
  /** The condition's operator is not one this app can evaluate. */
  | "invalid_operator"
  /** A valid operator this property type does not offer (e.g. `checked` on TEXT). */
  | "operator_not_allowed"
  /** `target` is neither `"row"` nor `"cell"`. */
  | "invalid_target"
  /** A `"cell"` rule whose painted cell is not in the schema. */
  | "unknown_cell_property"
  /** No background colour. */
  | "missing_color"
  /** Background colour outside `ROW_COLOR_PALETTE`. */
  | "unknown_color"
  /** `textColor` set to something outside `ROW_COLOR_PALETTE`. */
  | "invalid_text_color";

export type RuleIssue = {
  /** Position of the rule in the array (its priority). */
  index: number;
  ruleId: string;
  code: RuleIssueCode;
  message: string;
};

/**
 * Resolve a colour to its canonical palette name, or `null` when it is not a
 * palette colour (unknown name, hex, wrong type). Trims and lower-cases so
 * `" RED "` and `"red"` are the same colour.
 */
export function normalizeColor(value: unknown): RowColorName | null {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  return (ROW_COLOR_PALETTE as readonly string[]).includes(name)
    ? (name as RowColorName)
    : null;
}

/**
 * What this module actually reads from a rule. Stored view config round-trips
 * through the DB as untrusted JSON, so every field is checked at runtime
 * instead of trusted from the type — that is what keeps `validateRules` (and
 * the resolvers) fail-safe rather than throwing on a malformed rule.
 */
type UntrustedRule = {
  id?: unknown;
  propertyId?: unknown;
  filter?: unknown;
  color?: unknown;
  textColor?: unknown;
  target?: unknown;
};

type UntrustedFilter = {
  propertyId?: unknown;
  operator?: unknown;
  value?: unknown;
};

/** Which rules can contribute colours to this evaluation. */
type ColorScope =
  | { kind: "row"; includeCellRules: boolean }
  | { kind: "cell"; propertyId: string };

/**
 * Evaluate a rule's condition by delegating to the flat evaluator
 * (`applyFilters` on a one-row list), so rule conditions always behave like
 * view filters — including "an operator we cannot evaluate never matches".
 *
 * Two fail-safe guards wrap that delegation: a condition on a property that no
 * longer exists is *inert* (not neutral-true as in view filters — a deleted
 * property must not paint every row), and a malformed condition is skipped
 * instead of reaching the evaluator.
 */
function conditionMatches(
  rule: UntrustedRule,
  row: QueryRow,
  props: QueryProperty[],
  byId: Map<string, QueryProperty>,
): boolean {
  const filter: UntrustedFilter | null =
    typeof rule.filter === "object" && rule.filter !== null
      ? (rule.filter as UntrustedFilter)
      : null;
  if (!filter) return false;
  if (typeof filter.propertyId !== "string" || !byId.has(filter.propertyId)) {
    return false;
  }
  if (!isFilterOperator(filter.operator)) return false;
  if (filter.value !== undefined && filter.value !== null && typeof filter.value !== "string") {
    return false;
  }
  return applyFilters([row], props, [filter as Filter], "and").length === 1;
}

/** Whether a rule may contribute colours to this evaluation at all. */
function inScope(
  scope: ColorScope,
  rule: UntrustedRule,
  byId: Map<string, QueryProperty>,
): boolean {
  if (rule.target === "row") return scope.kind === "row";
  if (rule.target !== "cell") return false; // unknown target → inert
  // A cell rule is inert when the cell it paints has been deleted.
  if (typeof rule.propertyId !== "string" || !byId.has(rule.propertyId)) {
    return false;
  }
  return scope.kind === "cell"
    ? rule.propertyId === scope.propertyId
    : scope.includeCellRules;
}

/**
 * Resolve colours for one row under a scope.
 *
 * Precedence (documented): rules are considered in array order (the priority
 * a view lists them); the FIRST in-scope rule whose condition matches wins —
 * its `color` becomes the background and its `textColor`, when present, the
 * text colour. Later matches are reported in `matchedRuleIds` but never
 * override the winner. A rule outside the palette is inert (and reported by
 * `validateRules`).
 */
function resolveColors(
  rules: RowColorRule[],
  row: QueryRow,
  props: QueryProperty[],
  scope: ColorScope,
): ResolvedColors {
  const list: readonly unknown[] = Array.isArray(rules) ? rules : [];
  const byId = new Map(props.map((p) => [p.id, p]));
  const matchedRuleIds: string[] = [];
  let backgroundColor: string | undefined;
  let textColor: string | undefined;
  for (const item of list) {
    const rule = (item ?? {}) as UntrustedRule;
    if (!inScope(scope, rule, byId)) continue;
    const color = normalizeColor(rule.color);
    if (color === null) continue; // unknown colour → inert
    if (!conditionMatches(rule, row, props, byId)) continue;
    if (matchedRuleIds.length === 0) {
      backgroundColor = color;
      textColor = normalizeColor(rule.textColor) ?? undefined;
    }
    matchedRuleIds.push(typeof rule.id === "string" ? rule.id : "");
  }
  const resolved: ResolvedColors = { matchedRuleIds };
  if (backgroundColor !== undefined) resolved.backgroundColor = backgroundColor;
  if (textColor !== undefined) resolved.textColor = textColor;
  return resolved;
}

/**
 * The colours for a whole row: the first matching `"row"` rule wins (see
 * `resolveColors` for the precedence). `"cell"` rules are out of scope unless
 * `opts.includeCellRules` is set.
 */
export function evaluateRowColors(
  rules: RowColorRule[],
  row: QueryRow,
  props: QueryProperty[],
  opts?: EvaluateRowColorsOptions,
): ResolvedColors {
  return resolveColors(rules, row, props, {
    kind: "row",
    includeCellRules: opts?.includeCellRules === true,
  });
}

/**
 * The colours for one cell: only `"cell"` rules scoped to `propertyId`, with
 * the same first-match-wins precedence. Row rules are out of scope — their
 * colour is applied at row level by `evaluateRowColors`.
 */
export function cellColorFor(
  rules: RowColorRule[],
  row: QueryRow,
  propertyId: string,
  props: QueryProperty[],
): ResolvedColors {
  return resolveColors(rules, row, props, { kind: "cell", propertyId });
}

/**
 * Short, safe description of an untrusted value for an issue message. Never
 * throws (a circular or exotic value is not allowed to break validation).
 */
function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable]";
  }
}

/**
 * Report every problem with a rule set: unknown properties, operators the
 * property type does not offer, colours outside the palette, malformed shapes.
 *
 * Fail-safe by contract: it never throws and never skips a broken rule silently
 * — every issue carries the rule's index/id and a machine-readable `code`, so
 * a rules editor can list them. An empty array means the set is valid.
 */
export function validateRules(
  rules: RowColorRule[],
  props: QueryProperty[],
): RuleIssue[] {
  const list: readonly unknown[] = Array.isArray(rules) ? rules : [];
  const byId = new Map(props.map((p) => [p.id, p]));
  const issues: RuleIssue[] = [];
  const report = (index: number, ruleId: string, code: RuleIssueCode, message: string) => {
    issues.push({ index, ruleId, code, message });
  };

  for (let index = 0; index < list.length; index++) {
    const rule = (list[index] ?? {}) as UntrustedRule;
    const id = typeof rule.id === "string" ? rule.id.trim() : "";
    const label = id !== "" ? id : `#${index}`;
    if (id === "") {
      report(index, "", "missing_id", `Rule ${label} has no id.`);
    }

    const target = rule.target;
    const targetOk = target === "row" || target === "cell";
    if (!targetOk) {
      report(
        index,
        id,
        "invalid_target",
        `Rule ${label} has target ${show(target)}; expected "row" or "cell".`,
      );
    }

    const filter: UntrustedFilter | null =
      typeof rule.filter === "object" && rule.filter !== null
        ? (rule.filter as UntrustedFilter)
        : null;
    if (!filter) {
      report(index, id, "missing_filter", `Rule ${label} has no filter condition.`);
    } else {
      const filterPropertyId =
        typeof filter.propertyId === "string" ? filter.propertyId : "";
      const property = filterPropertyId ? byId.get(filterPropertyId) : undefined;
      if (!property) {
        report(
          index,
          id,
          "unknown_filter_property",
          `Rule ${label} filters on unknown property "${filterPropertyId || "?"}".`,
        );
      }
      if (!isFilterOperator(filter.operator)) {
        report(
          index,
          id,
          "invalid_operator",
          `Rule ${label} uses unknown operator ${show(filter.operator)}.`,
        );
      } else if (property) {
        const allowed = operatorsFor(property.type);
        if (!allowed.some((op) => op.value === filter.operator)) {
          report(
            index,
            id,
            "operator_not_allowed",
            `Operator "${String(filter.operator)}" is not offered for ${property.type} property "${property.name}".`,
          );
        }
      }
    }

    if (target === "cell") {
      const cellId = typeof rule.propertyId === "string" ? rule.propertyId : "";
      if (!cellId || !byId.has(cellId)) {
        report(
          index,
          id,
          "unknown_cell_property",
          `Cell rule ${label} paints unknown property "${cellId || "?"}".`,
        );
      }
    }

    if (rule.color === undefined || rule.color === null || rule.color === "") {
      report(index, id, "missing_color", `Rule ${label} has no colour.`);
    } else if (normalizeColor(rule.color) === null) {
      report(
        index,
        id,
        "unknown_color",
        `Rule ${label} uses colour ${show(rule.color)}, which is not one of the ${ROW_COLOR_PALETTE.length} palette tints.`,
      );
    }

    if (
      rule.textColor !== undefined &&
      rule.textColor !== null &&
      rule.textColor !== "" &&
      normalizeColor(rule.textColor) === null
    ) {
      report(
        index,
        id,
        "invalid_text_color",
        `Rule ${label} uses text colour ${show(rule.textColor)}, which is not a palette tint.`,
      );
    }
  }

  return issues;
}
