/**
 * App-wide undo/redo engine (docs/FEATURE_MATRIX.md §16 "Undo/redo (global)",
 * MISSING_FEATURES gap #13). This is the *global* history — the commands a
 * workspace performs outside the editor's own ProseMirror history (rename a
 * page, move a row, change a property, run a bulk action) — so the editor
 * steps in `undo-stack.ts` stay untouched and this module can sit alongside it.
 *
 * ## The model
 *
 * A {@link Command} is an invertible patch: `apply` moves a state forward,
 * `invert` moves it back. The engine never invents state — it stores the
 * present `state` and an ordered list of {@link UndoEntry} records, and asks
 * the commands to transform the state on each push/undo/redo. Because state is
 * threaded through the stack, a caller does not have to keep a parallel store
 * in sync.
 *
 * An entry is one of four things, and the flags are what make collaborative
 * undo honest:
 *
 *  - **applied** — `undone === false`; its command is folded into `state`.
 *  - **undone** — `undone === true`; it is on the redo side and **not** folded
 *    into `state`. Undone entries form a suffix over the non-remote entries,
 *    so `redo` always re-applies the oldest undone command.
 *  - **remote** — applied by a collaborator through {@link mergeRemote}; it is
 *    part of the shared state but outside the local undo scope. A local `undo`
 *    **skips and marks** it (`skipped === true`) rather than reverting someone
 *    else's work, then reverts the newest local command beneath it.
 *  - **skipped** — a remote entry a local undo already walked past. Recorded so
 *    the history view can explain why the step was not taken.
 *
 * ## Purity
 *
 * Every function is pure: it returns a fresh stack, never mutates the one it is
 * given and never aliases its arrays. No clock is read — the caller supplies
 * `at` on a command when a coalesce window is used, so a run of edits is
 * reproducible. `push` after an `undo` truncates the redo branch, and a stack
 * of depth `limit` drops the oldest entries once it overflows.
 *
 * ## Why not re-use `undo-stack.ts`
 *
 * `undo-stack.ts` records whole *states* and is specialised for the editor's
 * local history. A global stack needs commands (to label, coalesce, group and
 * merge) and a state it threads itself, which is a different shape; the two
 * coexist deliberately.
 */

/** History depth used when `createUndoStack` is given no (or an invalid) limit. */
export const DEFAULT_UNDO_LIMIT = 100;

/** Coalesce window (ms) used when a stack is given no (or an invalid) window. */
export const DEFAULT_COALESCE_WINDOW_MS = 500;

/**
 * An invertible, labelable patch.
 *
 * `apply(state)` returns the state with the command's effect; `invert(state)`
 * returns the state without it. A command that carries a non-empty
 * `coalesceKey` may merge with an adjacent command that shares it, and one that
 * carries a non-empty `groupKey` is grouped with adjacent commands that share
 * it. `at` is the (caller-supplied) instant a coalesce window is measured from;
 * it is not a wall clock and defaults to `0`.
 *
 * `apply`/`invert` are trusted to be local patches on independent parts of the
 * state (the collaborative undo of one field does not have to reproduce a
 * conflicting edit made by someone else). Full intent preservation across
 * conflicting remote edits is out of scope for a pure engine.
 */
export type Command<S> = {
  /** Stable identity, unique within a stack. */
  id: string;
  /** Human-readable history label ("Move row", "Type", …). */
  label: string;
  /** Forward transform. */
  apply(state: S): S;
  /** Backward transform; `invert(apply(s))` is expected to equal `s`. */
  invert(state: S): S;
  /** Commands pushed adjacently with the same non-empty key group together. */
  groupKey?: string;
  /** Adjacent commands with the same non-empty key may coalesce in time. */
  coalesceKey?: string;
  /** Caller-supplied instant used for coalescing; defaults to `0`. */
  at?: number;
  /** Optional server effect run once after this command is undone. */
  onUndo?: () => void | Promise<void>;
  /** Optional server effect run once after this command is redone. */
  onRedo?: () => void | Promise<void>;
};

