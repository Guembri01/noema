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
