/**
 * List item operations — the pure text-editing kernel behind bulleted /
 * numbered / to-do list manipulation (indent, outdent, Enter → split,
 * Backspace-at-start → merge with previous, and a structural repair pass).
 *
 * The model is a FLAT ordered array of `{ id, level, text }`; nesting is
 * encoded by `level` (0 = top level, a child sits one level below its parent).
 * Nothing here touches the DOM, ProseMirror, routes or the database: it is pure
 * data in / data out, usable from the editor and from unit tests alike.
 *
 * Immutability: none of these functions mutate the caller's array or items.
 * Every operation that changes something returns a fresh array of fresh items;
 * a request that cannot change anything (unknown id, bound reached, nothing to
 * merge, already-normalized input) returns the exact input reference, so
 * callers can cheaply skip re-renders. `normalizeLevels` is idempotent.
 *
 * Determinism: identical input yields identical output. `splitItem` mints the
 * second item's id from the source id (`<id>:split`, then `-2`, `-3`, …) rather
 * than from a clock or random source, so results are reproducible.
 *
 * LEVEL RULES (deliberate, pinned by list-ops.test.ts):
 *  - Levels are integers clamped to `0..maxLevel` (default {@link DEFAULT_MAX_LEVEL});
 *    out-of-range or non-finite levels are repaired to the nearest bound.
 *  - `indentItem` / `outdentItem` move an item one level and no-op at the
 *    bounds; they never touch another item.
 *  - `normalizeLevels` enforces structure: the first item is the root (level 0)
 *    and no item may jump more than +1 deeper than the previous one, so a
 *    malformed level run is clamped back into a well-formed outline.
 */

/** A list item: a stable id, its nesting level and its plain text. */
export interface ListItem {
  /** Stable item id. */
  id: string;
  /** Nesting depth, 0 = top level. */
  level: number;
  /** Plain text content. */
  text: string;
}

/** Optional tuning shared by the level-aware operations. */
export interface ListOpsOptions {
  /** Deepest nesting level allowed (default {@link DEFAULT_MAX_LEVEL}). */
  maxLevel?: number;
}

/** Deepest nesting level applied when `options.maxLevel` is omitted. */
export const DEFAULT_MAX_LEVEL = 8;

/** Resolve the effective level cap from options, tolerating junk values. */
function maxLevelOf(options: ListOpsOptions | undefined): number {
  const raw = options?.maxLevel;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, Math.trunc(raw));
  }
  return DEFAULT_MAX_LEVEL;
}

/** Truncate to an integer and clamp into `0..max`; non-finite input floor to 0. */
function clampLevel(value: number, max: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(max, n));
}

/** Truncate to an integer and clamp into `0..length`; non-finite input floor to 0. */
function clampOffset(value: number, length: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(length, n));
}

/** Deterministic fresh id for the tail half of a split, guaranteed unique. */
function mintSplitId<T extends ListItem>(items: readonly T[], base: string): string {
  const taken = new Set(items.map((row) => row.id));
  const stem = `${base}:split`;
  if (!taken.has(stem)) return stem;
  let n = 2;
  while (taken.has(`${stem}-${n}`)) n += 1;
  return `${stem}-${n}`;
}

/**
 * Indent `id` one level deeper. Clamped to `options.maxLevel`; a no-op (same
 * reference) when the id is unknown or already at the cap.
 */
export function indentItem<T extends ListItem>(
  items: readonly T[],
  id: string,
  options: ListOpsOptions = {},
): T[] {
  const max = maxLevelOf(options);
  const index = items.findIndex((row) => row.id === id);
  if (index === -1) return items as T[];
  const item = items[index];
  const level = Math.min(max, clampLevel(item.level, max) + 1);
  if (level === item.level) return items as T[];
  const next = items.slice();
  next[index] = { ...item, level };
  return next;
}

/**
 * Outdent `id` one level shallower. Clamped to 0; a no-op (same reference) when
 * the id is unknown or already at the top level.
 */
export function outdentItem<T extends ListItem>(
  items: readonly T[],
  id: string,
  options: ListOpsOptions = {},
): T[] {
  const max = maxLevelOf(options);
  const index = items.findIndex((row) => row.id === id);
  if (index === -1) return items as T[];
  const item = items[index];
  const level = Math.max(0, clampLevel(item.level, max) - 1);
  if (level === item.level) return items as T[];
  const next = items.slice();
  next[index] = { ...item, level };
  return next;
}

/**
 * Split `id`'s text at `atOffset` (Enter in the middle of a list item). The
 * prefix keeps the id, level and extra fields; a fresh item with the remaining
 * text is inserted immediately after. `atOffset` is truncated and clamped to
 * `0..text.length`, so an offset at either end still yields a valid (possibly
 * empty) half. A no-op (same reference) for an unknown id only.
 */
export function splitItem<T extends ListItem>(
  items: readonly T[],
  id: string,
  atOffset: number,
): T[] {
  const index = items.findIndex((row) => row.id === id);
  if (index === -1) return items as T[];
  const item = items[index];
  const text = String(item.text ?? "");
  const offset = clampOffset(atOffset, text.length);
  const next = items.slice();
  next[index] = { ...item, text: text.slice(0, offset) };
  next.splice(index + 1, 0, {
    ...item,
    id: mintSplitId(items, item.id),
    text: text.slice(offset),
  });
  return next;
}

/**
 * Merge `id` into its immediately preceding list item (Backspace at the start
 * of an item): the previous item keeps its id, level and extra fields and gains
 * `id`'s text, and `id` is removed. A no-op (same reference) for the first item
 * or an unknown id — there is nothing to merge into.
 */
export function mergeWithPrevious<T extends ListItem>(
  items: readonly T[],
  id: string,
): T[] {
  const index = items.findIndex((row) => row.id === id);
  if (index <= 0) return items as T[];
  const previous = items[index - 1];
  const target = items[index];
  const next = items.slice();
  next[index - 1] = {
    ...previous,
    text: `${previous.text ?? ""}${target.text ?? ""}`,
  };
  next.splice(index, 1);
  return next;
}

/**
 * Repair level structure: the first item is the root (level 0) and every later
 * item is clamped to at most one level deeper than the previous one (and into
 * `0..options.maxLevel`). Returns the input reference unchanged when the list is
 * already well-formed, so it is idempotent.
 */
export function normalizeLevels<T extends ListItem>(
  items: readonly T[],
  options: ListOpsOptions = {},
): T[] {
  const max = maxLevelOf(options);
  let changed = false;
  let previous = 0; // an implicit root sits above the first item
  const next = items.map((item, index) => {
    const level =
      index === 0 ? 0 : Math.min(clampLevel(item.level, max), previous + 1);
    previous = level;
    if (level === item.level) return item;
    changed = true;
    return { ...item, level };
  });
  return changed ? next : (items as T[]);
}
