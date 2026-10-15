/**
 * Rollup property configuration — pure, dependency-free helpers for the
 * ROLLUP property type.
 *
 * A rollup is defined entirely by `Property.config` (docs/specs/relations-rollups.md
 * R21.10): the `RELATION` property it reads through, the property on that
 * relation's target database it reads, and a `RollupFunction` from
 * `@/lib/rollup`. This module owns the *shape* of that config, its
 * normalisation from untrusted stored JSON, the per-target-type function
 * whitelist, validation, and a human-readable description. It performs no
 * aggregation itself — `aggregate()` in `@/lib/rollup` does.
 *
 * Design rules (same contract as the other `src/lib` config helpers):
 *
 * - **Fail-safe by contract.** `config` and `props` round-trip through the DB
 *   as untrusted JSON, so every field is checked at runtime and nothing here
 *   ever throws — malformed input normalises to an empty-but-valid config.
 * - **Issues, not booleans.** `validateRollupConfig` returns one structured
 *   issue per problem (missing relation, target not on the related database,
 *   aggregation incompatible with the target type) so a caller can surface
 *   them all at once; it never returns a bare `false`.
 * - **One relation issue short-circuits the rest.** If the relation itself is
 *   missing or is not a `RELATION` property, the target cannot be resolved, so
 *   only `MISSING_RELATION` is reported rather than cascading noise.
 */

import { ROLLUP_FUNCTIONS as ROLLUP_FUNCTION_CATALOG } from "./rollup";
import type { RollupFunction } from "./rollup";

/** The persisted rollup configuration (`Property.config` for a ROLLUP). */
export type RollupConfig = {
  /** The `RELATION` property on this database the rollup reads through. */
  relationPropertyId: string;
  /** The property on the relation's target database whose values are aggregated. */
  targetPropertyId: string;
  /** The aggregation to apply. */
  aggregateFn: RollupFunction;
};

/** A problem `validateRollupConfig` can report. */
export type RollupIssueCode =
  | "MISSING_RELATION"
  | "TARGET_NOT_ON_RELATED_DB"
  | "INCOMPATIBLE_AGGREGATION";

/** One problem with a rollup configuration. */
export type RollupIssue = {
  code: RollupIssueCode;
  message: string;
};

/**
 * What the validators read from one property. Values are untrusted; a property
 * is identified by `id` and, to place it on a database, an optional
 * `databaseId`.
 */
export type RollupProperty = {
  id: string;
  name?: string;
  type?: string;
  /** The database this property belongs to; used to resolve the relation target. */
  databaseId?: string;
  config?: unknown;
};

/** The types of rollup function families, used to whitelist per property type. */
type RollupKind = "numeric" | "date" | "boolean" | "text" | "list" | "any";

const NUMERIC_FUNCTIONS: readonly RollupFunction[] = [
  "count",
  "count_empty",
  "sum",
  "avg",
  "min",
  "max",
  "median",
  "range",
  "unique",
  "show_original",
];

const DATE_FUNCTIONS: readonly RollupFunction[] = [
  "count",
  "count_empty",
  "earliest",
  "latest",
  "min",
  "max",
  "unique",
  "show_original",
];

const BOOLEAN_FUNCTIONS: readonly RollupFunction[] = [
  "count",
  "count_empty",
  "checked",
  "percent_checked",
  "unique",
  "show_original",
];

const TEXT_FUNCTIONS: readonly RollupFunction[] = [
  "count",
  "count_empty",
  "min",
  "max",
  "unique",
  "show_original",
];

const LIST_FUNCTIONS: readonly RollupFunction[] = [
  "count",
  "count_empty",
  "unique",
  "show_original",
];

/** FORMULA/ROLLUP produce a value of unknown type, so every function is allowed. */
const ANY_FUNCTIONS: readonly RollupFunction[] = ROLLUP_FUNCTION_CATALOG.map((fn) => fn.id);

const FUNCTIONS_BY_KIND: Record<RollupKind, readonly RollupFunction[]> = {
  numeric: NUMERIC_FUNCTIONS,
  date: DATE_FUNCTIONS,
  boolean: BOOLEAN_FUNCTIONS,
  text: TEXT_FUNCTIONS,
  list: LIST_FUNCTIONS,
  any: ANY_FUNCTIONS,
};