/** One recorded command plus the flags that make it undoable or not. */
export type UndoEntry<S> = {
  /** The (possibly compound) command this entry undoes. */
  readonly command: Command<S>;
  /** Authored by a collaborator; outside the local undo scope. */
  readonly remote: boolean;
  /** Inverted and waiting on the redo side. */
  readonly undone: boolean;
  /** Walked past by a local undo because it is remote. */
  readonly skipped: boolean;
};

/** An immutable global undo/redo history over states of `S`. */
export type UndoStack<S> = {
  /** Normalized history depth (always an integer ≥ 1). */
  readonly limit: number;
  /** Normalized coalesce window in milliseconds (always ≥ 0). */
  readonly coalesceWindowMs: number;
  /** The present state: every applied entry folded in, oldest first. */
  readonly state: S;
  /** Ordered records, oldest first. */
  readonly entries: readonly UndoEntry<S>[];
  /** Instant of the most recent push, or `null` when coalescing is broken. */
  readonly lastAt: number | null;
  /** Coalesce key of the most recent push, or `null` when none. */
  readonly lastCoalesceKey: string | null;
};

/** Config accepted by {@link createUndoStack}. */
export type UndoStackConfig<S> = {
  /** Maximum number of entries; the oldest are dropped past this. */
  limit?: number;
  /** Maximum gap (ms) between two pushes that may coalesce. */
  coalesceWindowMs?: number;
  /**
   * The state the stack starts from. Omitting it leaves a fresh stack at
   * `undefined`; callers that omit it are expected to make their first command
   * a full-state `apply`.
   */
  state?: S;
};

/** A history view: the ordered entries plus the present cursor. */
export type HistoryView = {
  /** One row per entry, oldest first. */
  entries: HistoryEntry[];
  /** Number of applied entries; `entries[0..cursor)` are applied. */
  cursor: number;
  /** Total number of entries (applied and undone). */
  total: number;
};

/** A rendered history row. */
export type HistoryEntry = {
  id: string;
  label: string;
  /** Position in the ordered history. */
  index: number;
  /** Whether the row is folded into the present state. */
  applied: boolean;
  /** Whether a collaborator authored it. */
  remote: boolean;
  /** Whether a local undo skipped it. */
  skipped: boolean;
  groupKey?: string;
  coalesceKey?: string;
  at?: number;
};

/** A usable history depth: a finite number floored to an integer ≥ 1. */
function normalizeLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_UNDO_LIMIT;
  return Math.max(1, Math.floor(limit));
}

/** A usable coalesce window: a finite number floored to an integer ≥ 0. */
function normalizeWindow(windowMs: number | undefined): number {
  if (typeof windowMs !== "number" || !Number.isFinite(windowMs)) return DEFAULT_COALESCE_WINDOW_MS;
  return Math.max(0, Math.floor(windowMs));
}

/** A usable key: a non-empty string, else `null`. */
function normalizeKey(key: string | undefined): string | null {
  return typeof key === "string" && key.length > 0 ? key : null;
}

/** A usable instant: a finite number, else `0`. */
function normalizeAt(at: number | undefined): number {
  return typeof at === "number" && Number.isFinite(at) ? at : 0;
}

/** Whether an instant is inside the coalesce window since the last push. */
function withinWindow(windowMs: number, lastAt: number | null, at: number): boolean {
  if (lastAt === null) return false;
  const elapsed = at - lastAt;
  return elapsed >= 0 && elapsed <= windowMs;
}

/**
 * Build a compound command from `children`, in order. `apply` folds the
 * children left-to-right; `invert` folds them right-to-left, so the compound is
 * the inverse of the run.
 */
function composeCommand<S>(
  id: string,
  label: string,
  children: readonly Command<S>[],
  meta: { groupKey?: string; coalesceKey?: string; at?: number },
): Command<S> {
  const hasUndo = children.some((child) => child.onUndo !== undefined);
  const hasRedo = children.some((child) => child.onRedo !== undefined);
  return {
    id,
    label,
    apply: (state) => children.reduce((accumulator, child) => child.apply(accumulator), state),
    invert: (state) =>
      [...children].reverse().reduce((accumulator, child) => child.invert(accumulator), state),
    groupKey: meta.groupKey,
    coalesceKey: meta.coalesceKey,
    at: meta.at,
    ...(hasUndo
      ? {
          onUndo: async () => {
            for (const child of [...children].reverse()) await child.onUndo?.();
          },
        }
      : {}),
    ...(hasRedo
      ? {
          onRedo: async () => {
            for (const child of children) await child.onRedo?.();
          },
        }
      : {}),
  };
}

