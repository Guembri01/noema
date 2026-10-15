/**
 * Bounded undo/redo stack (F8) — the pure, immutable history an editor's
 * undo/redo commands are driven from.
 *
 * History is a small state machine before it is a UI concern: an array of
 * recorded states plus a redo trail. Keeping it as a value (rather than a
 * mutable class) makes every transition provable without React or a store — the
 * same shape `row-order.ts` and `version-history.ts` use for their helpers.
 *
 * The `UndoStack<T>` value holds:
 *
 *  - `entries` — recorded states, oldest first. The **last** entry is the
 *    current (present) state; `peek` returns it.
 *  - `future` — states that were undone, most recently undone first. `redo`
 *    consumes the front of this array.
 *  - `lastKey` / `lastAt` — the coalesce key and timestamp of the most recent
 *    push, used to merge a run of rapid edits into one undo step.
 *
 * Every function is pure: it returns a fresh stack and never mutates (or
 * aliases the arrays of) the stack it was given, and **no clock is read** — the
 * caller supplies `at` when a coalesce window is used, so a sequence of edits
 * is reproducible in tests.
 */

/** History depth used when `createStack` is given no (or an invalid) limit. */
export const DEFAULT_UNDO_LIMIT = 100;

/** Options accepted by `createStack`. */
export type UndoStackConfig = {
  /** Maximum number of recorded states; the oldest are dropped past this. */
  limit?: number;
};

/** Options accepted by `push`, controlling edit coalescing. */
export type UndoPushOptions = {
  /**
   * Merge this push into the previous one when both carry the same non-empty
   * key (a run of keystrokes, a drag, …). An empty/absent key never merges.
   */
  coalesceKey?: string;
  /**
   * Maximum gap, in milliseconds, between two pushes that may coalesce. When
   * omitted, the key alone decides (time is not considered).
   */
  coalesceWindowMs?: number;
  /** Timestamp of this edit, compared against the previous push's timestamp. */
  at?: number;
};

/** An immutable undo/redo history over states of `T`. */
export type UndoStack<T> = {
  /** Normalized history depth (always an integer ≥ 1). */
  readonly limit: number;
  /** Recorded states, oldest first; the last entry is the present state. */
  readonly entries: readonly T[];
  /** Undone states, most recently undone first; `redo` consumes the front. */
  readonly future: readonly T[];
  /** Coalesce key of the last push, or `null` when it cannot merge. */
  readonly lastKey: string | null;
  /** Timestamp of the last push, or `null` before the first push. */
  readonly lastAt: number | null;
};

/** A usable history depth: a finite number floored to an integer ≥ 1. */
function normalizeLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_UNDO_LIMIT;
  return Math.max(1, Math.floor(limit));
}

/** A usable coalesce key: a non-empty string, else `null`. */
function normalizeKey(key: string | undefined): string | null {
  return typeof key === "string" && key.length > 0 ? key : null;
}

/**
 * Whether two pushes may coalesce in time. With no window, the key alone
 * decides; otherwise the previous timestamp must exist and the elapsed time
 * must be non-negative and within the window.
 */
function withinWindow(windowMs: number | undefined, lastAt: number | null, at: number): boolean {
  if (windowMs === undefined) return true;
  if (!Number.isFinite(windowMs) || windowMs < 0) return false;
  if (lastAt === null) return false;
  const elapsed = at - lastAt;
  return elapsed >= 0 && elapsed <= windowMs;
}

/** A fresh empty stack with a normalized `limit`. */
export function createStack<T>({ limit }: UndoStackConfig = {}): UndoStack<T> {
  return {
    limit: normalizeLimit(limit),
    entries: [],
    future: [],
    lastKey: null,
    lastAt: null,
  };
}

/**
 * Record `state` as the new present value.
 *
 * A normal push appends the state and **clears the redo trail** (a new edit
 * invalidates anything that was undone). When `coalesceKey` matches the
 * previous push's key — and the optional `coalesceWindowMs` has not elapsed
 * since then — the push instead replaces the present state, so the whole run
 * undoes as a single step. Pushing past `limit` drops the oldest state.
 *
 * Always returns a fresh stack; the input is never mutated.
 */
export function push<T>(stack: UndoStack<T>, state: T, options: UndoPushOptions = {}): UndoStack<T> {
  const key = normalizeKey(options.coalesceKey);
  const at = typeof options.at === "number" && Number.isFinite(options.at) ? options.at : 0;
  const canCoalesce =
    key !== null &&
    stack.lastKey === key &&
    stack.entries.length > 0 &&
    withinWindow(options.coalesceWindowMs, stack.lastAt, at);

  if (canCoalesce) {
    const entries = [...stack.entries];
    entries[entries.length - 1] = state;
    return { limit: stack.limit, entries, future: stack.future, lastKey: key, lastAt: at };
  }

  let entries = [...stack.entries, state];
  if (entries.length > stack.limit) entries = entries.slice(entries.length - stack.limit);
  return { limit: stack.limit, entries, future: [], lastKey: key, lastAt: at };
}

/** The present state, or `undefined` before the first push. */
export function peek<T>(stack: UndoStack<T>): T | undefined {
  return stack.entries.length > 0 ? stack.entries[stack.entries.length - 1] : undefined;
}

/** Whether there is a recorded state to walk back to. */
export function canUndo<T>(stack: UndoStack<T>): boolean {
  return stack.entries.length > 1;
}

/** Whether there is an undone state to walk forward to. */
export function canRedo<T>(stack: UndoStack<T>): boolean {
  return stack.future.length > 0;
}

/**
 * Step back to the previous state, pushing the present onto the redo trail. A
 * no-op at the bottom of the history. Either way the coalesce link is reset, so
 * an edit made after undoing never merges with the pre-undo run.
 */
export function undo<T>(stack: UndoStack<T>): UndoStack<T> {
  if (stack.entries.length <= 1) {
    return { limit: stack.limit, entries: [...stack.entries], future: [...stack.future], lastKey: null, lastAt: null };
  }
  const present = stack.entries[stack.entries.length - 1];
  const entries = stack.entries.slice(0, -1);
  return {
    limit: stack.limit,
    entries,
    future: [present, ...stack.future],
    lastKey: null,
    lastAt: null,
  };
}

/**
 * Step forward to the most recently undone state. A no-op when the redo trail
 * is empty. Like `undo`, it resets the coalesce link.
 */
export function redo<T>(stack: UndoStack<T>): UndoStack<T> {
  if (stack.future.length === 0) {
    return { limit: stack.limit, entries: [...stack.entries], future: [], lastKey: null, lastAt: null };
  }
  const [next, ...future] = stack.future;
  return {
    limit: stack.limit,
    entries: [...stack.entries, next],
    future,
    lastKey: null,
    lastAt: null,
  };
}

/** An empty stack with the same `limit`, discarding all recorded history. */
export function clear<T>(stack: UndoStack<T>): UndoStack<T> {
  return createStack<T>({ limit: stack.limit });
}
