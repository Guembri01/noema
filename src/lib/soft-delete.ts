/**
 * Soft-delete / trash lifecycle engine — the pure rules behind moving a record
 * into the trash, keeping it recoverable for a window, and finally purging it
 * (FEATURE_MATRIX §17 "Soft delete", §9 trash rows, §10 "Trash retention";
 * spec R30.15).
 *
 * Nothing here touches the database, React or the clock: `now` is always an
 * argument and every function is data-in / data-out, so the retention boundary
 * is testable to the millisecond. The module is deliberately small and
 * composable:
 *
 * - {@link softDeletePatch} / {@link restorePatch} build the field patches the
 *   server writes (`deletedAt`, `deletedById`).
 * - {@link daysUntilPurge} / {@link isPurgeable} / {@link purgeCandidates}
 *   implement the recovery window. Like the rest of the repo's retention knobs
 *   a non-positive window disables purging entirely (0 ⇒ keep everything), and
 *   the boundary is *strict*: an item deleted exactly `retentionDays` ago is
 *   still recoverable.
 * - {@link restoreConflicts} detects name/path collisions at restore time.
 * - {@link listTrash} / {@link describeTrashAge} are the read helpers for the
 *   trash view.
 */

/** Milliseconds in one day. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Milliseconds in one minute / hour / (30-day) month / (365-day) year. */
const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_MONTH = 30 * MS_PER_DAY;
const MS_PER_YEAR = 365 * MS_PER_DAY;

/** Default recovery window: trash is kept this many days before it may purge. */
export const TRASH_RETENTION_DAYS = 30;

/** Retention policy plus the instant the decision is made. */
export type TrashPolicy = {
  /** Days trash is kept before it becomes purgeable. Non-positive ⇒ never. */
  retentionDays: number;
  /** The comparison instant. */
  now: Date;
};

/** The minimal shape of anything that can be soft-deleted. */
export type SoftDeleteRecord = {
  deletedAt: Date | null;
  deletedById: string | null;
};

/** The acting user and the instant of a soft delete. */
export type SoftDeleteInput = {
  userId: string;
  now: Date;
};

/** The fields {@link softDeletePatch} writes: a stamp and the acting user. */
export type SoftDeletePatch = {
  deletedAt: Date;
  deletedById: string;
};

/** The fields {@link restorePatch} writes: both trash markers cleared. */
export type RestorePatch = {
  deletedAt: null;
  deletedById: null;
};

/** A record with just enough shape to answer "is it in the trash?". */
type TrashStamped = {
  deletedAt?: Date | null;
};

/** Epoch ms of a record's delete stamp, or `0` when it is not trashed. */
function deletedAtTime(record: TrashStamped): number {
  return record.deletedAt ? record.deletedAt.getTime() : 0;
}

/**
 * The field patch that trashes a record: `deletedAt` is set to a copy of `now`
 * (so later mutation of the caller's `Date` cannot rewrite the stamp) and
 * `deletedById` records who did it.
 */
export function softDeletePatch(input: SoftDeleteInput): SoftDeletePatch {
  return { deletedAt: new Date(input.now.getTime()), deletedById: input.userId };
}

/**
 * The field patch that restores a record: both trash markers are cleared. Two
 * distinct nulls (rather than `undefined`) so a caller can hand the result
 * straight to a Prisma update without dropping the columns from the `SET`.
 */
export function restorePatch(): RestorePatch {
  return { deletedAt: null, deletedById: null };
}

/** Whether a record currently sits in the trash. Missing stamps count as live. */
export function isDeleted(record: TrashStamped): boolean {
  return (record.deletedAt ?? null) !== null;
}

/**
 * Whole days remaining until a trashed record may be purged, rounded up, or
 * `null` when it can never purge.
 *
 * - A just-deleted item reports the full window (30 by default).
 * - Exactly at the boundary it reports `0` but is still recoverable — purging is
 *   strict (`isPurgeable` is false there).
 * - Overdue items report a negative count (whole days past due).
 * - A live record, or a non-positive window (purging disabled), reports `null`.
 */
export function daysUntilPurge(record: TrashStamped, policy: TrashPolicy): number | null {
  const deletedAt = record.deletedAt;
  if (!deletedAt) return null;
  if (!(policy.retentionDays > 0)) return null;
  const elapsed = policy.now.getTime() - deletedAt.getTime();
  const remaining = policy.retentionDays * MS_PER_DAY - elapsed;
  const days = Math.ceil(remaining / MS_PER_DAY);
  // `Math.ceil` can yield -0 for an item barely overdue; normalise it to 0.
  return days === 0 ? 0 : days;
}

/**
 * Whether a record has outlived the recovery window and may be hard-deleted.
 *
 * Strictly past the window: an item deleted exactly `retentionDays` ago is still
 * recoverable (only `deletedAt < now - window` purges). A live record or a
 * non-positive window is never purgeable, so a misconfigured workspace keeps its
 * trash instead of losing everything.
 */
export function isPurgeable(record: TrashStamped, policy: TrashPolicy): boolean {
  const deletedAt = record.deletedAt;
  if (!deletedAt) return false;
  if (!(policy.retentionDays > 0)) return false;
  return policy.now.getTime() - deletedAt.getTime() > policy.retentionDays * MS_PER_DAY;
}

/**
 * The trashed records eligible for permanent purge as of `policy.now`, oldest
 * deletion first (the order an "empty trash" sweep should destroy in, children
 * before the parents that point at them).
 *
 * Returns the caller's own references. The input array and its order are never
 * mutated (the filter allocates a fresh array before sorting).
 */