/** Which function family each Prisma `PropertyType` maps to. */
const KIND_BY_TYPE: Record<string, RollupKind> = {
  NUMBER: "numeric",
  DATE: "date",
  CREATED_TIME: "date",
  LAST_EDITED_TIME: "date",
  CHECKBOX: "boolean",
  TEXT: "text",
  URL: "text",
  EMAIL: "text",
  PHONE: "text",
  SELECT: "text",
  STATUS: "text",
  UNIQUE_ID: "text",
  CREATED_BY: "text",
  LAST_EDITED_BY: "text",
  MULTI_SELECT: "list",
  PEOPLE: "list",
  FILES: "list",
  PLACE: "list",
  RELATION: "list",
  BUTTON: "list",
  AI_AUTOFILL: "list",
  FORMULA: "any",
  ROLLUP: "any",
};

/**
 * The rolled-up functions allowed for each target property type, keyed by the
 * Prisma `PropertyType` name (e.g. `ROLLUP_FUNCTIONS.NUMBER`). Types not listed
 * fall back to the generic list (see `allowedRollupFunctions`).
 */
export const ROLLUP_FUNCTIONS: Readonly<Record<string, readonly RollupFunction[]>> = (() => {
  const map: Record<string, readonly RollupFunction[]> = {};
  for (const [type, kind] of Object.entries(KIND_BY_TYPE)) {
    map[type] = FUNCTIONS_BY_KIND[kind];
  }
  return map;
})();

/**
 * The functions allowed for a target property of `type`. Matching is
 * case-insensitive; an unknown type is treated permissively as a list-valued
 * property (count / count_empty / unique / show_original).
 */
export function allowedRollupFunctions(type: unknown): readonly RollupFunction[] {
  const key = typeof type === "string" ? type.trim().toUpperCase() : "";
  const kind = KIND_BY_TYPE[key];
  return kind ? FUNCTIONS_BY_KIND[kind] : LIST_FUNCTIONS;
}

const FUNCTION_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  ROLLUP_FUNCTION_CATALOG.map((fn) => [fn.id, fn.label]),
);

const KNOWN_FUNCTIONS: ReadonlySet<string> = new Set(ROLLUP_FUNCTION_CATALOG.map((fn) => fn.id));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRollupFunction(value: unknown): value is RollupFunction {
  return typeof value === "string" && KNOWN_FUNCTIONS.has(value);
}

/** A trimmed, non-empty string id, or `""`. */
function toId(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/**
 * Coerce an untrusted config into the canonical `RollupConfig`. Accepts an
 * already-normalised object, a raw `Property.config` (which may use the
 * persisted `function` key instead of `aggregateFn`) or a JSON string. Blank or
 * non-string ids become `""`; an unknown/missing function falls back to
 * `"count"`. Idempotent and never throws.
 */
export function normalizeRollupConfig(raw: unknown): RollupConfig {
  let source: unknown = raw;
  if (typeof raw === "string") {
    try {
      source = JSON.parse(raw);
    } catch {
      source = null;
    }
  }
  const record = isRecord(source) ? source : {};
  const fn = record.aggregateFn ?? record.function;
  return {
    relationPropertyId: toId(record.relationPropertyId),
    targetPropertyId: toId(record.targetPropertyId),
    aggregateFn: isRollupFunction(fn) ? fn : "count",
  };
}

/**
 * Normalise the `props` argument to a flat property list. Accepts either an
 * array of properties or a `{ properties }` wrapper so both a server loader and
 * a component can pass what they already have. Non-object entries and blank ids
 * are dropped; never throws.
 */
function toPropertyList(input: unknown): RollupProperty[] {
  const raw = Array.isArray(input)
    ? input
    : isRecord(input) && Array.isArray(input.properties)
      ? input.properties
      : [];
  const out: RollupProperty[] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate)) continue;
    const id = candidate.id;
    if (typeof id !== "string" || id === "") continue;
    out.push({
      id,
      name: typeof candidate.name === "string" ? candidate.name : undefined,
      type: typeof candidate.type === "string" ? candidate.type : undefined,
      databaseId: typeof candidate.databaseId === "string" ? candidate.databaseId : undefined,
      config: candidate.config,
    });
  }
  return out;
}

