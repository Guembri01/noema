/**
 * Pure planning for bulk row actions in the global undo stack.
 *
 * A bulk action is still **one** undo step: the user picked N rows, but the
 * history should say "Archive 4 tickets" and one Ctrl+Z should put all four
 * back. These helpers keep that planning out of the React components so the
 * inverse is provable without a DOM or a database:
 *
 *  - {@link planBulkChanges} drops rows that would not actually change and
 *    orders the remaining patches (forward for redo, reversed for undo).
 *  - {@link bulkPatchCommand} turns such a plan into one engine command whose
 *    effects apply each row's patch through the caller's server writer.
 *  - {@link bulkEffectCommand} wraps an action that is naturally bulk (archive
 *    / restore) without pretending it has per-row patches.
 *
 * No action here is invented: a caller that cannot invert an operation (for
 * example a permanent delete) simply does not record a command.
 */

import type { Command } from "./undo-redo";

/** A row whose value changes from `before` to `after`. */
export type BulkRowChange<P extends Record<string, unknown>> = {
  rowId: string;
  before: P;
  after: P;
};

/** A planned bulk edit over the rows that really change. */
export type BulkChangePlan<P extends Record<string, unknown>> = {
  label: string;
  /** Only rows whose patch differs, in input order. */
  changes: BulkRowChange<P>[];
  /** The same rows reversed: the order an undo must apply them in. */
  undo: BulkRowChange<P>[];
  /** The input order: the order a redo must apply them in. */
  redo: BulkRowChange<P>[];
};

/** Stable stringify so two equal patches compare equal regardless of key order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

/** Whether two patches are byte-equivalent for undo purposes. */
export function sameBulkPatch(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  return canonical(a) === canonical(b);
}

/**
 * Build the plan for a bulk edit. Rows whose `before` equals `after` are
 * dropped, so a "set status to the same value" click does not create a history
 * entry that cannot do anything. The undo order is the reverse of the redo
 * order, which matters when a later row's write could affect an earlier one.
 */
export function planBulkChanges<P extends Record<string, unknown>>(
  label: string,
  changes: readonly BulkRowChange<P>[],
): BulkChangePlan<P> {
  const effective = changes.filter((change) => !sameBulkPatch(change.before, change.after));
  return {
    label,
    changes: effective,
    undo: [...effective].reverse(),
    redo: effective,
  };
}

/** Whether a plan would record nothing. */
export function isEmptyBulkPlan<P extends Record<string, unknown>>(
  plan: BulkChangePlan<P>,
): boolean {
  return plan.changes.length === 0;
}

/**
 * Turn a planned bulk edit into one engine command. `apply` is the caller's
 * per-row server writer (it receives the row id and the patch for that row);
 * the command applies `before` in reverse on undo and `after` forward on redo.
 * Returns `null` when the plan has no effective rows — there is nothing honest
 * to advertise in history.
 */
export function bulkPatchCommand<S, P extends Record<string, unknown>>(
  plan: BulkChangePlan<P>,
  apply: (rowId: string, patch: P) => void | Promise<void>,
  options: { at?: number; id?: string; coalesceKey?: string } = {},
): Command<S> | null {
  if (isEmptyBulkPlan(plan)) return null;
  return {
    id:
      options.id ??
      `bulk:${plan.label}:${plan.changes.map((change) => change.rowId).join("|")}`,
    label: plan.label,
    apply: (state) => state,
    invert: (state) => state,
    at: options.at,
    coalesceKey: options.coalesceKey,
    onUndo: async () => {
      for (const change of plan.undo) await apply(change.rowId, change.before);
    },
    onRedo: async () => {
      for (const change of plan.redo) await apply(change.rowId, change.after);
    },
  };
}

/** Options for {@link bulkEffectCommand}. */
export type BulkEffectOptions<S> = {
  label: string;
  rowIds: readonly string[];
  /** Reverse the whole operation (archive → restore, delete → restore, …). */
  undo: (rowIds: readonly string[]) => void | Promise<void>;
  /** Re-apply the whole operation after an undo. */
  redo: (rowIds: readonly string[]) => void | Promise<void>;
  /** Caller-supplied instant, shown as the action's time in history. */
  at?: number;
  id?: string;
  /** Optional state transform; the global stack is identity-by-default. */
  apply?: (state: S) => S;
  invert?: (state: S) => S;
};

/**
 * One command for a bulk action that is already a single server call (archive
 * or restore by ids). It captures a copy of the selection so later edits to
 * the caller's array cannot change what history will undo.
 */
export function bulkEffectCommand<S>(options: BulkEffectOptions<S>): Command<S> {
  const ids = [...options.rowIds];
  return {
    id:
      options.id ??
      `bulk:${options.label}:${ids.join("|")}`,
    label: options.label,
    apply: options.apply ?? ((state) => state),
    invert: options.invert ?? ((state) => state),
    at: options.at,
    onUndo: () => options.undo(ids),
    onRedo: () => options.redo(ids),
  };
}
