/**
 * Column resize / reorder: a pure layout model for database table views
 * (docs/MISSING_FEATURES.md §3 "Column resize" / "Column resize/reorder").
 *
 * A view remembers three things about its columns, together in one
 * `ColumnLayout`: the left-to-right `order` of column ids, a per-column pixel
 * `widths` map, and a per-column `hidden` flag. Everything here is pure —
 * no DB, no routes, no React — so a table header can reorder/resize/hide
 * columns as optimistic local edits and persist the whole thing later.
 *
 * Fail-safe by design (same contract as `@/lib/row-color-rules`): the layout
 * round-trips through the DB as untrusted JSON, so `deserializeLayout` and
 * every mutator normalise their input rather than trust the type. A malformed
 * saved layout degrades to an empty one, and garbage widths/flags are dropped
 * instead of throwing. Mutators are immutable: they never touch the input and
 * never alias its arrays/objects, so callers can hold the previous layout in
 * React state while the next one is computed.
 */

/** Widest a column may be dragged to, absent an explicit override. */
export const DEFAULT_MAX_WIDTH = 800;
/** Narrowest a column may be dragged to, absent an explicit override. */
export const DEFAULT_MIN_WIDTH = 80;
/** Width given to a column that has never been resized. */
export const DEFAULT_COLUMN_WIDTH = 200;

/**
 * The persisted column layout for one view.
 *
 * - `order` lists column ids left-to-right; ids absent from it are treated as
 *   appended (see `mergeLayout`).
 * - `widths` maps column id → pixel width; an id without an entry falls back
 *   to `DEFAULT_COLUMN_WIDTH`.
 * - `hidden` maps column id → `true` for hidden columns; a missing/false entry
 *   means visible. Only `true` is ever stored (see `toggleColumnVisibility`).
 */
export type ColumnLayout = {
  order: string[];
  widths: Record<string, number>;
  hidden: Record<string, boolean>;
};

/** Overridable resize bounds; each side defaults when absent/non-finite. */
export type ColumnWidthOptions = {
  min?: number;
  max?: number;
};

/** A fresh, empty layout — the value every failure path degrades to. */
export function emptyLayout(): ColumnLayout {
  return { order: [], widths: {}, hidden: {} };
}

/** Resolve a resize bound, falling back to `fallback` for non-finite input. */
function resolveBound(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : fallback;
}

