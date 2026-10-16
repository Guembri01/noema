/**
 * Saved views: named filter/sort/group presets for databases and tickets
 * (docs/MISSING_FEATURES.md §2 "Saved views" — "Named filter/sort/group presets
 * for databases and tickets").
 *
 * This is the pure storage/validation half of a saved view. A view is a small
 * record — an id, a name, a scope, and an optional preset (view type, filter
 * tree, sort list, group property, hidden property ids). Nothing here touches
 * the DB or React: a workspace can keep its views as JSON with these functions
 * and nothing else.
 *
 * The filter and sort shapes are accepted **loosely** and deliberately do not
 * import the database-query internals: a filter node is any JSON object (a leaf
 * filter or an `and`/`or` group), and a sort is a `{ propertyId, direction? }`
 * pair. Stored view config round-trips through the DB as untrusted JSON, so
 * every field is re-checked at runtime — malformed entries are dropped rather
 * than thrown on (`parseSavedView`, `deserializeSavedViews`) and reported in
 * full when a caller wants to block a save (`validateSavedView`).
 *
 * De-duplication is case-insensitive on both id and name, keeping the first
 * occurrence, so the same view saved twice (or a renamed duplicate) collapses
 * to one entry.
 */

import { normalizeViewConfig, type ViewConfig } from "@/lib/database-query";

/** Which surface a saved view belongs to (the legacy preset shape). */
export type SavedViewScope = "database" | "tickets";

/**
 * Which audience a named preset belongs to (the named-preset engine below):
 * `"personal"` views are private to one user, `"shared"` views are workspace
 * wide. A preset's name must be unique within its audience.
 */
export type SavedViewAudience = "personal" | "shared";

/**
 * A filter tree node, accepted loosely: a leaf filter or an `and`/`or` group.
 * The exact shape is owned by the view/query layer, not here.
 */
export type FilterNode = Record<string, unknown>;

/** A sort rule, accepted loosely (a missing/unknown direction means ascending). */
export type SavedViewSort = {
  propertyId: string;
  direction?: "asc" | "desc";
};

/**
 * A named view preset.
 *
 * The first five fields are the legacy preset shape (the database settings
 * panel and the tickets toolbar); the trailing fields are the named-preset
 * engine's captured snapshot (see `SavedViewRecord`). Everything is optional
 * beyond `id`/`name`/`scope` so both shapes round-trip through one record.
 */
export type SavedView = {
  /** Stable id; derived from the name on parse when a stored one is absent. */
  id: string;
  /** Display name, trimmed and unique case-insensitively within a workspace. */
  name: string;
  /** Which surface the preset applies to. */
  scope: SavedViewScope | SavedViewAudience;
  /** View type name, e.g. `"table"`, `"board"`, `"timeline"`. Loose on purpose. */
  viewType?: string;
  /** Filter tree, opaque to this module. */
  filter?: FilterNode[];
  /** Sort rules, in priority order. */
  sort?: SavedViewSort[];
  /** Property id the view groups by. */
  group?: string;
  /** Property ids the view hides. */
  hidden?: string[];
  /** Named-preset engine: a normalised `ViewConfig` snapshot. */
  config?: Partial<ViewConfig>;
  /** Named-preset engine: when the preset was captured (ISO 8601). */
  createdAt?: string;
  /** Named-preset engine: when the preset was last changed (ISO 8601). */
  updatedAt?: string;
  /** Named-preset engine: whether the preset floats to the top of a list. */
  pinned?: boolean;
};

/**
 * A named preset captured by the engine: a `SavedView` that always carries the
 * snapshot, both timestamps, and a `"personal"` / `"shared"` audience. This is
 * the type `captureView` returns and every reducer in this module preserves.
 */
export type SavedViewRecord = SavedView & {
  scope: SavedViewAudience;
  config: Partial<ViewConfig>;
  createdAt: string;
  updatedAt: string;
};

/**
 * The slice of a view config a preset can overlay. Structural, so it lines up
 * with the query layer's `ViewConfig` without importing it.
 */