/** Whether `command` may merge into the entry before it. */
function canMerge<S>(
  stack: UndoStack<S>,
  previous: UndoEntry<S>,
  command: Command<S>,
  at: number,
): boolean {
  if (previous.remote) return false;
  const coalesceKey = normalizeKey(command.coalesceKey);
  if (
    coalesceKey !== null &&
    coalesceKey === stack.lastCoalesceKey &&
    withinWindow(stack.coalesceWindowMs, stack.lastAt, at)
  ) {
    return true;
  }
  const groupKey = normalizeKey(command.groupKey);
  return groupKey !== null && groupKey === normalizeKey(previous.command.groupKey);
}

/** Fold `command` into `previous` as one undo step. */
function mergeEntries<S>(previous: UndoEntry<S>, command: Command<S>, at: number): UndoEntry<S> {
  return {
    command: composeCommand<S>(previous.command.id, previous.command.label, [previous.command, command], {
      groupKey: previous.command.groupKey ?? command.groupKey,
      coalesceKey: previous.command.coalesceKey ?? command.coalesceKey,
      at,
    }),
    remote: false,
    undone: false,
    skipped: false,
  };
}

/** A copy of `stack` with a fresh entry array, used by the no-op transitions. */
function snapshot<S>(stack: UndoStack<S>): UndoStack<S> {
  return { ...stack, entries: [...stack.entries] };
}

/** A fresh empty stack, starting at `config.state`. */
export function createUndoStack<S>(config: UndoStackConfig<S> = {}): UndoStack<S> {
  return {
    limit: normalizeLimit(config.limit),
    coalesceWindowMs: normalizeWindow(config.coalesceWindowMs),
    state: config.state as S,
    entries: [],
    lastAt: null,
    lastCoalesceKey: null,
  };
}

/**
 * Record `command` as the newest edit: apply it, drop any redo branch, and
 * merge it into the previous entry when the coalesce/group rules allow. Pushing
 * past `limit` drops the oldest entries. Always returns a fresh stack.
 */
export function push<S>(stack: UndoStack<S>, command: Command<S>): UndoStack<S> {
  const at = normalizeAt(command.at);
  const applied = stack.entries.filter((entry) => !entry.undone);
  const state = command.apply(stack.state);
  const previous = applied[applied.length - 1];
  const merged =
    previous !== undefined && canMerge(stack, previous, command, at)
      ? mergeEntries(previous, command, at)
      : null;

  let entries: UndoEntry<S>[];
  if (merged !== null) {
    entries = [...applied.slice(0, -1), merged];
  } else {
    entries = [...applied, { command, remote: false, undone: false, skipped: false }];
  }
  if (entries.length > stack.limit) {
    entries = entries.slice(entries.length - stack.limit);
  }

  return {
    ...stack,
    entries,
    state,
    lastAt: at,
    lastCoalesceKey: normalizeKey(command.coalesceKey),
  };
}

/**
 * Invert the newest local command. Remote entries passed on the way are marked
 * `skipped` (collaborative skip-and-mark) rather than reverted. A no-op when no
 * local command is applied. Resets the coalesce link so an edit made after
 * undoing never merges with the pre-undo run.
 */
export function undo<S>(stack: UndoStack<S>): UndoStack<S> {
  let target = -1;
  for (let index = stack.entries.length - 1; index >= 0; index -= 1) {
    const entry = stack.entries[index];
    if (!entry.remote && !entry.undone) {
      target = index;
      break;
    }
  }
  if (target === -1) return snapshot(stack);

  const state = stack.entries[target].command.invert(stack.state);
  const entries = stack.entries.map((entry, index) => {
    if (index === target) return { ...entry, undone: true };
    if (index > target && entry.remote && !entry.skipped) return { ...entry, skipped: true };
    return entry;
  });

  return { ...stack, entries, state, lastAt: null, lastCoalesceKey: null };
}

