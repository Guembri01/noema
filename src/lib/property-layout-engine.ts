/**
 * Two-column page property layout engine
 * (docs/MISSING_FEATURES.md §1 "Two-column page property layout").
 *
 * A page's properties can be laid out in one or two side-by-side columns. This
 * module is the pure model behind that panel: parse a saved layout, resolve it
 * into per-property grid placements, drag a property to a new position, toggle
 * between one and two columns, mark a property full-width, validate a saved
 * layout against the page schema, and pick the columns to render for a given
 * viewport bucket.
 *
 * The persisted `PropertyLayout` is deliberately small — a column count, a flat
 * `order` of property ids, and a `spans` map for the full-width exceptions —
 * rather than the array-of-columns shape of the older `@/lib/property-layout`
 * model. Keeping `order` flat means a row-major resolver can own placement, so a
 * full-width (`span: 2`) property takes a row without the caller tracking column
 * boundaries, and collapsing to one column is just a field flip that never
 * loses the order.
 *
 * Fail-safe by design (same contract as `@/lib/column-layout`): the layout
 * round-trips through the DB as untrusted JSON, so `parsePropertyLayout` and
 * every mutator normalise rather than trust their input, and a malformed saved
 * layout degrades to an empty one instead of throwing. Mutators are immutable:
 * they never touch the input and never alias its arrays/objects, so callers can
 * hold the previous layout in React state while the next one is computed.
 */

/** How many columns a page lays its properties out in. */
export type ColumnCount = 1 | 2;

/** How many columns a single property occupies when rendered. */
export type PropertySpan = 1 | 2;

/**
 * The persisted property layout for one page.
 *
 * - `columns` is the requested column count (`1` or `2`).
 * - `order` lists property ids top-to-bottom, left-to-right; ids absent from it
 *   are appended in schema order by `resolveLayout`.
 * - `spans` maps a property id → `2` for a full-width property; a missing entry
 *   means the default span of `1` (so only `2` is ever stored).
 * - `dividers` draws a rule between the columns when `true`.
 */
export type PropertyLayout = {
  columns: ColumnCount;
  order: string[];
  spans?: Record<string, PropertySpan>;
  dividers?: boolean;
};

/** Minimal property descriptor needed to resolve/validate ids and names. */
export type LayoutProperty = {
  id: string;
  name?: string;
};

/** Options carrying the page's current schema (property list). */
export type LayoutSchemaOptions = {
  properties: readonly LayoutProperty[];
};

/** Options for `describeLayout`; `propertyName` maps an id to a display label. */
export type DescribeLayoutOptions = {
  propertyName?: (propertyId: string) => string;
};

/**
 * One property as the grid should render it, after schema resolution.
 *
 * `column` and `row` are 0-based; a `span` of `2` occupies the whole row, so its
 * `column` is always `0`.
 */
export type PropertyPlacement = {
  propertyId: string;
  column: number;
  span: PropertySpan;
  row: number;
};

/** One problem `validateLayout` can report. */
export type LayoutIssue =
  | { code: "unknown"; propertyId: string }
  | { code: "duplicate"; propertyId: string }
  | { code: "invalid-span"; propertyId: string }
  | { code: "invalid-columns" };

/** Result of `validateLayout`: whether the layout is clean and what is wrong. */
export type LayoutValidation = {
  valid: boolean;
  issues: LayoutIssue[];
};

/** Viewport buckets `responsivePlan` understands, narrowest first. */
export type WidthBucket = "narrow" | "medium" | "wide";

/**
 * Usable pixel width of each bucket. Only `narrow` falls below the two-column
 * minimum (`2 * LAYOUT_MIN_COLUMN_WIDTH`), so it is the bucket that collapses.
 */
export const BUCKET_AVAILABLE_WIDTH: Readonly<Record<WidthBucket, number>> = {
  narrow: 320,
  medium: 560,
  wide: 960,
};

/** Narrowest a rendered column may be before the layout collapses to one. */
export const LAYOUT_MIN_COLUMN_WIDTH = 180;

/** Total width two columns need before they may sit side by side. */
export const TWO_COLUMN_MIN_WIDTH = LAYOUT_MIN_COLUMN_WIDTH * 2;

/** Options for `responsivePlan`. */
export type ResponsivePlanOptions = {
  /** Coarse viewport bucket to plan for. */
  widthBucket: WidthBucket;
  /** Explicit usable width, overriding the bucket default (for tests/host sizing). */
  availableWidth?: number;
  /** Explicit minimum column width, overriding `LAYOUT_MIN_COLUMN_WIDTH`. */
  minColumnWidth?: number;
};

