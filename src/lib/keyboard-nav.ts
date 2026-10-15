/**
 * H2 — keyboard navigation index math.
 *
 * Every list-like surface (command palette, board columns, toolbar, table of
 * contents) has to answer the same question: *given the cursor I am on, which
 * row should the next key highlight?* This module is the pure arithmetic behind
 * that, split into the four moves the UI needs and nothing else:
 *
 *  - {@link nextIndex} — ArrowDown/ArrowUp stepping plus the Home/End jumps,
 *    with wrap-around (the roving `aria-activedescendant` model).
 *  - {@link rovingTabIndex} — the single index a toolbar exposes as
 *    `tabIndex=0`, everything else `-1`.
 *  - {@link typeaheadIndex} — the first item whose label starts with a typed
 *    prefix, scanning forward and wrapping so repeated letters cycle.
 *  - {@link pageStepIndex} — the PageUp/PageDown jump of one screenful.
 *
 * All four are pure and deterministic: the cursor and collection size go in,
 * an in-range index (or `-1` when the collection is empty) comes out. Nothing
 * is mutated, so a caller can drop them straight into a key handler or a
 * `useMemo` without worrying about referential surprises.
 */

/** The keys {@link nextIndex} understands. */
export type NavKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/** A single `nextIndex` request: the pressed key, the list size, and wrap. */
export type NavOptions = {
  /** Which navigation key was pressed. */
  key: NavKey;
  /** Number of rows in the list. `<= 0` means "nothing to navigate". */
  count: number;
  /** Wrap around at the ends (default `true`). */
  wrap?: boolean;
};

/** The keys {@link pageStepIndex} understands. */
export type PageStepKey = "PageDown" | "PageUp";

/** A single {@link pageStepIndex} request. */
export type PageStepOptions = {
  /** Which paging key was pressed. */
  key: PageStepKey;
  /** Number of rows. `<= 0` means "nothing to navigate". */
  count: number;
  /** Rows to jump; defaults to {@link DEFAULT_PAGE_STEP}. Non-positive → default. */
  step?: number;
};

/** Rows a PageUp/PageDown moves when the caller does not pass a `step`. */
export const DEFAULT_PAGE_STEP = 10;

/** Coerce a count to a finite, non-negative integer; anything odd becomes 0. */
function normalizeCount(count: number): number {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return 0;
  return Math.floor(count);
}

/** Pin `index` into `[0, count - 1]`, flooring fractions and defaulting `NaN` to 0. */
function clampIndex(index: number, count: number): number {
  const safe = typeof index === "number" && Number.isFinite(index) ? Math.floor(index) : 0;
  if (safe < 0) return 0;
  if (safe > count - 1) return count - 1;
  return safe;
}

/**
 * The row to highlight after a navigation key.
 *
 * ArrowDown/ArrowUp step one row and, by default, wrap at the ends; pass
 * `{ wrap: false }` to clamp instead. Home/End jump to the first/last row. An
 * out-of-range cursor is pinned into the list before stepping, a one-row list
 * always stays on row 0, and an empty list yields `-1` (no active row).
 */
export function nextIndex(current: number, options: NavOptions): number {
  const count = normalizeCount(options.count);
  if (count === 0) return -1;

  if (options.key === "Home") return 0;
  if (options.key === "End") return count - 1;

  const index = clampIndex(current, count);
  if (options.key === "ArrowDown") {
    if (index + 1 < count) return index + 1;
    return options.wrap === false ? index : 0;
  }
  if (index > 0) return index - 1;
  return options.wrap === false ? index : count - 1;
}

/**
 * The index a roving-tabindex widget marks as `tabIndex=0` (all others `-1`).
 *
 * The requested `current` is clamped into `[0, count - 1]`, so a stale cursor
 * after a list shrinks never falls off the end. An empty list has no focusable
 * item and yields `-1`.
 */
export function rovingTabIndex(current: number, count: number): number {
  const size = normalizeCount(count);
  if (size === 0) return -1;
  return clampIndex(current, size);
}

/**
 * The next item whose label starts with `prefix`, searching forward from the
 * row after `from` and wrapping around the end — so pressing the same letter
 * again cycles through the matches (the standard listbox typeahead).
 *
 * Matching is case-insensitive and prefix-only. Pass `from = -1` (the usual
 * "nothing selected yet") to start at the top. Returns `-1` when the list is
 * empty, the prefix is blank, or nothing matches; the input array is never
 * mutated.
 */
export function typeaheadIndex(
  items: readonly string[],
  prefix: string,
  from = -1,
): number {
  const count = items.length;
  if (count === 0) return -1;

  const needle = (prefix ?? "").trim().toLowerCase();
  if (needle === "") return -1;

  const cursor = typeof from === "number" && Number.isFinite(from) ? Math.floor(from) : -1;
  const start = cursor < 0 ? 0 : (clampIndex(cursor, count) + 1) % count;
  for (let offset = 0; offset < count; offset += 1) {
    const position = (start + offset) % count;
    if (items[position].toLowerCase().startsWith(needle)) return position;
  }
  return -1;
}

/**
 * The row one screenful away, for PageUp/PageDown. `step` rows are added (or
 * subtracted) and the result is clamped to the ends rather than wrapped, which
 * is how a paged list is expected to behave. A missing or non-positive `step`
 * falls back to {@link DEFAULT_PAGE_STEP}. The cursor is clamped first, a
 * one-row list stays on row 0, and an empty list yields `-1`.
 */
export function pageStepIndex(current: number, options: PageStepOptions): number {
  const count = normalizeCount(options.count);
  if (count === 0) return -1;

  const requested = options.step;
  const step =
    typeof requested === "number" && Number.isFinite(requested) && requested > 0
      ? Math.floor(requested)
      : DEFAULT_PAGE_STEP;

  const index = clampIndex(current, count);
  const target = options.key === "PageDown" ? index + step : index - step;
  if (target < 0) return 0;
  if (target > count - 1) return count - 1;
  return target;
}
