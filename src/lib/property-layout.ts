/**
 * Two-column page property layout
 * (docs/MISSING_FEATURES.md §1 "Two-column page property layout").
 *
 * A page's properties can be laid out in two side-by-side columns instead of a
 * single stacked list. A `PropertyLayout` remembers just enough to render that:
 * an ordered list of columns, each an ordered list of property ids. This module
 * is the pure model behind the panel — parse a saved layout, balance it across
 * two columns, drag a property between columns, and serialise it back — with no
 * DB, routes, or React.
 *
 * Fail-safe by design (same contract as `@/lib/column-layout`): the layout
 * round-trips through the DB as untrusted JSON, so `parsePropertyLayout`
 * normalises rather than trusts its input and every mutator is immutable —
 * inputs are never mutated and their arrays are never aliased, so callers can
 * hold the previous layout in React state while the next one is computed.
 */

/**
 * The persisted property layout for one page: ordered columns, each holding
 * ordered property ids. A two-column layout is the common case, but the shape
 * stays a general list of columns so a saved layout with a stray third column
 * still parses rather than throwing.
 */
export type PropertyLayout = {
  columns: string[][];
};

/** One problem `validateLayout` can report. */
export type LayoutIssue =
  | { code: "duplicate"; propertyId: string }
  | { code: "unknown"; propertyId: string; columnIndex: number }
  | { code: "empty"; columnIndex: number };

/** Result of `validateLayout`: whether the layout is clean and what is wrong. */
export type LayoutValidation = {
  valid: boolean;
  issues: LayoutIssue[];
};

/** A fresh, empty layout — the value every failure path degrades to. */
export function emptyLayout(): PropertyLayout {
  return { columns: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Non-empty, unique string ids from a raw list, preserving first-seen order. */
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

/**
 * Structural normalisation: coerce anything into a layout of string-array
 * columns. Non-array columns become empty columns; non-string and blank
 * entries inside a column are dropped. Duplicates are *kept* — cleaning them is
 * `parsePropertyLayout`'s job, while `validateLayout` needs to still see them.
 */
function normalizeLayout(input: unknown): PropertyLayout {
  const source = isRecord(input) ? input : {};
  const rawColumns = Array.isArray(source.columns) ? source.columns : [];
  const columns = rawColumns.map((column) =>
    Array.isArray(column)
      ? column.filter((id): id is string => typeof id === "string" && id !== "")
      : [],
  );
  return { columns };
}

/**
 * Parse a persisted layout, tolerating anything.
 *
 * Unparseable text, `null`/`undefined`, JSON that is not an object, or an
 * object with malformed fields all resolve to a normalised layout — never a
 * throw. Property ids not in `knownIds` are dropped (deleted properties), and
 * an id that appears more than once is kept only at its first position.
 */
export function parsePropertyLayout(
  raw: unknown,
  knownIds: readonly string[],
): PropertyLayout {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return emptyLayout();
    }
  }

  const valid = new Set(uniqueIds(knownIds));
  const seen = new Set<string>();
  const source = normalizeLayout(parsed);
  const columns = source.columns.map((column) => {
    const ids: string[] = [];
    for (const id of column) {
      if (!valid.has(id) || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  });
  return { columns };
}

/**
 * Split `propertyIds` into two balanced columns, first column first.
 *
 * The left column takes the extra item when the count is odd, so a single
 * property lands on the left and an empty list yields two empty columns.
 * Duplicates and blank ids are dropped before splitting; the input is never
 * mutated.
 */
export function balanceLayout(propertyIds: readonly string[]): PropertyLayout {
  const ids = uniqueIds(propertyIds);
  const leftSize = Math.ceil(ids.length / 2);
  return { columns: [ids.slice(0, leftSize), ids.slice(leftSize)] };
}

/**
 * Move `propertyId` into `columnIndex`, at `index` within that column
 * (appended when omitted or past the end).
 *
 * The property is removed from whichever column holds it first, so a move can
 * never duplicate it. Unknown properties and out-of-range column indexes are
 * no-ops that return a fresh copy. Immutable: the input is never mutated and
 * its arrays are never aliased.
 */
export function moveToColumn(
  layout: PropertyLayout,
  propertyId: string,
  columnIndex: number,
  index?: number,
): PropertyLayout {
  const base = normalizeLayout(layout);
  const columns = base.columns.map((column) => [...column]);

  const present = columns.some((column) => column.includes(propertyId));
  if (
    !present ||
    !Number.isInteger(columnIndex) ||
    columnIndex < 0 ||
    columnIndex >= columns.length
  ) {
    return { columns };
  }

  for (const column of columns) {
    const at = column.indexOf(propertyId);
    if (at !== -1) column.splice(at, 1);
  }

  const target = columns[columnIndex];
  const position =
    typeof index === "number" && Number.isFinite(index)
      ? Math.min(Math.max(Math.trunc(index), 0), target.length)
      : target.length;
  target.splice(position, 0, propertyId);

  return { columns };
}

/**
 * Flatten the layout to a single property-id list: columns left-to-right, each
 * column top-to-bottom. `balanceLayout` and `flattenLayout` are inverses for a
 * balanced two-column layout.
 */
export function flattenLayout(layout: PropertyLayout): string[] {
  const ids: string[] = [];
  for (const column of normalizeLayout(layout).columns) {
    ids.push(...column);
  }
  return ids;
}

/**
 * Check a layout against the schema's `knownIds`, reporting every problem:
 * a property listed more than once anywhere, an id the schema does not know,
 * and any empty column. A layout with no columns at all is valid-but-empty
 * (nothing configured yet).
 */
export function validateLayout(
  layout: PropertyLayout,
  knownIds: readonly string[],
): LayoutValidation {
  const valid = new Set(uniqueIds(knownIds));
  const source = normalizeLayout(layout);
  const issues: LayoutIssue[] = [];
  const counts = new Map<string, number>();

  source.columns.forEach((column, columnIndex) => {
    if (column.length === 0) {
      issues.push({ code: "empty", columnIndex });
    }
    for (const propertyId of column) {
      counts.set(propertyId, (counts.get(propertyId) ?? 0) + 1);
      if (!valid.has(propertyId)) {
        issues.push({ code: "unknown", propertyId, columnIndex });
      }
    }
  });

  for (const [propertyId, count] of counts) {
    if (count > 1) issues.push({ code: "duplicate", propertyId });
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Serialise a layout to canonical JSON. Normalises first, so the text always
 * reflects the well-formed shape `parsePropertyLayout` would read back —
 * `parsePropertyLayout(serializeLayout(x), ids)` round-trips.
 */
export function serializeLayout(layout: PropertyLayout): string {
  return JSON.stringify(normalizeLayout(layout));
}
