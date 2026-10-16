import { UNTITLED_LABEL } from "@/lib/breadcrumb";
import {
  TRASH_RETENTION_DAYS,
  daysUntilPurge,
  describeTrashAge,
  isPurgeable,
} from "@/lib/soft-delete";

/**
 * Retention policy shape, declared here (not imported from `@/lib/trash`) so
 * this module stays free of the server-only `@/lib/storage` (node:fs) chain:
 * it is consumed by client components (`trash-list.tsx`).
 */
export type TrashRetentionPolicy = { retentionDays: number };

export const DEFAULT_TRASH_RETENTION_DAYS = TRASH_RETENTION_DAYS;

export const defaultTrashRetentionPolicy: TrashRetentionPolicy = {
  retentionDays: TRASH_RETENTION_DAYS,
};

/**
 * Trash view model — the pure rules behind the "Trash / recently deleted"
 * screen and its Restore / Delete-forever actions (MISSING_FEATURES §9 rows
 * "Trash / recently deleted", "Restore from trash", "Permanent delete";
 * FEATURE_MATRIX `:422,:423,:424`).
 *
 * The module consumes the soft-deleted record shape the data layer already
 * returns (`src/server/queries.ts#getTrash`: `{ id, title, icon, deletedAt }`
 * plus the `parentId` / `deletedById` markers the soft-delete engine writes)
 * and derives everything the UI needs, without touching the DB, React or the
 * clock — `now` is always an argument, so retention boundaries and nesting are
 * testable to the millisecond.
 *
 * - {@link buildTrashView} flattens the deleted forest into render items,
 *   grouping a deleted descendant directly under its deleted ancestor.
 * - {@link filterTrash} narrows the list by query / deleter / date window.
 * - {@link restoreTargets} + {@link planRestore} expand a selection into the
 *   minimal, ancestor-complete restore plan.
 * - {@link planPermanentDelete} orders a purge children-first and refuses to
 *   drop a still-populated ancestor unless `cascade` is set.
 * - {@link emptyTrash} selects the items that have outlived the window.
 * - {@link describeDeleteImpact} / {@link summarizeTrash} are the counts the
 *   confirmation dialog and the header show.
 */

/** A soft-deleted record as the trash query exposes it. */
export type TrashRecord = {
  id: string;
  title?: string | null;
  icon?: string | null;
  parentId?: string | null;
  deletedAt?: Date | null;
  /** Acting user id, matching `soft-delete.ts`'s `deletedById` field. */
  deletedById?: string | null;
};

/** A record proven to be in the trash (non-null `deletedAt`). */
type DeletedRecord = TrashRecord & { deletedAt: Date };

/** One row of the rendered trash list. */
export type TrashItem = {
  id: string;
  title: string;
  /** Omitted entirely when the record has no icon (keeps `toEqual` clean). */
  icon?: string;
  parentId: string | null;
  deletedAt: Date;
  deletedBy: string | null;
  /** Human "how long ago" label, e.g. `"2 days ago"`. */
  ageLabel: string;
  /** Whole days until the purge window closes, or `null` when purging is off. */
  daysLeft: number | null;
  /** Still inside the recovery window (an expired item may already be purged). */
  restorable: boolean;
  /** True when this item sits under a deleted ancestor in the same list. */
  nested: boolean;
};

/** Retention policy knob for the view; defaults to the workspace default. */
export type TrashViewPolicy = TrashRetentionPolicy;

/** Inputs for {@link buildTrashView}. */
export type BuildTrashViewOptions = {
  now: Date;
  /** Days trash is kept before it expires. Non-positive ⇒ expiry disabled. */
  policy?: TrashViewPolicy;
};

/** Counts shown in the trash header. */
export type TrashCounts = {
  total: number;
  restorable: number;
  expired: number;
  nested: number;
};

/** The view model {@link buildTrashView} returns. */
export type TrashView = {
  items: TrashItem[];
  counts: TrashCounts;
};

/** Epoch ms of a record's delete stamp, or `0` when it is not trashed. */
function deletedAtTime(record: { deletedAt?: Date | null }): number {
  return record.deletedAt ? record.deletedAt.getTime() : 0;
}

/**
 * Newest deletion first, ties broken by id so the order is deterministic.
 * `Array.prototype.sort` is stable, but the explicit id tiebreak means two
 * runs over equal stamps never depend on the caller's input order.
 */