/** The `config.targetDatabaseId` of a relation property, or `null`. */
function targetDatabaseIdOf(property: RollupProperty | undefined): string | null {
  if (!property || !isRecord(property.config)) return null;
  const target = property.config.targetDatabaseId;
  return typeof target === "string" && target !== "" ? target : null;
}

/** A property's display name, falling back to its id. */
function nameOf(property: RollupProperty): string {
  const name = property.name;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : property.id;
}

/**
 * Validate a rollup configuration against the properties it refers to.
 *
 * `props` is the set of properties the rollup can see — the source database's
 * properties (including the relation) **and** the target database's properties,
 * each optionally tagged with `databaseId`. The related database is the one
 * named by the relation property's `config.targetDatabaseId`; a property
 * belongs to it when its `databaseId` matches.
 *
 * Returns one issue per problem, in the order: missing relation, target not on
 * the related database, incompatible aggregation. A missing relation
 * short-circuits the other two (the target cannot be resolved without it).
 * Never throws.
 */
export function validateRollupConfig(config: unknown, props: unknown): RollupIssue[] {
  const issues: RollupIssue[] = [];
  try {
    const normalized = normalizeRollupConfig(config);
    const list = toPropertyList(props);
    const byId = new Map(list.map((property) => [property.id, property]));

    const relation = normalized.relationPropertyId
      ? byId.get(normalized.relationPropertyId)
      : undefined;
    if (!relation || relation.type !== "RELATION") {
      issues.push({
        code: "MISSING_RELATION",
        message: "Rollup must reference a relation property of this database.",
      });
      return issues;
    }

    const targetDatabaseId = targetDatabaseIdOf(relation);
    const target = normalized.targetPropertyId
      ? list.find(
          (property) =>
            property.id === normalized.targetPropertyId && property.databaseId === targetDatabaseId,
        )
      : undefined;

    if (!target) {
      issues.push({
        code: "TARGET_NOT_ON_RELATED_DB",
        message: "Rollup target property must belong to the relation's target database.",
      });
      return issues;
    }

    if (!allowedRollupFunctions(target.type).includes(normalized.aggregateFn)) {
      issues.push({
        code: "INCOMPATIBLE_AGGREGATION",
        message: `"${normalized.aggregateFn}" cannot aggregate a ${target.type ?? "property"} target.`,
      });
    }
  } catch {
    // Fail-safe: exotic input must never break the caller.
    return issues;
  }
  return issues;
}

/**
 * A one-line, human-readable description of a rollup for menus and tooltips,
 * e.g. `"Sum of Points via Projects"`. Unresolved pieces are dropped rather
 * than shown as ids: `"Sum of Points"` (no relation), `"Sum via Projects"` (no
 * target) or `"Count all"` (nothing resolvable).
 */
export function describeRollup(config: unknown, props: unknown): string {
  const normalized = normalizeRollupConfig(config);
  const list = toPropertyList(props);
  const label = FUNCTION_LABELS[normalized.aggregateFn] ?? normalized.aggregateFn;

  const relation = normalized.relationPropertyId
    ? list.find((property) => property.id === normalized.relationPropertyId)
    : undefined;

  let target: RollupProperty | undefined;
  if (relation) {
    const targetDatabaseId = targetDatabaseIdOf(relation);
    target = list.find(
      (property) =>
        property.id === normalized.targetPropertyId && property.databaseId === targetDatabaseId,
    );
  } else if (normalized.targetPropertyId) {
    target = list.find((property) => property.id === normalized.targetPropertyId);
  }

  if (relation && target) return `${label} of ${nameOf(target)} via ${nameOf(relation)}`;
  if (relation) return `${label} via ${nameOf(relation)}`;
  if (target) return `${label} of ${nameOf(target)}`;
  return label;
}