/**
 * Re-apply the oldest undone command. A no-op when the redo branch is empty.
 * Resets the coalesce link (see {@link undo}).
 */
export function redo<S>(stack: UndoStack<S>): UndoStack<S> {
  let target = -1;
  for (let index = 0; index < stack.entries.length; index += 1) {
    const entry = stack.entries[index];
    if (!entry.remote && entry.undone) {
      target = index;
      break;
    }
  }
  if (target === -1) return snapshot(stack);

  const state = stack.entries[target].command.apply(stack.state);
  const entries = stack.entries.map((entry, index) =>
    index === target ? { ...entry, undone: false } : entry,
  );

  return { ...stack, entries, state, lastAt: null, lastCoalesceKey: null };
}

/**
 * Fold `command` into history as a collaborator's edit. It is applied to the
 * shared state and recorded as `remote`, so a later local `undo` skips and
 * marks it instead of reverting someone else's work. Truncates the redo branch
 * and honours `limit`, but never coalesces or groups with local commands.
 */
export function mergeRemote<S>(stack: UndoStack<S>, command: Command<S>): UndoStack<S> {
  const applied = stack.entries.filter((entry) => !entry.undone);
  const state = command.apply(stack.state);
  let entries: UndoEntry<S>[] = [
    ...applied,
    { command, remote: true, undone: false, skipped: false },
  ];
  if (entries.length > stack.limit) {
    entries = entries.slice(entries.length - stack.limit);
  }
  return { ...stack, entries, state, lastAt: null, lastCoalesceKey: null };
}

/**
 * Build a single compound command from `commands`, undone and redone as one
 * step. Its deterministic id is derived from the label and the children's ids,
 * so the same group is byte-stable across renders and tests.
 */
export function group<S>(label: string, commands: readonly Command<S>[]): Command<S> {
  const children = [...commands];
  return composeCommand<S>(
    `group:${label}:${children.map((child) => child.id).join("|")}`,
    label,
    children,
    { groupKey: label },
  );
}

/** The command the next local `undo` would invert, or `null`. */
export function nextUndoCommand<S>(stack: UndoStack<S>): Command<S> | null {
  for (let index = stack.entries.length - 1; index >= 0; index -= 1) {
    const entry = stack.entries[index];
    if (!entry.remote && !entry.undone) return entry.command;
  }
  return null;
}

/** The command the next local `redo` would re-apply, or `null`. */
export function nextRedoCommand<S>(stack: UndoStack<S>): Command<S> | null {
  for (const entry of stack.entries) {
    if (!entry.remote && entry.undone) return entry.command;
  }
  return null;
}

/** Whether a local command can be undone. */
export function canUndo<S>(stack: UndoStack<S>): boolean {
  return stack.entries.some((entry) => !entry.remote && !entry.undone);
}

/** Whether an undone local command can be redone. */
export function canRedo<S>(stack: UndoStack<S>): boolean {
  return stack.entries.some((entry) => !entry.remote && entry.undone);
}

/** An empty history over the same present state, limit and coalesce window. */
export function clear<S>(stack: UndoStack<S>): UndoStack<S> {
  return { ...stack, entries: [], lastAt: null, lastCoalesceKey: null };
}

/**
 * The ordered history for a menu: every entry (applied and undone) oldest
 * first, with its label and flags, plus the cursor — the number of applied
 * entries, so `entries[0..cursor)` are applied.
 */
export function historyView<S>(stack: UndoStack<S>): HistoryView {
  const entries = stack.entries.map((entry, index) => ({
    id: entry.command.id,
    label: entry.command.label,
    index,
    applied: !entry.undone,
    remote: entry.remote,
    skipped: entry.skipped,
    groupKey: entry.command.groupKey,
    coalesceKey: entry.command.coalesceKey,
    at: entry.command.at,
  }));
  const cursor = entries.reduce((count, entry) => (entry.applied ? count + 1 : count), 0);
  return { entries, cursor, total: entries.length };
}
