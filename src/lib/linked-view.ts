/**
 * Linked-database view identity + per-instance overrides (R89.14 / R89.15).
 *
 * A linked block in a page is an *instance* of another database, bound to one
 * source view. The instance records:
 *  - `instanceId`  — identity of the block in its parent document;
 *  - `databaseId`  — the source database page;
 *  - `sourceViewId` — the source view this instance mirrors (optional: the
 *    source's first view is the implicit default);
 *  - `mode`        — `"synced"` (mirror the source view; its filters/sorts win,
 *    only display-level overrides apply locally) or `"detached"` (owns its full
 *    config, overrides — including filters/sorts — win over the source);
 *  - `overrides`   — a bounded subset of `ViewConfig` applied over the source.
 *
 * Everything here is pure: no Prisma, no React, no clock, no I/O. Nothing is
 * mutated in place; the factory's identity validation is the only throw path.
 * View-config writes are trusted to `normalizeViewConfig`, never to raw shape.
 */

import {
  normalizeViewConfig,
  type ViewConfig,
} from "@/lib/database-query";

export type LinkedViewMode = "synced" | "detached";

/** Per-instance overrides: a `ViewConfig` subset merged over the source view. */
export type LinkedViewOverrides = Partial<ViewConfig>;

/**
 * Row writes are a property of a *detached* instance whose reader may edit the
 * source database. A synced instance mirrors the source and stays read-only
 * here even for an editor, because writing through it would silently diverge
 * from the source view the block claims to mirror.
 */
export function canWriteLinkedRows(
  mode: LinkedViewMode | string | null | undefined,
  canEdit: boolean,
): boolean {
  return mode === "detached" && canEdit;
}

export type LinkedView = {
  instanceId: string;
  databaseId: string;
  sourceViewId?: string;
  mode: LinkedViewMode;
  overrides: LinkedViewOverrides;
};

export type CreateLinkedViewInput = {
  instanceId: string;
  databaseId: string;
  sourceViewId?: string;
  mode?: LinkedViewMode;
};

/**
 * Every key `normalizeViewConfig` understands. Kept as a runtime list so
 * validation can distinguish a real override from a stray key without trusting
 * the value's shape. Keeping this in sync with `ViewConfig` is the one
 * duplicated contract in this module.
 */
const VIEW_CONFIG_KEYS: readonly string[] = [
  "filters",
  "filterMode",
  "filterTree",
  "filterBuilder",
  "sorts",
  "groupByPropertyId",
  "visiblePropertyIds",
  "freezeFirstColumn",
  "colorRules",
  "laneBy",
  "wipLimits",
  "numberFormat",
  "columnLayout",
  "visibleGroups",
  "cardSize",
  "description",
  "chartType",
  "chartAggregate",
  "aggregationPropertyId",
  "previewPropertyId",
];

/**
 * Keys owned by the source view while an instance is `"synced"`. A synced
 * instance mirrors the source's row selection (filters) and ordering (sorts), so
 * local overrides for these are ignored until the instance is detached.
 */
const SOURCE_OWNED_KEYS: readonly string[] = [
  "filters",
  "filterMode",
  "filterTree",
  "filterBuilder",
  "sorts",
];

const KNOWN_OVERRIDE_KEYS = new Set<string>(VIEW_CONFIG_KEYS);

/** A plain record view of an unknown value (`{}` for anything else). */
function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A plain object (not `null`, not an array, Object/`null` prototype). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Deep equality over JSON-shaped values (object key order is irrelevant). */
function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => deepEqual(left[key], right[key]));
  }
  return false;
}

/** A fresh instance with the same fields (overrides copied shallowly). */
function cloneLinkedView(linked: LinkedView): LinkedView {
  const clone: LinkedView = {
    instanceId: linked.instanceId,
    databaseId: linked.databaseId,
    mode: linked.mode,
    overrides: { ...linked.overrides },
  };
  if (linked.sourceViewId !== undefined) clone.sourceViewId = linked.sourceViewId;
  return clone;
}

/**
 * Create a linked-view instance. `instanceId` and `databaseId` are required
 * identity; `mode` defaults to `"synced"` (safe: a fresh block mirrors its
 * source). Overrides always start empty and are owned by the caller.
 */
export function createLinkedView(input: CreateLinkedViewInput): LinkedView {
  const instanceId = typeof input.instanceId === "string" ? input.instanceId.trim() : "";
  const databaseId = typeof input.databaseId === "string" ? input.databaseId.trim() : "";
  if (instanceId === "") {
    throw new Error("createLinkedView: instanceId is required");
  }
  if (databaseId === "") {
    throw new Error("createLinkedView: databaseId is required");
  }
  const linked: LinkedView = {
    instanceId,
    databaseId,
    mode: input.mode === "detached" ? "detached" : "synced",
    overrides: {},
  };
  const sourceViewId =
    typeof input.sourceViewId === "string" ? input.sourceViewId.trim() : "";
  if (sourceViewId !== "") linked.sourceViewId = sourceViewId;
  return linked;
}

/**
 * The effective `ViewConfig` an instance renders: the instance's overrides
 * merged over the source view. In `"synced"` mode the source keeps ownership of
 * filters and sorts (local overrides for those keys are ignored); in
 * `"detached"` mode overrides win, including filters and sorts. The result is
 * normalized, so a malformed override falls back to the source's value rather
 * than reaching a renderer.
 */