/** Dedupe a list of candidate column ids, dropping blanks and non-strings. */
function uniqueIds(columnIds: readonly string[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of columnIds) {
    if (typeof id === "string" && id !== "" && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Canonicalise an untrusted layout.
 *
 * Every mutator and the deserializer funnel through here, which is what makes
 * the module total: `order` keeps only unique non-empty string ids; `widths`
 * keeps only finite numbers (clamped into `[min, max]`); `hidden` keeps only
 * exact `true`s. Anything else — `null`, arrays, wrong-typed fields — is
 * dropped. The result is always a fresh, well-formed layout.
 */
function normalizeLayout(input: unknown): ColumnLayout {
  const source: Record<string, unknown> =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

  const order = uniqueIds(Array.isArray(source.order) ? source.order : []);

  const widths: Record<string, number> = {};
  if (
    typeof source.widths === "object" &&
    source.widths !== null &&
    !Array.isArray(source.widths)
  ) {
    for (const [id, value] of Object.entries(source.widths)) {
      if (id === "" || typeof value !== "number" || !Number.isFinite(value)) continue;
      widths[id] = clampWidth(value);
    }
  }

  const hidden: Record<string, boolean> = {};
  if (
    typeof source.hidden === "object" &&
    source.hidden !== null &&
    !Array.isArray(source.hidden)
  ) {
    for (const [id, value] of Object.entries(source.hidden)) {
      if (id !== "" && value === true) hidden[id] = true;
    }
  }

  return { order, widths, hidden };
}

/**
 * Clamp a pixel width into `[min, max]` (defaults `80..800`), rounded to a
 * whole pixel.
 *
 * Total on any numeric input: `NaN` and `-Infinity` collapse to the minimum,
 * `Infinity` to the maximum, and a reversed range (`max < min`) degrades to
 * the minimum so a bad pair of bounds can never produce `max < actual`. This
 * is the single clamp every width path shares, so the UI's drag, the stored
 * width, and `autoFitWidths` all agree on the bounds.
 */
export function clampWidth(width: number, options: ColumnWidthOptions = {}): number {
  const min = resolveBound(options.min, DEFAULT_MIN_WIDTH);
  const max = Math.max(min, resolveBound(options.max, DEFAULT_MAX_WIDTH));

  let value = typeof width === "number" ? width : Number.NaN;
  if (Number.isNaN(value)) value = min;
  if (value === Number.POSITIVE_INFINITY) value = max;
  if (value === Number.NEGATIVE_INFINITY) value = min;

  return Math.min(Math.max(Math.round(value), min), max);
}

/**
 * Move `fromId` so it lands at the index `toId` originally occupied — the
 * same convention as the array `move` used for sidebar favorites.
 *
 * Dragging a column rightward therefore lands it *after* the target, and
 * leftward *before* it, which is what a header drag previews. Unknown ids or
 * a same-column drag leave the order unchanged. Returns a new layout; the
 * input is never mutated or aliased.
 */
export function reorderColumns(
  layout: ColumnLayout,
  fromId: string,
  toId: string,
): ColumnLayout {
  const base = normalizeLayout(layout);
  const order = [...base.order];
  const fromIndex = order.indexOf(fromId);
  const toIndex = order.indexOf(toId);
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
    return { ...base, order };
  }
  const [moved] = order.splice(fromIndex, 1);
  order.splice(toIndex, 0, moved);
  return { ...base, order };
}

/**
 * Set one column's width, clamped to `[min, max]`. Immutable: returns a new
 * layout with a new `widths` map. A blank id is ignored (returns the
 * normalised layout unchanged).
 */
export function setColumnWidth(
  layout: ColumnLayout,
  id: string,
  width: number,
): ColumnLayout {
  const base = normalizeLayout(layout);
  if (typeof id !== "string" || id === "") return base;
  return { ...base, widths: { ...base.widths, [id]: clampWidth(width) } };
}

/**
 * Toggle a column's visibility, refusing to hide the last visible column (a
 * table with no columns is not a state a view may be in).
 *
 * Hiding stores `true`; showing deletes the key, so a visible column is never
 * represented by a leftover `false`. An id not in `order` is a no-op — only
 * real columns can be hidden. Immutable: the input `hidden` map is never
 * touched.
 */
export function toggleColumnVisibility(
  layout: ColumnLayout,
  id: string,
): ColumnLayout {
  const base = normalizeLayout(layout);
  if (!base.order.includes(id)) return base;

  const currentlyHidden = base.hidden[id] === true;
  const hiddenCount = base.order.filter((columnId) => base.hidden[columnId] === true)
    .length;
  if (!currentlyHidden && hiddenCount >= base.order.length - 1) {
    return base; // would leave zero visible columns
  }

  const hidden = { ...base.hidden };
  if (currentlyHidden) {
    delete hidden[id];
  } else {
    hidden[id] = true;
  }
  return { ...base, hidden };
}

/**
 * Merge a saved layout with the column ids the schema currently has.
 *
 * Surviving columns keep their saved order/width/hidden state; ids no longer
 * in `columnIds` are dropped (deleted properties); ids new to the schema are
 * appended at the end with a default width and visible. The schema order only
 * breaks ties for columns the saved order does not mention, so an unsaved or
 * empty layout simply follows the schema.
 */
export function mergeLayout(
  saved: ColumnLayout,
  columnIds: readonly string[],
): ColumnLayout {
  const base = normalizeLayout(saved);
  const ids = uniqueIds(columnIds);
  const valid = new Set(ids);

  const order: string[] = [];
  const taken = new Set<string>();
  for (const id of base.order) {
    if (valid.has(id) && !taken.has(id)) {
      taken.add(id);
      order.push(id);
    }
  }
  for (const id of ids) {
    if (!taken.has(id)) {
      taken.add(id);
      order.push(id);
    }
  }

  const widths: Record<string, number> = {};
  const hidden: Record<string, boolean> = {};
  for (const id of order) {
    widths[id] = base.widths[id] ?? DEFAULT_COLUMN_WIDTH;
    if (base.hidden[id] === true) hidden[id] = true;
  }

  return { order, widths, hidden };
}

/**
 * Distribute `available` pixels across `columnIds` as evenly as the resize
 * bounds allow, returning one width per column.
 *
 * The even share is clamped per column, so tight space floors every column at
 * `min` (the row may overflow and scroll) and plentiful space caps each at
 * `max`. A non-finite `available` floors every column at `min` rather than
 * producing `NaN` widths. No columns yields an empty map.
 */
export function autoFitWidths(
  available: number,
  columnIds: readonly string[],
  options: ColumnWidthOptions = {},
): Record<string, number> {
  const ids = uniqueIds(columnIds);
  const widths: Record<string, number> = {};
  if (ids.length === 0) return widths;

  const min = resolveBound(options.min, DEFAULT_MIN_WIDTH);
  const share =
    typeof available === "number" && Number.isFinite(available)
      ? available / ids.length
      : min;
  for (const id of ids) {
    widths[id] = clampWidth(share, options);
  }
  return widths;
}

/**
 * The columns to render, left-to-right: the layout's saved order (extended
 * with any new schema columns) with hidden columns removed. Thin composition
 * of `mergeLayout` plus a hidden filter, so it agrees with what `mergeLayout`
 * would persist.
 */
export function visibleColumns(
  layout: ColumnLayout,
  columnIds: readonly string[],
): string[] {
  const merged = mergeLayout(layout, columnIds);
  return merged.order.filter((id) => merged.hidden[id] !== true);
}

/**
 * Serialise a layout to canonical JSON. Normalises first, so the text always
 * reflects the clamped/validated shape that `deserializeLayout` would read
 * back — `deserializeLayout(serializeLayout(x))` is a stable round-trip.
 */
export function serializeLayout(layout: ColumnLayout): string {
  return JSON.stringify(normalizeLayout(layout));
}

/**
 * Parse a persisted layout, tolerating anything.
 *
 * Unparseable text, `null`/`undefined`, JSON that is not an object, or an
 * object with malformed fields all resolve to a normalised layout — never a
 * throw. This is the boundary that keeps a corrupted view config from taking
 * a table down.
 */
export function deserializeLayout(raw: string | null | undefined): ColumnLayout {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return emptyLayout();
    }
  }
  return normalizeLayout(parsed);
}