/** The columns to render for a viewport bucket, after collapsing. */
export type ResponsivePlan = {
  /** Bucket this plan was computed for. */
  widthBucket: WidthBucket;
  /** Usable pixel width the plan assumed. */
  availableWidth: number;
  /** Effective column count to render (may be collapsed to `1`). */
  columns: ColumnCount;
  /** `true` when a two-column layout is being shown as one. */
  collapsed: boolean;
  /** Pixel width each rendered column gets. */
  columnWidth: number;
  /** Property order to render (unchanged by collapsing). */
  order: string[];
};

/** Internal shape with every field canonical and present. */
type NormalizedPropertyLayout = {
  columns: ColumnCount;
  order: string[];
  spans: Record<string, PropertySpan>;
  dividers: boolean;
};

/** True for a plain object (not an array, not null). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Dedupe string ids, dropping blanks and non-strings, preserving first-seen order. */
function uniqueIds(values: readonly unknown[]): string[] {
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

/** Valid property ids in schema order (deduped, blanks/non-strings dropped). */
function schemaIds(properties: readonly LayoutProperty[] | undefined): string[] {
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

/** Canonicalise an untrusted layout. */
function normalizePropertyLayout(input: unknown): NormalizedPropertyLayout {
  const source = isPlainRecord(input) ? input : {};

  const columns: ColumnCount = source.columns === 2 ? 2 : 1;
  const order = uniqueIds(Array.isArray(source.order) ? source.order : []);
  const inOrder = new Set(order);

  // Only a full-width (`2`) span for an ordered property is stored, so a `1` is
  // the absence of an entry rather than a redundant one.
  const spans: Record<string, PropertySpan> = {};
  if (isPlainRecord(source.spans)) {
    for (const [id, value] of Object.entries(source.spans)) {
      if (value === 2 && inOrder.has(id)) spans[id] = 2;
    }
  }

  return { columns, order, spans, dividers: source.dividers === true };
}

/** Materialise a fresh, public `PropertyLayout` from a normalised one. */
function toPropertyLayout(layout: NormalizedPropertyLayout): PropertyLayout {
  return {
    columns: layout.columns,
    order: [...layout.order],
    spans: { ...layout.spans },
    dividers: layout.dividers,
  };
}

/** A fresh, empty one-column layout — the value every failure path degrades to. */
export function emptyPropertyLayout(): PropertyLayout {
  return toPropertyLayout({
    columns: 1,
    order: [],
    spans: {},
    dividers: false,
  });
}

/**
 * Parse a persisted layout, tolerating anything.
 *
 * Unparseable text, `null`/`undefined`, JSON that is not an object, or an object
 * with malformed fields all resolve to a normalised layout — never a throw. A
 * draft object may also be passed directly (e.g. a fixture). Ids are de-duped
 * (first occurrence wins), blanks/non-strings dropped, spans kept only as a
 * full-width `2` on an ordered property, and `dividers` coerced to a boolean.
 */
export function parsePropertyLayout(raw: unknown): PropertyLayout {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return emptyPropertyLayout();
    }
  }
  return toPropertyLayout(normalizePropertyLayout(parsed));
}

/**
 * Resolve a saved `layout` against the page schema into per-property grid
 * placements.
 *
 * The saved order wins: ids it lists come first in that order (unknown ids are
 * dropped), then ids the schema gained are appended in schema order. Placement
 * is row-major across the layout's columns, left cell before right; a property
 * with a full-width (`span: 2`) entry — only honoured in a two-column layout —
 * takes a whole row, advancing to the next row when the current one is already
 * half-filled so its leftover cell stays empty. Never mutates its input.
 */
