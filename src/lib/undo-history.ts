/**
 * The pure mapping between the global undo stack and its visible history
 * surface (the topbar history popover).
 *
 * The menu is not a second history: every row is derived from the engine's
 * `HistoryEntry[]`, newest first, and only local entries get an action. Remote
 * entries are listed for context but are deliberately inert — the app cannot
 * revert a collaborator's step, so it must not offer to.
 */

import type { HistoryEntry } from "./undo-redo";

/** One row of the history popover. */
export type UndoHistoryRow = HistoryEntry & {
  /** `"undo"` for an applied local step, `"redo"` for an undone one. */
  action: "undo" | "redo" | null;
  /** Compact age ("now", "12s", "3m", "2h", "4d"), or `null` without a clock. */
  age: string | null;
};

/**
 * A compact, locale-neutral age label. `at` is the caller-supplied command
 * instant and `now` the render clock, so the function is deterministic in
 * tests. A future/missing instant is treated as "now" rather than a negative
 * duration.
 */
export function formatUndoAge(
  at: number | undefined,
  now: number,
  justNow = "now",
): string | null {
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  const elapsed = Math.max(0, now - at);
  if (elapsed < 5_000) return justNow;
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

/**
 * Map the stack's entries to menu rows, newest first. An applied **local**
 * entry can be undone (down to that row); an undone local entry can be redone.
 * Remote entries stay visible but carry no action, as do skipped ones — those
 * are the collaborator steps a local undo already walked past.
 */
export function undoHistoryRows(
  entries: readonly HistoryEntry[],
  now: number,
  justNow = "now",
): UndoHistoryRow[] {
  return [...entries]
    .reverse()
    .map((entry) => ({
      ...entry,
      action: entry.remote ? null : entry.applied ? "undo" : "redo",
      age: formatUndoAge(entry.at, now, justNow),
    }));
}