/* ------------------------------------------------------------------------- *
 * Per-view column width / order model (docs/specs/database-deep.md R89.13).
 *
 * The legacy `ColumnLayout` above persists columns as a `hidden` map and is
 * consumed by the table components. This second model is layered additively on
 * top for the R89.13 slice: it adds an explicit `pinned` list, an array-shaped
 * `hidden` list, and schema-aware resolution (`resolveLayout`) against the
 * database's property list, so a saved per-view order/width can be merged with
 * the database-wide `Property.position` default. It is pure and fail-safe in the
 * same way as the legacy path.
 * ------------------------------------------------------------------------- */

/**
 * Default pixel width per Prisma `PropertyType` name. A column that has never
 * been resized is sized from its property's type, so a checkbox stays narrow
 * and a text column stays wide. Unknown types fall back to `DEFAULT_COLUMN_WIDTH`.
 */
export const DEFAULT_WIDTH_BY_TYPE: Readonly<Record<string, number>> = {
  TEXT: 240,
  NUMBER: 120,
  SELECT: 160,
  MULTI_SELECT: 200,
  STATUS: 160,
  DATE: 160,
  CHECKBOX: 80,
  URL: 240,
  EMAIL: 200,
  PHONE: 160,
  PLACE: 200,
  PEOPLE: 200,
  FILES: 200,
  FORMULA: 160,
  RELATION: 200,
  ROLLUP: 160,
  CREATED_TIME: 180,
  CREATED_BY: 180,
  LAST_EDITED_TIME: 180,
  LAST_EDITED_BY: 180,
  UNIQUE_ID: 140,
  BUTTON: 120,
  AI_AUTOFILL: 200,
};

/**
 * The per-view column layout (R89.13).
 *
 * - `order` lists property ids left-to-right; ids absent from it are appended
 *   in schema order by `resolveLayout`.
 * - `widths` maps property id → pixel width; an unlisted id falls back to the
 *   property's `DEFAULT_WIDTH_BY_TYPE` entry.
 * - `pinned` lists property ids rendered first (the primary column); absent
 *   means nothing is pinned.
 * - `hidden` lists property ids hidden from the view; absent means all visible.
 */