export function resolveLayout(
  layout: PropertyLayout,
  options: LayoutSchemaOptions,
): PropertyPlacement[] {
  const base = normalizePropertyLayout(layout);
  const schema = schemaIds(options?.properties);
  const schemaSet = new Set(schema);

  const order: string[] = [];
  const taken = new Set<string>();
  for (const id of base.order) {
    if (schemaSet.has(id) && !taken.has(id)) {
      taken.add(id);
      order.push(id);
    }
  }
  for (const id of schema) {
    if (!taken.has(id)) {
      taken.add(id);
      order.push(id);
    }
  }

  if (base.columns === 1) {
    return order.map((propertyId, row) => ({ propertyId, column: 0, span: 1 as const, row }));
  }

  const placements: PropertyPlacement[] = [];
  let row = 0;
  let column = 0;
  for (const propertyId of order) {
    const span: PropertySpan = base.spans[propertyId] === 2 ? 2 : 1;
    if (span === 2) {
      if (column !== 0) {
        row += 1;
        column = 0;
      }
      placements.push({ propertyId, column: 0, span: 2, row });
      row += 1;
    } else {
      placements.push({ propertyId, column, span: 1, row });
      if (column === 0) {
        column = 1;
      } else {
        column = 0;
        row += 1;
      }
    }
  }
  return placements;
}

/**
 * Return a copy of `layout` whose `order` contains every property in the schema
 * exactly once: the saved order first (unknown ids dropped), then ids the schema
 * gained appended in schema order. This is the layout a layout editor shows, so
 * its reorder controls can reach properties the saved layout never listed.
 *
 * Placement is unchanged for one column; for two columns it is the row-major
 * order `resolveLayout` would produce. Immutable: the input is never mutated.
 */
export function orderLayout(
  layout: PropertyLayout,
  options: LayoutSchemaOptions,
): PropertyLayout {
  const base = normalizePropertyLayout(layout);
  const schema = schemaIds(options?.properties);
  const schemaSet = new Set(schema);
  const order: string[] = [];
  const taken = new Set<string>();

  for (const id of base.order) {
    if (schemaSet.has(id) && !taken.has(id)) {
      taken.add(id);
      order.push(id);
    }
  }
  for (const id of schema) {
    if (!taken.has(id)) {
      taken.add(id);
      order.push(id);
    }
  }

  return toPropertyLayout({ ...base, order });
}

/**
 * Move `propertyId` to `index` in the saved order (index clamped into range).
 *
 * Immutable: returns a new layout. An unknown id is a no-op, and a non-finite
 * index pins the property to the end.
 */
export function moveProperty(
  layout: PropertyLayout,
  propertyId: string,
  index: number,
): PropertyLayout {
  const base = normalizePropertyLayout(layout);
  if (typeof propertyId !== "string" || propertyId === "") return toPropertyLayout(base);

  const from = base.order.indexOf(propertyId);
  if (from === -1) return toPropertyLayout(base);

  const order = [...base.order];
  order.splice(from, 1);
  const target = Number.isFinite(index)
    ? Math.min(Math.max(Math.trunc(index), 0), order.length)
    : order.length;
  order.splice(target, 0, propertyId);
  return toPropertyLayout({ ...base, order });
}

/**
 * Flip between one and two columns. Collapsing two → one keeps the `order` (and
 * the spans, so expanding restores them) — placement simply re-flows. Immutable:
 * returns a new layout.
 */
export function toggleColumns(layout: PropertyLayout): PropertyLayout {
  const base = normalizePropertyLayout(layout);
  return toPropertyLayout({ ...base, columns: base.columns === 2 ? 1 : 2 });
}

/**
 * Set a property's span to `1` (default) or `2` (full width).
 *
 * Immutable: returns a new layout with a new `spans` map. A blank id, an id not
 * in the layout, or a span other than `1`/`2` is a no-op. Setting `1` removes the
 * entry, since only a full-width `2` is ever stored.
 */
export function setSpan(
  layout: PropertyLayout,
  propertyId: string,
  span: PropertySpan,
): PropertyLayout {
  const base = normalizePropertyLayout(layout);
  if (typeof propertyId !== "string" || propertyId === "" || !base.order.includes(propertyId)) {
    return toPropertyLayout(base);
  }

  const spans = { ...base.spans };
  if (span === 2) {
    spans[propertyId] = 2;
  } else if (span === 1) {
    delete spans[propertyId];
  } else {
    return toPropertyLayout(base);
  }
  return toPropertyLayout({ ...base, spans });
}

/** Non-empty string ids in raw order, keeping repeats (for duplicate detection). */
function rawOrderIds(layout: unknown): string[] {
  const source = isPlainRecord(layout) ? layout.order : undefined;
  if (!Array.isArray(source)) return [];
  return source.filter((value): value is string => typeof value === "string" && value !== "");
}

/** Raw `spans` entries, so callers can still see values normalisation would drop. */
function rawSpanEntries(layout: unknown): [string, unknown][] {
  const source = isPlainRecord(layout) ? layout.spans : undefined;
  return isPlainRecord(source) ? Object.entries(source) : [];
}