export type ViewConfigLike = {
  viewType?: string;
  filter?: FilterNode[];
  sort?: SavedViewSort[];
  group?: string;
  hidden?: string[];
};

export type SavedViewValidation =
  | { ok: true; errors?: undefined }
  | { ok: false; errors: string[] };

/** The two supported scopes, in the order a picker offers them. */
export const SAVED_VIEW_SCOPES: readonly SavedViewScope[] = ["database", "tickets"];

/** A JSON object (not an array, not null), or `null` for anything else. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Lowercase, hyphen-separated slug; `"view"` when nothing survives. */
function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "view";
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Keep only the JSON-object nodes of a filter array; `undefined` when empty. */
function normalizeFilterNodes(input: unknown): FilterNode[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const nodes: FilterNode[] = [];
  for (const entry of input) {
    const node = asRecord(entry);
    if (node) nodes.push({ ...node });
  }
  return nodes.length > 0 ? nodes : undefined;
}

/** Drop sort entries without a property id; default the direction to `"asc"`. */
function normalizeSorts(input: unknown): SavedViewSort[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const sorts: SavedViewSort[] = [];
  for (const entry of input) {
    const record = asRecord(entry);
    if (!record) continue;
    const propertyId = trimmedString(record.propertyId);
    if (!propertyId) continue;
    sorts.push({ propertyId, direction: record.direction === "desc" ? "desc" : "asc" });
  }
  return sorts.length > 0 ? sorts : undefined;
}

/** Unique, non-blank hidden ids, in first-seen order; `undefined` when empty. */
function normalizeHidden(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const hidden: string[] = [];
  for (const entry of input) {
    const id = trimmedString(entry);
    if (id && !hidden.includes(id)) hidden.push(id);
  }
  return hidden.length > 0 ? hidden : undefined;
}

/**
 * Parse a stored view. Accepts a JSON string or an already-decoded object;
 * unknown/missing optional fields are dropped and a missing id is derived from
 * the name. Returns `null` when there is no usable name (the identity of a
 * view), or when the input is not a JSON object / not parseable JSON.
 */
export function parseSavedView(raw: unknown): SavedView | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const record = asRecord(value);
  if (!record) return null;

  const name = trimmedString(record.name);
  if (!name) return null;

  const scope = normalizeScope(record.scope);
  const storedId = trimmedString(record.id);

  const view: SavedView = {
    id: storedId ?? `sv_${slugify(name)}`,
    name,
    scope,
  };

  const viewType = trimmedString(record.viewType);
  if (viewType) view.viewType = viewType;

  const filter = normalizeFilterNodes(record.filter);
  if (filter) view.filter = filter;

  const sort = normalizeSorts(record.sort);
  if (sort) view.sort = sort;

  const group = trimmedString(record.group);
  if (group) view.group = group;

  const hidden = normalizeHidden(record.hidden);
  if (hidden) view.hidden = hidden;

  // Named-preset engine fields: a captured snapshot plus its timestamps and
  // pin flag. They round-trip when present and are simply absent otherwise.
  if (asRecord(record.config)) view.config = snapshotConfig(record.config);
  const createdAt = trimmedString(record.createdAt);
  if (createdAt) view.createdAt = createdAt;
  const updatedAt = trimmedString(record.updatedAt);
  if (updatedAt) view.updatedAt = updatedAt;
  if (typeof record.pinned === "boolean") view.pinned = record.pinned;

  return view;
}

function isFilterNodeArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => asRecord(entry) !== null);
}

function isSortArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      const record = asRecord(entry);
      return record !== null && trimmedString(record.propertyId) !== undefined;
    })
  );
}

function isHiddenArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => trimmedString(entry) !== undefined);
}

/**
 * Validate a view before it is saved. Reports every problem in one pass, with
 * stable codes: `missing_id`, `missing_name`, `invalid_scope`,
 * `invalid_view_type`, `invalid_filter`, `invalid_sort`, `invalid_group`,
 * `invalid_hidden` (and `not_an_object` for non-objects).
 */