export type ViewColumnLayout = {
  order: string[];
  widths: Record<string, number>;
  pinned?: string[];
  hidden?: string[];
};

/** Minimal property descriptor needed to resolve ids/types/names. */
export type ColumnProperty = {
  id: string;
  name?: string;
  type?: string;
};

/** Options carrying the database's current schema (property list). */
export type ResolveLayoutOptions = {
  properties: readonly ColumnProperty[];
};

/** One column as the table should render it, after schema resolution. */
export type ResolvedColumn = {
  /** Property id this column shows. */
  propertyId: string;
  /** Effective pixel width (saved width, or the type default). */
  width: number;
  /** Whether the column is pinned to the front (primary/frozen). */
  pinned: boolean;
};

/** Lookup used by `describeLayout` to turn a property id into a display label. */
export type DescribeLayoutOptions = {
  propertyName?: (propertyId: string) => string;
};

/** The issues `validateLayout` can report. */
export type LayoutValidation = {
  /** `true` when there are no unknown and no duplicate ids. */
  valid: boolean;
  /** Referenced ids (order/widths/pinned/hidden) not in the schema, sorted. */
  unknownIds: string[];
  /** Ids that appear more than once in `order`, sorted. */
  duplicateIds: string[];
};

/** Internal shape with every list canonical and present. */
type NormalizedViewLayout = {
  order: string[];
  widths: Record<string, number>;
  pinned: string[];
  hidden: string[];
};

/** True for a plain object (not an array, not null). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Dedupe string ids, dropping blanks and non-strings, preserving first-seen order. */
function uniqueViewIds(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value === "string" && value !== "" && !seen.has(value)) {
      seen.add(value);
      ids.push(value);
    }
  }
  return ids;
}

/** Non-empty string ids in raw order, keeping repeats (for duplicate detection). */
function rawViewIds(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is string => typeof value === "string" && value !== "");
}

