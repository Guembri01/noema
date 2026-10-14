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

/** Which surface a saved view belongs to. */
export type SavedViewScope = "database" | "tickets";

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

/** A named view preset. */
export type SavedView = {
  /** Stable id; derived from the name on parse when a stored one is absent. */
  id: string;
  /** Display name, trimmed and unique case-insensitively within a workspace. */
  name: string;
  /** Which surface the preset applies to. */
  scope: SavedViewScope;
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

  const scope: SavedViewScope = record.scope === "tickets" ? "tickets" : "database";
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
export function validateSavedView(value: unknown): SavedViewValidation {
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
 * Merge a preset over a base view config: every preset field the view sets
 * replaces the base's, while base fields the preset leaves unset are kept.
 * Arrays are copied, so neither the base config nor the view is mutated and the
 * caller can safely tweak the result. A missing base config yields the preset
 * alone.
 */
export function applySavedView(
  baseConfig: ViewConfigLike | null | undefined,
  view: SavedView,
): ViewConfigLike {
  const merged: ViewConfigLike = {};

  if (baseConfig) {
    if (baseConfig.viewType !== undefined) merged.viewType = baseConfig.viewType;
    if (baseConfig.filter !== undefined) merged.filter = baseConfig.filter.map((node) => ({ ...node }));
    if (baseConfig.sort !== undefined) merged.sort = baseConfig.sort.map((sort) => ({ ...sort }));
    if (baseConfig.group !== undefined) merged.group = baseConfig.group;
    if (baseConfig.hidden !== undefined) merged.hidden = [...baseConfig.hidden];
  }

  if (view.viewType !== undefined) merged.viewType = view.viewType;
  if (view.filter !== undefined) merged.filter = view.filter.map((node) => ({ ...node }));
  if (view.sort !== undefined) merged.sort = view.sort.map((sort) => ({ ...sort }));
  if (view.group !== undefined) merged.group = view.group;
  if (view.hidden !== undefined) merged.hidden = [...view.hidden];

  return merged;
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