/**
 * Validate a layout against the page schema, reporting every problem it finds:
 * ids the schema does not know, ids repeated in the raw `order`, spans whose raw
 * value is not `1`/`2`, and a raw `columns` that is neither `1` nor `2`.
 *
 * Duplicates and invalid spans are read from the raw layout (before
 * normalisation drops them), so a malformed saved layout is still reported.
 * `valid` is true only when there are no issues.
 */
export function validateLayout(
  layout: PropertyLayout,
  options: LayoutSchemaOptions,
): LayoutValidation {
  const base = normalizePropertyLayout(layout);
  const schemaSet = new Set(schemaIds(options?.properties));
  const issues: LayoutIssue[] = [];

  const rawColumns = isPlainRecord(layout) ? layout.columns : undefined;
  if (rawColumns !== undefined && rawColumns !== 1 && rawColumns !== 2) {
    issues.push({ code: "invalid-columns" });
  }

  const referenced = new Set<string>([...base.order, ...Object.keys(base.spans)]);
  for (const [id] of rawSpanEntries(layout)) referenced.add(id);
  for (const propertyId of [...referenced].sort()) {
    if (!schemaSet.has(propertyId)) issues.push({ code: "unknown", propertyId });
  }

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const propertyId of rawOrderIds(layout)) {
    if (seen.has(propertyId)) duplicates.add(propertyId);
    else seen.add(propertyId);
  }
  for (const propertyId of [...duplicates].sort()) {
    issues.push({ code: "duplicate", propertyId });
  }

  for (const [propertyId, value] of rawSpanEntries(layout).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (value !== 1 && value !== 2) issues.push({ code: "invalid-span", propertyId });
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Plan the columns to render for a viewport bucket.
 *
 * A one-column layout is never expanded. A two-column layout collapses to one
 * when the usable width cannot honour the minimum column width — either because
 * the bucket is too narrow (the default `narrow`, 320px, is below
 * `TWO_COLUMN_MIN_WIDTH`, 360px) or because an explicit `availableWidth` is too
 * tight. `order` is preserved, so collapsing never loses the layout.
 */
export function responsivePlan(
  layout: PropertyLayout,
  options: ResponsivePlanOptions,
): ResponsivePlan {
  const base = normalizePropertyLayout(layout);
  const requested = options?.widthBucket;
  const widthBucket: WidthBucket =
    requested === "medium" || requested === "wide" ? requested : "narrow";

  const min =
    typeof options?.minColumnWidth === "number" && Number.isFinite(options.minColumnWidth)
      ? Math.max(0, Math.trunc(options.minColumnWidth))
      : LAYOUT_MIN_COLUMN_WIDTH;

  const availableWidth =
    typeof options?.availableWidth === "number" && Number.isFinite(options.availableWidth)
      ? Math.max(0, Math.trunc(options.availableWidth))
      : BUCKET_AVAILABLE_WIDTH[widthBucket];

  let columns: ColumnCount = base.columns;
  if (columns === 2 && availableWidth < min * 2) columns = 1;

  return {
    widthBucket,
    availableWidth,
    columns,
    collapsed: base.columns === 2 && columns === 1,
    columnWidth: columns === 2 ? Math.floor(availableWidth / 2) : availableWidth,
    order: [...base.order],
  };
}

/**
 * A short, human-readable summary of a layout for menus/tooltips: the column
 * count and the property order, then `full-width:`/`dividers` notes.
 * `propertyName` maps an id to a display label (defaults to the id itself).
 */
export function describeLayout(
  layout: PropertyLayout,
  options: DescribeLayoutOptions = {},
): string {
  const base = normalizePropertyLayout(layout);
  if (base.order.length === 0) return "No properties";

  const nameOf = (id: string): string => {
    const resolved = options.propertyName?.(id);
    return typeof resolved === "string" && resolved !== "" ? resolved : id;
  };

  const label = base.columns === 1 ? "1 column" : "2 columns";
  const summary = `${label}: ${base.order.map(nameOf).join(", ")}`;

  const notes: string[] = [];
  const spanned = base.order.filter((id) => base.spans[id] === 2).map(nameOf);
  if (spanned.length > 0) notes.push(`full-width: ${spanned.join(", ")}`);
  if (base.dividers) notes.push("dividers");

  return notes.length === 0 ? summary : `${summary} (${notes.join("; ")})`;
}