/** Valid property ids in schema order (deduped, blanks and non-strings dropped). */
function viewSchemaIds(properties: readonly ColumnProperty[] | undefined): string[] {
  if (!Array.isArray(properties)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const property of properties) {
    const id = property?.id;
    if (typeof id === "string" && id !== "" && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/** Canonicalise an untrusted per-view layout. */
function normalizeViewLayout(input: unknown): NormalizedViewLayout {
  const source = isPlainRecord(input) ? input : {};

  const widths: Record<string, number> = {};
  if (isPlainRecord(source.widths)) {
    for (const [id, value] of Object.entries(source.widths)) {
      if (id === "" || typeof value !== "number" || !Number.isFinite(value)) continue;
      widths[id] = clampWidth(value);
    }
  }

  return {
    order: uniqueViewIds(source.order),
    widths,
    pinned: uniqueViewIds(source.pinned),
    hidden: uniqueViewIds(source.hidden),
  };
}

/** Materialise a fresh, public `ViewColumnLayout` from a normalised one. */
function toViewLayout(layout: NormalizedViewLayout): ViewColumnLayout {
  return {
    order: [...layout.order],
    widths: { ...layout.widths },
    pinned: [...layout.pinned],
    hidden: [...layout.hidden],
  };
}

/** The default width for a property type, case-insensitively, else the fallback. */
export function defaultWidthForType(type?: string): number {
  if (typeof type === "string") {
    const width = DEFAULT_WIDTH_BY_TYPE[type.trim().toUpperCase()];
    if (typeof width === "number") return width;
  }
  return DEFAULT_COLUMN_WIDTH;
}

/**
 * Parse a persisted per-view layout, tolerating anything.
 *
 * Unparseable text, `null`/`undefined`, JSON that is not an object, or an
 * object with malformed fields all resolve to a normalised layout — never a
 * throw. A draft object may also be passed directly (e.g. a fixture).
 */
export function parseColumnLayout(raw: unknown): ViewColumnLayout {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return toViewLayout(normalizeViewLayout({}));
    }
  }
  return toViewLayout(normalizeViewLayout(parsed));
}

/**
 * Serialise a per-view layout to canonical JSON. Normalises first, so the text
 * always reflects the clamped/validated shape `parseColumnLayout` reads back —
 * `parseColumnLayout(serializeColumnLayout(x))` is a stable round-trip.
 */
export function serializeColumnLayout(layout: ViewColumnLayout): string {
  return JSON.stringify(parseColumnLayout(layout));
}

/**
 * Resolve a saved `layout` against the schema `properties` into the ordered,
 * visible columns the table renders.
 *
 * The per-view override wins over the database-wide default: saved ids come
 * first in their saved order, ids the schema gained are appended in schema
 * order, and ids no longer in the schema are dropped. `hidden` ids are removed,
 * then `pinned` ids float to the front (stable within the remaining order).
 * Widths use the saved value when present, else the property's
 * `DEFAULT_WIDTH_BY_TYPE` entry. Never mutates its input.
 */
export function resolveLayout(
  layout: ViewColumnLayout,
  options: ResolveLayoutOptions,
): ResolvedColumn[] {
  const base = normalizeViewLayout(layout);
  const schema = viewSchemaIds(options?.properties);
  const schemaSet = new Set(schema);

  const ordered: string[] = [];
  const taken = new Set<string>();
  for (const id of base.order) {
    if (schemaSet.has(id) && !taken.has(id)) {
      taken.add(id);
      ordered.push(id);
    }
  }
  for (const id of schema) {
    if (!taken.has(id)) {
      taken.add(id);
      ordered.push(id);
    }
  }

  const typeById = new Map<string, string | undefined>();
  for (const property of options?.properties ?? []) {
    if (property && typeof property.id === "string") typeById.set(property.id, property.type);
  }

  const hidden = new Set(base.hidden);
  const pinned = new Set(base.pinned);
  const visible = ordered.filter((id) => !hidden.has(id));
  const finalOrder = [
    ...visible.filter((id) => pinned.has(id)),
    ...visible.filter((id) => !pinned.has(id)),
  ];

  return finalOrder.map((propertyId) => {
    const saved = base.widths[propertyId];
    return {
      propertyId,
      width: typeof saved === "number" ? saved : defaultWidthForType(typeById.get(propertyId)),
      pinned: pinned.has(propertyId),
    };
  });
}

/**
 * Set one column's width, clamped to `[min, max]`. Immutable: returns a new
 * layout with a new `widths` map. A blank id is ignored.
 */
export function resizeColumn(
  layout: ViewColumnLayout,
  propertyId: string,
  px: number,
  options: ColumnWidthOptions = {},
): ViewColumnLayout {
  const base = normalizeViewLayout(layout);
  if (typeof propertyId !== "string" || propertyId === "") return toViewLayout(base);
  return toViewLayout({
    ...base,
    widths: { ...base.widths, [propertyId]: clampWidth(px, options) },
  });
}

/**
 * Move `propertyId` to `index` in the saved order (index clamped into range).
 *
 * Immutable: returns a new layout. An unknown id — or one absent from `order` —
 * is a no-op, and a non-finite index pins the column to the end.
 */
export function moveColumn(
  layout: ViewColumnLayout,
  propertyId: string,
  index: number,
): ViewColumnLayout {
  const base = normalizeViewLayout(layout);
  const from = base.order.indexOf(propertyId);
  if (from === -1) return toViewLayout(base);

  const order = [...base.order];
  order.splice(from, 1);
  const target = Number.isFinite(index)
    ? Math.min(Math.max(Math.trunc(index), 0), order.length)
    : order.length;
  order.splice(target, 0, propertyId);
  return toViewLayout({ ...base, order });
}

/** Pin a column to the front (idempotent; blank ids ignored). Immutable. */
export function pinColumn(layout: ViewColumnLayout, propertyId: string): ViewColumnLayout {
  const base = normalizeViewLayout(layout);
  if (typeof propertyId !== "string" || propertyId === "") return toViewLayout(base);
  if (base.pinned.includes(propertyId)) return toViewLayout(base);
  return toViewLayout({ ...base, pinned: [...base.pinned, propertyId] });
}

/** Remove a column from the pinned list. Immutable; unknown ids are a no-op. */
export function unpinColumn(layout: ViewColumnLayout, propertyId: string): ViewColumnLayout {
  const base = normalizeViewLayout(layout);
  return toViewLayout({ ...base, pinned: base.pinned.filter((id) => id !== propertyId) });
}

/**
 * Toggle a column between hidden and visible. Immutable. A blank id is a no-op;
 * hiding appends to `hidden`, showing removes the id entirely.
 */
export function toggleVisibility(
  layout: ViewColumnLayout,
  propertyId: string,
): ViewColumnLayout {
  const base = normalizeViewLayout(layout);
  if (typeof propertyId !== "string" || propertyId === "") return toViewLayout(base);
  const isHidden = base.hidden.includes(propertyId);
  return toViewLayout({
    ...base,
    hidden: isHidden
      ? base.hidden.filter((id) => id !== propertyId)
      : [...base.hidden, propertyId],
  });
}

/**
 * Reset a layout's sizing/order back to the schema defaults: `order` becomes the
 * schema order and every `widths` entry is the property's `DEFAULT_WIDTH_BY_TYPE`
 * value.
 *
 * A reset is about column size and order, not curation, so the user's `pinned`
 * and `hidden` choices are preserved — minus any ids no longer in the schema.
 * Immutable: the input is never touched.
 */
export function resetLayout(
  layout: ViewColumnLayout,
  options: ResolveLayoutOptions,
): ViewColumnLayout {
  const base = normalizeViewLayout(layout);
  const schema = viewSchemaIds(options?.properties);
  const schemaSet = new Set(schema);

  const widths: Record<string, number> = {};
  for (const property of options?.properties ?? []) {
    const id = property?.id;
    if (typeof id === "string" && id !== "" && !(id in widths)) {
      widths[id] = defaultWidthForType(property.type);
    }
  }

  return toViewLayout({
    order: schema,
    widths,
    pinned: base.pinned.filter((id) => schemaSet.has(id)),
    hidden: base.hidden.filter((id) => schemaSet.has(id)),
  });
}

/**
 * Validate a layout against the schema: ids that no longer exist anywhere
 * (`unknownIds`) and ids repeated in `order` (`duplicateIds`). `valid` is true
 * only when both lists are empty. Duplicates are read from the raw `order`
 * before normalisation, so a malformed saved order is still reported.
 */
export function validateLayout(
  layout: ViewColumnLayout,
  options: ResolveLayoutOptions,
): LayoutValidation {
  const base = normalizeViewLayout(layout);
  const schemaSet = new Set(viewSchemaIds(options?.properties));

  const referenced = new Set<string>([
    ...base.order,
    ...Object.keys(base.widths),
    ...base.pinned,
    ...base.hidden,
  ]);
  for (const id of rawViewIds(isPlainRecord(layout) ? layout.order : undefined)) {
    referenced.add(id);
  }

  const unknownIds = [...referenced].filter((id) => !schemaSet.has(id)).sort();

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of rawViewIds(isPlainRecord(layout) ? layout.order : undefined)) {
    if (seen.has(id)) duplicates.add(id);
    else seen.add(id);
  }

  return {
    valid: unknownIds.length === 0 && duplicates.size === 0,
    unknownIds,
    duplicateIds: [...duplicates].sort(),
  };
}

/**
 * A short, human-readable summary of a layout for menus/tooltips: the visible
 * columns in saved order, then `pinned:`/`hidden:` notes. `propertyName` maps
 * an id to a display label (defaults to the id itself).
 */
export function describeLayout(
  layout: ViewColumnLayout,
  options: DescribeLayoutOptions = {},
): string {
  const base = normalizeViewLayout(layout);
  if (base.order.length === 0) return "No columns";

  const nameOf = (id: string): string => {
    const resolved = options.propertyName?.(id);
    return typeof resolved === "string" && resolved !== "" ? resolved : id;
  };

  const hidden = new Set(base.hidden);
  const visible = base.order.filter((id) => !hidden.has(id));
  const summary = visible.length === 0 ? "No visible columns" : visible.map(nameOf).join(", ");

  const notes: string[] = [];
  if (base.pinned.length > 0) notes.push(`pinned: ${base.pinned.map(nameOf).join(", ")}`);
  if (base.hidden.length > 0) notes.push(`hidden: ${base.hidden.map(nameOf).join(", ")}`);

  return notes.length === 0 ? summary : `${summary} (${notes.join("; ")})`;
}