export function purgeCandidates<T extends TrashStamped>(
  records: ReadonlyArray<T>,
  policy: TrashPolicy,
): T[] {
  return records
    .filter((record) => isPurgeable(record, policy))
    .sort((a, b) => deletedAtTime(a) - deletedAtTime(b));
}

/** Which identity field a restore would collide on. */
export type RestoreConflictKind = "title" | "path";

/** One collision detected while restoring a trashed record. */
export type RestoreConflict = {
  /** The colliding field. */
  kind: RestoreConflictKind;
  /** Id of the live record that already owns the value. */
  existingId: string;
  /** The live record's value, un-normalised (safe to show in a prompt). */
  value: string;
};

/**
 * A record that has a human name. `name` and `title` are both accepted because
 * pages call it `title` while databases call it `name`.
 */
type Named = {
  name?: string;
  title?: string;
};

/**
 * A record whose name and path can be compared.
 */
export type Conflictable = {
  id: string;
  name?: string;
  title?: string;
  path?: string;
  parentId?: string | null;
  deletedAt?: Date | null;
};

/** Normalise an identity value for comparison: trim, lowercase, blank ⇒ "". */
function normalizeKey(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** A record's display name, preferring a non-blank `name` over `title`. */
function displayName(record: Named): string {
  const name = typeof record.name === "string" ? record.name : "";
  if (name.trim()) return name;
  return typeof record.title === "string" ? record.title : "";
}

/**
 * The collisions a restore would hit if `record` were put back next to
 * `existing`, in the order the live records are supplied (a title conflict is
 * reported before a path conflict for the same record).
 *
 * - **Title**: a live *sibling* (same `parentId`, blank compared as the root)
 *   with the same name, compared case-insensitively and trimmed.
 * - **Path**: a live record with the same path anywhere in the tree.
 *
 * `record` itself (`existing.id === record.id`) and anything still in the trash
 * are ignored, and an empty name or path never collides.
 */
export function restoreConflicts(
  record: Conflictable,
  existing: ReadonlyArray<Conflictable>,
): RestoreConflict[] {
  const conflicts: RestoreConflict[] = [];
  const name = normalizeKey(displayName(record));
  const path = normalizeKey(record.path);
  const parent = normalizeKey(record.parentId);

  for (const candidate of existing) {
    if (candidate.id === record.id) continue;
    if (isDeleted(candidate)) continue;

    if (name && normalizeKey(displayName(candidate)) === name) {
      if (normalizeKey(candidate.parentId) === parent) {
        conflicts.push({ kind: "title", existingId: candidate.id, value: displayName(candidate) });
      }
    }

    if (path && normalizeKey(candidate.path) === path) {
      conflicts.push({ kind: "path", existingId: candidate.id, value: candidate.path ?? "" });
    }
  }

  return conflicts;
}

/** How {@link listTrash} orders the trash list. */
export type TrashSort = "deleted-desc" | "deleted-asc" | "name-asc" | "name-desc";

/** Options for {@link listTrash}. */
export type ListTrashOptions = {
  /** Defaults to `"deleted-desc"` (most recently deleted first). */
  sort?: TrashSort;
};

/** Compare by display name, ascending, case-insensitively; ties keep input order. */
function compareName(a: Named, b: Named): number {
  const left = normalizeKey(displayName(a));
  const right = normalizeKey(displayName(b));
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * The trashed records ready for a "Trash" view, filtered to deleted records and
 * ordered by `options.sort` (default `"deleted-desc"`, newest deletion first).
 * The sort is stable, so records that compare equal keep their input order.
 * Returns a fresh array; the input is never mutated.
 */
export function listTrash<
  T extends TrashStamped & { name?: string; title?: string },
>(records: ReadonlyArray<T>, options: ListTrashOptions = {}): T[] {
  const sort = options.sort ?? "deleted-desc";
  return records.filter((record) => isDeleted(record)).sort((a, b) => {
    switch (sort) {
      case "deleted-asc":
        return deletedAtTime(a) - deletedAtTime(b);
      case "name-asc":
        return compareName(a, b);
      case "name-desc":
        return compareName(b, a);
      case "deleted-desc":
      default:
        return deletedAtTime(b) - deletedAtTime(a);
    }
  });
}

/** Render a count and unit with a trailing "ago", pluralising the unit. */
function ago(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/**
 * A short, human "how long has this been in the trash" label for a trashed
 * record, or `null` when the record is live.
 *
 * Buckets, measured from `now`: under a minute is `"just now"`, then minutes,
 * hours, days, 30-day months and 365-day years, each rounded down and
 * pluralised. A future stamp (clock skew) is clamped to `"just now"`.
 */
export function describeTrashAge(record: TrashStamped, now: Date): string | null {
  const deletedAt = record.deletedAt;
  if (!deletedAt) return null;
  const delta = now.getTime() - deletedAt.getTime();
  if (delta < MS_PER_MINUTE) return "just now";
  if (delta < MS_PER_HOUR) return ago(Math.floor(delta / MS_PER_MINUTE), "minute");
  if (delta < MS_PER_DAY) return ago(Math.floor(delta / MS_PER_HOUR), "hour");
  if (delta < MS_PER_MONTH) return ago(Math.floor(delta / MS_PER_DAY), "day");
  if (delta < MS_PER_YEAR) return ago(Math.floor(delta / MS_PER_MONTH), "month");
  return ago(Math.floor(delta / MS_PER_YEAR), "year");
}