function validateLegacyView(value: unknown): SavedViewValidation {
  const record = asRecord(value);
  if (!record) return { ok: false, errors: ["not_an_object"] };

  const errors: string[] = [];
  if (!trimmedString(record.id)) errors.push("missing_id");
  if (!trimmedString(record.name)) errors.push("missing_name");
  if (record.scope !== "database" && record.scope !== "tickets") errors.push("invalid_scope");
  if (record.viewType !== undefined && !trimmedString(record.viewType)) {
    errors.push("invalid_view_type");
  }
  if (record.filter !== undefined && !isFilterNodeArray(record.filter)) {
    errors.push("invalid_filter");
  }
  if (record.sort !== undefined && !isSortArray(record.sort)) errors.push("invalid_sort");
  if (record.group !== undefined && !trimmedString(record.group)) errors.push("invalid_group");
  if (record.hidden !== undefined && !isHiddenArray(record.hidden)) errors.push("invalid_hidden");

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** Drop views that share an id or a name (case-insensitive) with an earlier one. */
function dedupeViews(views: SavedView[]): SavedView[] {
  const ids = new Set<string>();
  const names = new Set<string>();
  const unique: SavedView[] = [];
  for (const view of views) {
    const idKey = view.id.toLowerCase();
    const nameKey = view.name.toLowerCase();
    if (ids.has(idKey) || names.has(nameKey)) continue;
    ids.add(idKey);
    names.add(nameKey);
    unique.push(view);
  }
  return unique;
}

/** A canonical, storage-only view: empty preset fields are omitted. */
function toStored(view: SavedView): SavedView {
  const stored: SavedView = { id: view.id, name: view.name, scope: view.scope };
  if (view.viewType) stored.viewType = view.viewType;
  if (view.filter && view.filter.length > 0) stored.filter = view.filter.map((node) => ({ ...node }));
  if (view.sort && view.sort.length > 0) stored.sort = view.sort.map((sort) => ({ ...sort }));
  if (view.group) stored.group = view.group;
  if (view.hidden && view.hidden.length > 0) stored.hidden = [...view.hidden];
  if (view.config && Object.keys(view.config).length > 0) stored.config = deepClone(view.config);
  if (view.createdAt) stored.createdAt = view.createdAt;
  if (view.updatedAt) stored.updatedAt = view.updatedAt;
  if (view.pinned) stored.pinned = true;
  return stored;
}

/**
 * Serialise views to a JSON array string. Invalid views are skipped and
 * duplicates (same id or name, case-insensitively) collapse to the first, so
 * the output is always safe to store and reload.
 */
export function serializeSavedViews(views: readonly SavedView[]): string {
  const list = Array.isArray(views) ? views : [];
  const valid = list
    .filter((view) => validateSavedView(view).ok)
    .map((view) => toStored(view as SavedView));
  return JSON.stringify(dedupeViews(valid));
}

/** Decode a JSON string, an array, or a `{ views: [...] }` wrapper to a list. */
function decodeViewList(raw: unknown): unknown[] | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (record && Array.isArray(record.views)) return record.views;
  return null;
}

/**
 * Read views back from storage. Accepts a JSON string, an array, or a
 * `{ views: [...] }` wrapper; unparseable entries are dropped and duplicates
 * (same id or name, case-insensitively) collapse to the first. Malformed input
 * yields `[]` rather than throwing.
 */
export function deserializeSavedViews(raw: unknown): SavedView[] {
  const entries = decodeViewList(raw);
  if (!entries) return [];
  const parsed: SavedView[] = [];
  for (const entry of entries) {
    const view = parseSavedView(entry);
    if (view) parsed.push(view);
  }
  return dedupeViews(parsed);
}

/**
 * Merge a preset over a base view config: every field the preset sets replaces
 * the base's, while base fields the preset leaves unset are kept. Works for
 * both shapes — a legacy preset overlays its loose `viewType`/`filter`/`sort`/
 * `group`/`hidden` fields, and a named preset overlays its captured
 * `config` snapshot. Everything is deep-copied, so neither the base config nor
 * the view is mutated and the caller can safely tweak the result. A missing
 * base config yields the preset alone.
 */