export function resolveViewConfig(
  sourceConfig: ViewConfig | null | undefined,
  linked: LinkedView,
): ViewConfig {
  const source = normalizeViewConfig(sourceConfig ?? {});
  const sourceRecord = toRecord(source);
  const merged: Record<string, unknown> = { ...sourceRecord };

  for (const [key, value] of Object.entries(toRecord(linked.overrides))) {
    if (KNOWN_OVERRIDE_KEYS.has(key)) merged[key] = value;
  }

  if (linked.mode === "synced") {
    // Filters and sorts mirror the source. Restore the source's value when it
    // has one; otherwise drop the override so the effective config stays empty.
    for (const key of SOURCE_OWNED_KEYS) {
      if (key in sourceRecord) merged[key] = sourceRecord[key];
      else delete merged[key];
    }
  }

  return normalizeViewConfig(merged);
}

export type LinkedViewIssueCode =
  | "empty_instance_id"
  | "empty_database_id"
  | "invalid_mode"
  | "missing_database"
  | "unknown_source_view"
  | "unknown_override_key";

export type LinkedViewIssue = {
  code: LinkedViewIssueCode;
  /** Present for `unknown_override_key`: the offending key. */
  key?: string;
  message: string;
};

export type LinkedViewValidation = {
  valid: boolean;
  issues: LinkedViewIssue[];
};

export type LinkedViewValidationContext = {
  /** Whether the source database exists (a dangling pointer is reported). */
  exists: (databaseId: string) => boolean;
  /**
   * Optional: whether the bound source view still exists. Omitted when the
   * caller cannot resolve views; the check is then skipped (never assumed).
   */
  viewExists?: (databaseId: string, sourceViewId: string) => boolean;
};

/**
 * Validate an instance against known runtime facts. Returns every issue it can
 * see (not just the first) plus a `valid` flag: a dangling database, a missing
 * bound source view, an unknown override key, or broken identity. Known
 * override keys are not value-checked here — `resolveViewConfig` normalizes.
 */
export function validateLinkedView(
  linked: LinkedView,
  context: LinkedViewValidationContext,
): LinkedViewValidation {
  const issues: LinkedViewIssue[] = [];

  if (linked.instanceId === "") {
    issues.push({ code: "empty_instance_id", message: "instanceId is required" });
  }
  if (linked.databaseId === "") {
    issues.push({ code: "empty_database_id", message: "databaseId is required" });
  }
  if (linked.mode !== "synced" && linked.mode !== "detached") {
    issues.push({ code: "invalid_mode", message: `Unknown linked-view mode "${linked.mode}"` });
  }

  const databaseKnown = linked.databaseId !== "" && context.exists(linked.databaseId);
  if (linked.databaseId !== "" && !databaseKnown) {
    issues.push({
      code: "missing_database",
      message: `Database "${linked.databaseId}" does not exist`,
    });
  }
  if (
    linked.sourceViewId !== undefined &&
    linked.sourceViewId !== "" &&
    databaseKnown &&
    context.viewExists !== undefined &&
    !context.viewExists(linked.databaseId, linked.sourceViewId)
  ) {
    issues.push({
      code: "unknown_source_view",
      message: `Source view "${linked.sourceViewId}" does not exist`,
    });
  }

  for (const key of Object.keys(toRecord(linked.overrides)).sort()) {
    if (!KNOWN_OVERRIDE_KEYS.has(key)) {
      issues.push({
        code: "unknown_override_key",
        key,
        message: `Unknown override key "${key}"`,
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Switch an instance's mode.
 *  - `synced -> detached` snapshots the current *effective* config into the
 *    instance's own overrides, so the block looks identical after detaching
 *    (its source ownership is now local). Without a `sourceConfig` the existing
 *    overrides are kept as-is — the best snapshot available.
 *  - `detached -> synced` drops all overrides; the instance again mirrors the
 *    source view.
 * An unchanged mode returns an equivalent copy (never the same object).
 */
export function convertMode(
  linked: LinkedView,
  mode: LinkedViewMode,
  sourceConfig?: ViewConfig | null,
): LinkedView {
  if (mode === linked.mode) return cloneLinkedView(linked);

  if (mode === "detached") {
    const snapshot: LinkedViewOverrides =
      sourceConfig === undefined || sourceConfig === null
        ? { ...linked.overrides }
        : resolveViewConfig(sourceConfig, linked);
    const detached = cloneLinkedView(linked);
    detached.mode = "detached";
    detached.overrides = snapshot;
    return detached;
  }

  const synced = cloneLinkedView(linked);
  synced.mode = "synced";
  synced.overrides = {};
  return synced;
}

/** Every instance bound to `databaseId` (order preserved; a new array). */
export function instancesForDatabase(
  views: readonly LinkedView[],
  databaseId: string,
): LinkedView[] {
  return views.filter((view) => view.databaseId === databaseId);
}

/**
 * A human-readable label for an instance. Locale-independent (the caller wraps
 * it for display); deterministic so tests and logs can assert on it.
 */
export function describeLinkedView(linked: LinkedView): string {
  const label = linked.mode === "synced" ? "Synced" : "Detached";
  const target =
    linked.sourceViewId !== undefined && linked.sourceViewId !== ""
      ? `view ${linked.sourceViewId}`
      : "default view";
  return `${label} linked view of ${linked.databaseId} via ${target} (${linked.instanceId})`;
}

/**
 * Override keys whose value is deeply identical to the source view's value —
 * i.e. overrides that change nothing and can be pruned. A key the source does
 * not have is never stale (the override adds it).
 */
export function staleOverrides(
  sourceConfig: ViewConfig | null | undefined,
  linked: LinkedView,
): string[] {
  const source = toRecord(normalizeViewConfig(sourceConfig ?? {}));
  const stale: string[] = [];
  for (const [key, value] of Object.entries(toRecord(linked.overrides))) {
    if (!(key in source)) continue;
    if (deepEqual(value, source[key])) stale.push(key);
  }
  return stale;
}