function compareNewestFirst(a: TrashItem, b: TrashItem): number {
  const delta = b.deletedAt.getTime() - a.deletedAt.getTime();
  if (delta !== 0) return delta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A page's display title, falling back to `Untitled` when blank/absent. */
function titleOf(record: TrashRecord): string {
  const title = typeof record.title === "string" ? record.title.trim() : "";
  return title || UNTITLED_LABEL;
}

/**
 * The flat render list: only soft-deleted records, newest deletion first at
 * the top level, each deleted descendant emitted directly beneath its deleted
 * ancestor and flagged `nested`. A child whose parent is not in the list (a
 * live page, a hard-deleted row, a cycle) is treated as a root rather than
 * dropped, so the trash never hides recoverable work.
 *
 * Items are grouped by walking the deleted forest: a node is a root when its
 * `parentId` is `null` or points outside the deleted set. Sibling groups and
 * their children are both ordered newest-first. The input array is never
 * mutated.
 */
export function buildTrashView(
  records: ReadonlyArray<TrashRecord>,
  options: BuildTrashViewOptions,
): TrashView {
  const retentionDays = options.policy?.retentionDays ?? DEFAULT_TRASH_RETENTION_DAYS;
  const policy: TrashViewPolicy = { retentionDays };
  const now = options.now;

  const deleted = records.filter(
    (record): record is DeletedRecord => record.deletedAt != null,
  );
  const byId = new Map(deleted.map((record) => [record.id, record]));

  const children = new Map<string, DeletedRecord[]>();
  const isRoot = new Set<string>();
  for (const record of deleted) {
    const parentId = record.parentId ?? null;
    if (parentId === null || !byId.has(parentId)) {
      isRoot.add(record.id);
      continue;
    }
    const bucket = children.get(parentId) ?? [];
    bucket.push(record);
    children.set(parentId, bucket);
  }

  const toItem = (record: DeletedRecord, nested: boolean): TrashItem => {
    const deletedAt = record.deletedAt;
    const item: TrashItem = {
      id: record.id,
      title: titleOf(record),
      parentId: record.parentId ?? null,
      deletedAt,
      deletedBy: record.deletedById ?? null,
      ageLabel: describeTrashAge({ deletedAt }, now) ?? "",
      daysLeft: daysUntilPurge({ deletedAt }, { retentionDays, now }),
      restorable: !isPurgeable({ deletedAt }, { retentionDays, now }),
      nested,
    };
    const icon = typeof record.icon === "string" ? record.icon.trim() : "";
    if (icon) item.icon = icon;
    return item;
  };

  const items: TrashItem[] = [];
  const visited = new Set<string>();

  const emit = (record: DeletedRecord, nested: boolean): void => {
    if (visited.has(record.id)) return; // parent cycle — never loop
    visited.add(record.id);
    items.push(toItem(record, nested));
    const kids = (children.get(record.id) ?? []).slice().sort((a, b) => {
      const delta = deletedAtTime(b) - deletedAtTime(a);
      return delta !== 0 ? delta : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    for (const kid of kids) emit(kid, true);
  };

  const roots = deleted
    .filter((record) => isRoot.has(record.id))
    .sort((a, b) => deletedAtTime(b) - deletedAtTime(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const root of roots) emit(root, false);

  // Anything unreachable from a root (a parent cycle) is surfaced flat, so no
  // recoverable record is silently hidden.
  for (const record of deleted) {
    if (!visited.has(record.id)) items.push(toItem(record, false));
  }

  return { items, counts: summarizeTrash(items) };
}

/** Options for {@link filterTrash}; every field is optional. */
export type TrashFilter = {
  /** Case-insensitive substring matched against the title. */
  query?: string;
  /** Exact match on the acting user id. */
  deletedBy?: string;
  /** Inclusive lower bound on `deletedAt`. */
  from?: Date;
  /** Inclusive upper bound on `deletedAt`. */
  to?: Date;
};

/**
 * Narrow a trash list: title substring (case-insensitive, trimmed), acting
 * user, and an inclusive `deletedAt` window. Absent / blank criteria are
 * ignored, input order is preserved, and a fresh array is always returned.
 */
export function filterTrash(
  items: ReadonlyArray<TrashItem>,
  filter: TrashFilter = {},
): TrashItem[] {
  const query = typeof filter.query === "string" ? filter.query.trim().toLowerCase() : "";
  const from = filter.from ? filter.from.getTime() : null;
  const to = filter.to ? filter.to.getTime() : null;

  return items.filter((item) => {
    if (query && !item.title.toLowerCase().includes(query)) return false;
    if (filter.deletedBy !== undefined && item.deletedBy !== filter.deletedBy) return false;
    const at = item.deletedAt.getTime();
    if (from !== null && at < from) return false;
    if (to !== null && at > to) return false;
    return true;
  });
}

/** Parent lookup shared by the tree-shaped planners below. */
function parentIndexOf(items: ReadonlyArray<TrashItem>): Map<string, string | null> {
  const parents = new Map<string, string | null>();
  for (const item of items) parents.set(item.id, item.parentId);
  return parents;
}

/**
 * The minimal set of ids to restore for a selection, ordered ancestors-first.
 *
 * Restoring a child implies restoring each of its deleted ancestors, so the
 * closure walks every requested id's parent chain (stopping at a parent that
 * is not itself in the trash — a live page needs no restore) and appends the
 * chain root-first, skipping anything already scheduled. Unknown ids are
 * ignored. The result is deduplicated, so requesting both an ancestor and its
 * descendant yields one op per record.
 */
export function restoreTargets(
  items: ReadonlyArray<TrashItem>,
  ids: ReadonlyArray<string>,
): string[] {
  const parents = parentIndexOf(items);
  const scheduled = new Set<string>();
  const ordered: string[] = [];

  for (const id of ids) {
    if (!parents.has(id)) continue; // not in the trash view
    const chain: string[] = [];
    const guard = new Set<string>();
    let current: string | null = id;
    while (current !== null && parents.has(current) && !guard.has(current)) {
      guard.add(current);
      chain.push(current);
      current = parents.get(current) ?? null;
    }
    chain.reverse();
    for (const target of chain) {
      if (scheduled.has(target)) continue;
      scheduled.add(target);
      ordered.push(target);
    }
  }
  return ordered;
}

/** One restore step: put `id` back under `parentId`. */
export type RestoreOp = {
  id: string;
  /** The record's original parent, or `null` for a top-level page. */
  parentId: string | null;
  /** True when the original parent is not being restored (falls back to root). */
  reparentToRoot: boolean;
};

/** Warnings a restore plan surfaces before it runs. */
export type RestoreWarnings = {
  /** Target ids whose parent is neither in the trash nor being restored. */
  parentMissing: string[];
};

/** An ordered, ancestor-complete restore plan. */
export type RestorePlan = {
  ops: RestoreOp[];
  warnings: RestoreWarnings;
};

/**
 * Turn a selection into the ordered ops a restore action executes. Targets are
 * the {@link restoreTargets} closure, so an ancestor is always restored before
 * its descendants. A target whose parent cannot be recovered (it is not part
 * of the plan) is flagged in `warnings.parentMissing` and marked
 * `reparentToRoot`, matching the product rule that a child restored on its own
 * re-attaches at the top level.
 */
export function planRestore(
  items: ReadonlyArray<TrashItem>,
  ids: ReadonlyArray<string>,
): RestorePlan {
  const parents = parentIndexOf(items);
  const targets = restoreTargets(items, ids);
  const scheduled = new Set(targets);

  const ops: RestoreOp[] = [];
  const parentMissing: string[] = [];
  for (const id of targets) {
    const parentId = parents.get(id) ?? null;
    const missing = parentId !== null && !scheduled.has(parentId);
    if (missing) parentMissing.push(id);
    ops.push({ id, parentId, reparentToRoot: missing });
  }
  return { ops, warnings: { parentMissing } };
}

/** Options for {@link planPermanentDelete}. */
export type PermanentDeleteOptions = {
  /** Also delete every trashed descendant of a selected id. */
  cascade?: boolean;
};

/** An ordered permanent-delete plan. */
export type PermanentDeletePlan = {
  /** Ids to purge, deepest-first so foreign keys stay valid. */
  ops: string[];
  /** Selected ids refused because they still hold non-selected descendants. */
  blocked: string[];
};

/** Build the parent → children index (only edges inside the list). */
function childrenIndexOf(items: ReadonlyArray<TrashItem>): Map<string, string[]> {
  const known = new Set(items.map((item) => item.id));
  const children = new Map<string, string[]>();
  for (const item of items) {
    if (item.parentId === null || !known.has(item.parentId)) continue;
    const bucket = children.get(item.parentId) ?? [];
    bucket.push(item.id);
    children.set(item.parentId, bucket);
  }
  return children;
}

/** Every descendant of `id` inside the list, cycle-safe. */
function descendantsOf(children: Map<string, string[]>, id: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>([id]);
  const stack = [...(children.get(id) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (seen.has(next)) continue; // malformed cycle — do not loop
    seen.add(next);
    found.push(next);
    stack.push(...(children.get(next) ?? []));
  }
  return found;
}

/**
 * Plan a "delete forever": the ids to purge in children-first order, plus the
 * selected ids that were refused.
 *
 * Without `cascade` a selected id may only be dropped when every trashed
 * descendant is selected too (deleting deepest-first empties the ancestor, so
 * nothing is orphaned); a non-empty ancestor is reported in `blocked` instead.
 * With `cascade` every descendant of each selected id is swept in. Unknown ids
 * are ignored, and the ops are post-ordered over the delete set so no node is
 * removed before the children that point at it.
 */
export function planPermanentDelete(
  items: ReadonlyArray<TrashItem>,
  ids: ReadonlyArray<string>,
  options: PermanentDeleteOptions = {},
): PermanentDeletePlan {
  const known = new Set(items.map((item) => item.id));
  const children = childrenIndexOf(items);
  const selected = new Set(ids.filter((id) => known.has(id)));

  const deleteSet = new Set<string>();
  const blocked: string[] = [];

  if (options.cascade) {
    for (const id of selected) {
      deleteSet.add(id);
      for (const descendant of descendantsOf(children, id)) deleteSet.add(descendant);
    }
  } else {
    for (const id of selected) {
      const stranded = descendantsOf(children, id).filter((d) => !selected.has(d));
      if (stranded.length > 0) blocked.push(id);
      else deleteSet.add(id);
    }
  }

  const ops: string[] = [];
  const emitted = new Set<string>();
  const visiting = new Set<string>();
  const walk = (id: string): void => {
    if (emitted.has(id) || visiting.has(id)) return; // cycle-safe
    visiting.add(id);
    for (const child of children.get(id) ?? []) {
      if (deleteSet.has(child)) walk(child);
    }
    visiting.delete(id);
    emitted.add(id);
    ops.push(id);
  };
  const parentOf = new Map(items.map((item) => [item.id, item.parentId]));
  for (const id of deleteSet) {
    if (emitted.has(id)) continue;
    const parent = parentOf.get(id) ?? null;
    if (parent !== null && deleteSet.has(parent)) continue; // emitted via its ancestor
    walk(id);
  }
  // A delete set trapped in a parent cycle has no reachable root — emit it flat.
  for (const id of deleteSet) {
    if (!emitted.has(id)) walk(id);
  }

  return { ops, blocked };
}

/** Options for {@link emptyTrash}. */
export type EmptyTrashOptions = {
  now: Date;
  /** Days trash is kept. Defaults to {@link DEFAULT_TRASH_RETENTION_DAYS}. */
  retentionDays?: number;
};

/**
 * The purge candidates for "Empty trash": items whose `deletedAt` is strictly
 * older than the retention window as of `now`. Works on any `{ deletedAt }`
 * row (view items or raw records), keeps the caller's references and input
 * order, and never selects a live record. The boundary is strict (an item
 * deleted exactly `retentionDays` ago survives) and a non-positive window
 * disables purging entirely, matching the repo's other retention knobs.
 */
export function emptyTrash<T extends { deletedAt: Date | null }>(
  items: ReadonlyArray<T>,
  options: EmptyTrashOptions,
): T[] {
  const retentionDays = options.retentionDays ?? DEFAULT_TRASH_RETENTION_DAYS;
  return items.filter((item) =>
    isPurgeable({ deletedAt: item.deletedAt }, { retentionDays, now: options.now }),
  );
}

/**
 * The confirmation copy for permanently deleting `id`: how many trashed
 * sub-pages would go with it. Unknown ids return an empty string so the caller
 * can skip the dialog; a leaf says nothing extra.
 */
export function describeDeleteImpact(
  items: ReadonlyArray<TrashItem>,
  id: string,
): string {
  if (!items.some((item) => item.id === id)) return "";
  const count = descendantsOf(childrenIndexOf(items), id).length;
  if (count === 0) return "This will only delete this page";
  return `This will also delete ${count} sub-page${count === 1 ? "" : "s"}`;
}

/**
 * Header counts for a trash list: totals plus how many items are still
 * restorable, already expired, and nested under a deleted ancestor. Used as
 * {@link TrashView.counts} so the header and the view never disagree.
 */
export function summarizeTrash(items: ReadonlyArray<TrashItem>): TrashCounts {
  let restorable = 0;
  let nested = 0;
  for (const item of items) {
    if (item.restorable) restorable += 1;
    if (item.nested) nested += 1;
  }
  return { total: items.length, restorable, expired: items.length - restorable, nested };
}