export function applySavedView(
  baseConfig: ViewConfigLike | Partial<ViewConfig> | null | undefined,
  view: SavedView,
): ViewConfigLike & Partial<ViewConfig> {
  const merged: Record<string, unknown> = {};

  const base = asRecord(baseConfig);
  if (base) {
    for (const [key, value] of Object.entries(base)) {
      if (value !== undefined) merged[key] = deepClone(value);
    }
  }

  const captured = asRecord(view.config);
  if (captured) {
    for (const [key, value] of Object.entries(captured)) {
      if (value !== undefined) merged[key] = deepClone(value);
    }
  }

  if (view.viewType !== undefined) merged.viewType = view.viewType;
  if (view.filter !== undefined) merged.filter = view.filter.map((node) => ({ ...node }));
  if (view.sort !== undefined) merged.sort = view.sort.map((sort) => ({ ...sort }));
  if (view.group !== undefined) merged.group = view.group;
  if (view.hidden !== undefined) merged.hidden = [...view.hidden];

  return merged as ViewConfigLike & Partial<ViewConfig>;
}

/**
 * The first view whose name matches `name`, compared case-insensitively and
 * ignoring surrounding whitespace. A blank name never matches.
 */
export function findByName(
  views: readonly SavedView[],
  name: unknown,
): SavedView | undefined {
  const needle = trimmedString(name)?.toLowerCase();
  if (!needle) return undefined;
  const list = Array.isArray(views) ? views : [];
  return list.find((view) => view && view.name.trim().toLowerCase() === needle);
}

/* ---------------------------------------------------------------------------
   Named-preset engine
   (docs/MISSING_FEATURES.md §2 "Saved views" / §3 Databases)

   Where the storage half above speaks the loose legacy preset shape, this half
   works with a captured snapshot of a real `ViewConfig`: capture it under a
   name + audience, validate it (empty/duplicate name per scope, unsupported
   config keys), diff it against a base, apply it, reorder/pin/rename/duplicate/
   delete it, list it ranked, and describe it. Every function is pure — no DB,
   no routes, no React — and every reducer returns a fresh array while sharing
   untouched records, so a caller can keep the previous state for undo.
   --------------------------------------------------------------------------- */

/**
 * Every key `ViewConfig` (owned by `@/lib/database-query`) can carry. A captured
 * config is reduced to these keys; a config carrying anything else is reported
 * by `validateSavedView` as an unsupported key.
 */
const VIEW_CONFIG_KEYS = [
  "filters",
  "filterMode",
  "filterTree",
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
  // Toolbar-owned keys added by the wiring waves: without these, a captured
  // saved view silently drops the footer, format rules, filter tree builder,
  // property layout and page size.
  "footer",
  "formatRules",
  "filterBuilder",
  "propertyLayout",
  "pageSize",
  "groupOrder",
  "groupAggregation",
  "quickFilter",
  "conditionalFormat",
] as const satisfies readonly (keyof ViewConfig)[];

const VIEW_CONFIG_KEY_SET: ReadonlySet<string> = new Set(VIEW_CONFIG_KEYS);

/** Deep-copy a JSON-safe value (stored view config is untrusted JSON). */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Normalise an untrusted config into the canonical snapshot the engine stores:
 * the query layer owns the rules, so a snapshot captured here renders exactly
 * like the live view it came from, and a deep copy keeps the snapshot from
 * aliasing (and later mutating) the caller's input.
 */
function snapshotConfig(raw: unknown): Partial<ViewConfig> {
  return deepClone(normalizeViewConfig(raw));
}

/** Preserve every known scope, defaulting anything else to `"database"`. */
function normalizeScope(value: unknown): SavedViewScope | SavedViewAudience {
  return value === "tickets" || value === "personal" || value === "shared" ? value : "database";
}

/** An ISO-8601 timestamp from a `Date` / epoch millis / parseable string. */
function toIso(now: string | number | Date | undefined): string {
  if (now === undefined) return new Date().toISOString();
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "number") return new Date(now).toISOString();
  const parsed = Date.parse(now);
  return Number.isNaN(parsed) ? now : new Date(parsed).toISOString();
}

function isValidTimestamp(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** Options for `captureView`. `id`/`scope`/`now` are injected for determinism. */
export type CaptureViewOptions = {
  name: string;
  scope?: SavedViewAudience;
  id?: string;
  /** Injectable clock: an ISO string, epoch millis, or a `Date`. */
  now?: string | number | Date;
};

/**
 * Capture the current view config as a named preset. The config is normalised
 * and deep-copied (unsupported keys are dropped); the name is trimmed; the id
 * is the provided one or a slug of the name; `createdAt`/`updatedAt` are the
 * same injected `now`.
 */
export function captureView(config: unknown, options: CaptureViewOptions): SavedViewRecord {
  const name = trimmedString(options.name) ?? "";
  const scope: SavedViewAudience = options.scope === "shared" ? "shared" : "personal";
  const id = trimmedString(options.id) ?? `sv_${slugify(name)}`;
  const timestamp = toIso(options.now);
  return {
    id,
    name,
    scope,
    config: snapshotConfig(config),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** Validate a named preset, reporting every problem in one pass. */
function validateNamedView(
  record: Record<string, unknown>,
  existing: readonly SavedView[] | undefined,
): SavedViewValidation {
  const errors: string[] = [];
  const id = trimmedString(record.id);
  const name = trimmedString(record.name);
  if (!id) errors.push("empty_id");
  if (!name) errors.push("empty_name");
  if (record.scope !== "personal" && record.scope !== "shared") errors.push("invalid_scope");

  // A name only has to be unique within its own audience, and a view never
  // collides with itself (so renaming to the same spelling stays valid).
  if (name && existing && existing.length > 0) {
    const needle = name.toLowerCase();
    const scope = record.scope;
    const duplicate = existing.some(
      (view) =>
        view &&
        view.id !== id &&
        view.scope === scope &&
        trimmedString(view.name)?.toLowerCase() === needle,
    );
    if (duplicate) errors.push("duplicate_name");
  }

  const config = record.config;
  if (config !== undefined) {
    const object = asRecord(config);
    if (!object) {
      errors.push("invalid_config");
    } else {
      for (const key of Object.keys(object)) {
        if (!VIEW_CONFIG_KEY_SET.has(key)) errors.push(`unsupported_key:${key}`);
      }
    }
  }

  if (record.createdAt !== undefined && !isValidTimestamp(record.createdAt)) {
    errors.push("invalid_created_at");
  }
  if (record.updatedAt !== undefined && !isValidTimestamp(record.updatedAt)) {
    errors.push("invalid_updated_at");
  }
  if (record.pinned !== undefined && typeof record.pinned !== "boolean") {
    errors.push("invalid_pinned");
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Validate a view before it is saved. A named preset (`scope` of `"personal"`
 * or `"shared"`) is checked for an empty id/name, a duplicate name within its
 * audience (`existing`), unsupported config keys, and malformed timestamps or
 * pin flag; a legacy preset keeps the loose `viewType`/`filter`/`sort`/`group`/
 * `hidden` checks. Every problem is reported in one pass.
 */
export function validateSavedView(
  value: unknown,
  existing?: readonly SavedView[],
): SavedViewValidation {
  const record = asRecord(value);
  if (record && (record.scope === "personal" || record.scope === "shared")) {
    return validateNamedView(record, existing);
  }
  return validateLegacyView(value);
}

/** One field a preset changes relative to a base config. */
export type SavedViewDiffKind = "added" | "changed" | "removed";

export type SavedViewDiffEntry = {
  key: string;
  kind: SavedViewDiffKind;
  from?: unknown;
  to?: unknown;
};

/** Structural equality that ignores object-key order (wip/group maps). */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = sortKeys(record[key]);
    return sorted;
  }
  return value;
}

/**
 * Describe what a preset changes relative to `base`: every key in either config
 * as `added`, `changed` (with `from`/`to`), or `removed`. Entries are ordered
 * by key so the result is stable; identical configs yield `[]`.
 */
export function diffView(base: unknown, view: SavedView): SavedViewDiffEntry[] {
  const before = snapshotConfig(base ?? {}) as Record<string, unknown>;
  const after = snapshotConfig(view.config ?? {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const entries: SavedViewDiffEntry[] = [];
  for (const key of keys) {
    const hasBefore = key in before;
    const hasAfter = key in after;
    if (hasBefore && !hasAfter) {
      entries.push({ key, kind: "removed", from: before[key] });
    } else if (!hasBefore && hasAfter) {
      entries.push({ key, kind: "added", to: after[key] });
    } else if (stableStringify(before[key]) !== stableStringify(after[key])) {
      entries.push({ key, kind: "changed", from: before[key], to: after[key] });
    }
  }
  return entries;
}

/** `"3 filters"` / `"1 sort"` — a count with a pluralised noun. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * A one-line human summary of a preset: its name, audience, pin state, and the
 * shape it imposes (filter / sort / group / column counts). Deterministic, so
 * it is safe to snapshot in tests.
 */
export function describeSavedView(view: SavedView): string {
  const name = trimmedString(view.name) ?? "Untitled view";
  const scope = view.scope === "shared" ? "shared" : "personal";
  const config = view.config ?? {};
  const parts: string[] = [];
  const filters = Array.isArray(config.filters) ? config.filters : [];
  const filterTree = Array.isArray(config.filterTree) ? config.filterTree : [];
  const sorts = Array.isArray(config.sorts) ? config.sorts : [];
  if (filters.length > 0) parts.push(plural(filters.length, "filter"));
  if (filterTree.length > 0) parts.push(plural(filterTree.length, "filter group"));
  if (sorts.length > 0) parts.push(plural(sorts.length, "sort"));
  if (typeof config.groupByPropertyId === "string" && config.groupByPropertyId !== "") {
    parts.push(`grouped by ${config.groupByPropertyId}`);
  }
  if (Array.isArray(config.visiblePropertyIds)) {
    parts.push(plural(config.visiblePropertyIds.length, "visible column"));
  }
  const pinned = view.pinned ? ", pinned" : "";
  const detail = parts.length > 0 ? ` — ${parts.join(", ")}` : "";
  return `${name} (${scope}${pinned})${detail}`;
}

/** Rename a preset, bumping `updatedAt`; a blank name is a fresh no-op copy. */
export function renameView(
  views: readonly SavedViewRecord[],
  id: string,
  name: string,
  now?: string | number | Date,
): SavedViewRecord[] {
  const trimmed = trimmedString(name);
  if (!trimmed) return [...views];
  const timestamp = toIso(now);
  return views.map((view) =>
    view.id === id ? { ...view, name: trimmed, updatedAt: timestamp } : view,
  );
}

/**
 * Move the `fromId` preset to sit immediately before `toId`. Immutable: the
 * input is untouched and untouched records are shared. An unknown `fromId` or
 * `fromId === toId` returns a fresh copy; an unknown `toId` appends the moved
 * preset at the end instead of dropping it.
 */
export function reorderViews(
  views: readonly SavedViewRecord[],
  fromId: string,
  toId: string,
): SavedViewRecord[] {
  if (fromId === toId) return [...views];
  const fromIndex = views.findIndex((view) => view.id === fromId);
  if (fromIndex === -1) return [...views];
  const moved = views[fromIndex];
  const rest = views.filter((view) => view.id !== fromId);
  const targetIndex = rest.findIndex((view) => view.id === toId);
  if (targetIndex === -1) {
    rest.push(moved);
    return rest;
  }
  rest.splice(targetIndex, 0, moved);
  return rest;
}

/** Pin (default) or unpin a preset; a missing id is a fresh copy. */
export function pinView(
  views: readonly SavedViewRecord[],
  id: string,
  pinned = true,
): SavedViewRecord[] {
  return views.map((view) => (view.id === id ? { ...view, pinned } : view));
}

export type DuplicateViewOptions = {
  id?: string;
  name?: string;
  now?: string | number | Date;
};

/** First free `${id}-copy` (then `-copy-2`, …). */
function uniqueCopyId(views: readonly SavedViewRecord[], id: string): string {
  const base = `${id}-copy`;
  if (!views.some((view) => view.id === base)) return base;
  let n = 2;
  while (views.some((view) => view.id === `${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** First free `${name} copy` (then `copy 2`, …), case-insensitively. */
function uniqueCopyName(views: readonly SavedViewRecord[], name: string): string {
  const base = `${name} copy`;
  const taken = new Set(views.map((view) => view.name.trim().toLowerCase()));
  if (!taken.has(base.trim().toLowerCase())) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`.trim().toLowerCase())) n += 1;
  return `${base} ${n}`;
}

/**
 * Insert a copy of the preset directly after it, with a fresh id/name (derived
 * when not supplied) and both timestamps reset to `now`. Immutable.
 */
export function duplicateView(
  views: readonly SavedViewRecord[],
  id: string,
  options: DuplicateViewOptions = {},
): SavedViewRecord[] {
  const index = views.findIndex((view) => view.id === id);
  if (index === -1) return [...views];
  const original = views[index];
  const timestamp = toIso(options.now);
  const copy: SavedViewRecord = {
    ...original,
    id: trimmedString(options.id) ?? uniqueCopyId(views, original.id),
    name: trimmedString(options.name) ?? uniqueCopyName(views, original.name),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return [...views.slice(0, index + 1), copy, ...views.slice(index + 1)];
}

/** Remove a preset by id. Immutable; an unknown id is a fresh copy. */
export function deleteView(
  views: readonly SavedViewRecord[],
  id: string,
): SavedViewRecord[] {
  return views.filter((view) => view.id !== id);
}

export type SavedViewSortKey = "relevance" | "name" | "created" | "updated";

export type ListSavedViewsOptions = {
  scope?: SavedViewAudience;
  /** Case-insensitive name search; ranks exact > prefix > substring. */
  query?: string;
  sort?: SavedViewSortKey;
};

/** 0 exact, 1 prefix, 2 substring, 3 description match, -1 no match. */
function matchRank(view: SavedViewRecord, query: string): number {
  const name = view.name.trim().toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  const description =
    typeof view.config.description === "string" ? view.config.description.toLowerCase() : "";
  if (description.includes(query)) return 3;
  return -1;
}

function compareViews(
  a: SavedViewRecord,
  b: SavedViewRecord,
  sort: SavedViewSortKey,
  rankOf: (view: SavedViewRecord) => number,
): number {
  // Pinned presets always float, whichever sort is chosen.
  const pinned = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
  if (pinned !== 0) return pinned;
  if (sort === "name") {
    const byName = a.name.localeCompare(b.name, undefined, { numeric: true });
    if (byName !== 0) return byName;
  } else if (sort === "created") {
    const byCreated = b.createdAt.localeCompare(a.createdAt);
    if (byCreated !== 0) return byCreated;
  } else if (sort === "updated") {
    const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
    if (byUpdated !== 0) return byUpdated;
  } else {
    const byRank = rankOf(a) - rankOf(b);
    if (byRank !== 0) return byRank;
    const byName = a.name.localeCompare(b.name, undefined, { numeric: true });
    if (byName !== 0) return byName;
  }
  return a.id.localeCompare(b.id);
}

/**
 * List presets ranked for a picker: filtered by audience and a name `query`,
 * with pinned presets first, then by the requested sort (`"relevance"` by
 * default — exact/prefix/substring name matches). Never mutates the input.
 */
export function listSavedViews(
  views: readonly SavedViewRecord[],
  options: ListSavedViewsOptions = {},
): SavedViewRecord[] {
  const query = (options.query ?? "").trim().toLowerCase();
  const sort = options.sort ?? "relevance";
  const rankOf = (view: SavedViewRecord): number => (query === "" ? 0 : matchRank(view, query));
  const kept = views
    .filter((view) => (options.scope ? view.scope === options.scope : true))
    .filter((view) => rankOf(view) >= 0);
  return [...kept].sort((a, b) => compareViews(a, b, sort, rankOf));
}
