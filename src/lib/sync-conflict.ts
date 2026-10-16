/**
 * Sync conflict handling (S23) — pure, deterministic, immutable.
 *
 * When two replicas edit the same record from a shared `base`, most fields
 * merge themselves: one side moved, the other did not. The genuinely hard case
 * is a field **both** sides moved to different values — this module names those
 * (`detectConflicts`), resolves or defers them by strategy (`autoResolve`), and
 * renders one for a human (`describeConflict`).
 *
 * It is the conflict sibling of `audit-diff.ts` (before/after object diff) and
 * `offline-queue.ts` (mutation replay): no Prisma, no React, no clock, no I/O —
 * callers own the store and the UI, the unit sandbox is the harness.
 *
 * DESIGN NOTES
 *  - CONFLICT = BOTH MOVED, DIFFERENTLY: a field conflicts only when neither
 *    side equals `base` and the two sides are not deeply equal. A one-sided
 *    change, or a change both sides made identically, is auto-mergeable.
 *  - SHALLOW DETECTION: `detectConflicts` reports top-level fields only; deep
 *    equality (key-order independent) decides whether a value actually moved.
 *    The `merge` strategy may still reconcile *inside* a conflicted field.
 *  - STRATEGIES: `local-wins` / `remote-wins` take one side wholesale; `manual`
 *    defers every conflict (it is omitted from `record`); `merge` (the default)
 *    recursively merges plain objects and unions arrays, deferring only leaves
 *    it cannot reconcile.
 *  - DETERMINISM / IMMUTABILITY: the key union is visited ASCII-ascending and
 *    inputs are never mutated; every result is a fresh value.
 *  - TOTAL: non-record inputs degrade to `{}`, so nothing here throws.
 *
 * Unit-pinned red-first by `src/lib/sync-conflict.test.ts`.
 */

/** A JSON-shaped record as stored on either replica. */
export type SyncSnapshot = Readonly<Record<string, unknown>>;

/** How a single field moved relative to `base` on one side. */
export type FieldOp = "added" | "removed" | "changed" | "unchanged";

/** How a set of conflicts should be resolved. */
export type ResolutionStrategy = "local-wins" | "remote-wins" | "merge" | "manual";

/** One field both sides moved off `base` to different values. */
export type FieldConflict = {
  /** Top-level field name. */
  readonly field: string;
  /** Value before either side moved; `undefined` when absent (both added). */
  readonly base: unknown;
  /** Local-side result; `undefined` when the local side removed the field. */
  readonly local: unknown;
  /** Remote-side result; `undefined` when the remote side removed the field. */
  readonly remote: unknown;
  /** How the local side moved from `base`. */
  readonly localOp: FieldOp;
  /** How the remote side moved from `base`. */
  readonly remoteOp: FieldOp;
};

/**
 * Sentinel a custom {@link MergeFunction} returns to decline a conflict, leaving
 * it for manual resolution rather than resolving it.
 */
export const UNRESOLVED: unique symbol = Symbol("sync-conflict.unresolved");

/** Custom per-conflict merger; return {@link UNRESOLVED} to defer. */
export type MergeFunction = (conflict: FieldConflict) => unknown | typeof UNRESOLVED;

export type ResolveOptions = {
  /** Strategy to apply; defaults to `"merge"`. */
  readonly strategy?: ResolutionStrategy;
  /**
   * Overrides the built-in `merge` behaviour. Called once per conflict; a
   * non-sentinel return becomes the field's resolved value.
   */
  readonly merge?: MergeFunction;
};

/** Outcome of {@link autoResolve}. */
export type Resolution = {
  readonly strategy: ResolutionStrategy;
  /** Fresh, fully-merged record (unresolved conflict fields are omitted). */
  readonly record: SyncSnapshot;
  /** Every conflict detected, ASCII-ordered, regardless of strategy. */
  readonly conflicts: readonly FieldConflict[];
  /** Conflict fields the strategy resolved automatically, ASCII-ordered. */
  readonly resolved: readonly string[];
  /** Conflict fields left for manual resolution (a subset of `conflicts`). */
  readonly unresolved: readonly FieldConflict[];
};

/** One replica's value for a field, preserving "absent" vs `undefined`. */
type Side = { readonly present: boolean; readonly value: unknown };

/** A plain object (not `null`, not an array, Object/`null` prototype). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Deep equality over JSON-shaped values (order of object keys irrelevant). */
function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => deepEqual(left[key], right[key]));
  }
  return false;
}

/** Treat non-records as an empty record so the walk never throws. */
function asRecord(value: unknown): SyncSnapshot {
  return isPlainObject(value) ? value : {};
}

/** ASCII-ascending comparator for a total, locale-independent order. */
function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Every key appearing in any of `records`, ASCII-ascending and de-duplicated. */
function unionKeys(records: readonly SyncSnapshot[]): string[] {
  const keys = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) keys.add(key);
  }
  return [...keys].sort(compareKeys);
}

/** Read a field as a presence-aware side value. */
function readSide(record: SyncSnapshot, field: string): Side {
  return Object.prototype.hasOwnProperty.call(record, field)
    ? { present: true, value: record[field] }
    : { present: false, value: undefined };
}

/** True when two side values agree, treating "absent" as a value of its own. */
function sameSide(left: Side, right: Side): boolean {
  if (left.present !== right.present) return false;
  if (!left.present) return true;
  return deepEqual(left.value, right.value);
}

/** How `version` moved from `base` for one field. */
function opFor(base: Side, version: Side): FieldOp {
  if (!base.present && !version.present) return "unchanged";
  if (base.present && !version.present) return "removed";
  if (!base.present && version.present) return "added";
  return deepEqual(base.value, version.value) ? "unchanged" : "changed";
}

/** Order-preserving union of two arrays, de-duplicated by deep equality. */
function unionArrays(local: readonly unknown[], remote: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const item of [...local, ...remote]) {
    if (!out.some((existing) => deepEqual(existing, item))) out.push(item);
  }
  return out;
}

/**
 * Three-way merge of one value: agree -> either, one side unmoved -> the other,
 * two objects -> recursive merge, two arrays -> union, otherwise unresolved.
 */
function mergeSide(base: Side, local: Side, remote: Side): Side | typeof UNRESOLVED {
  if (sameSide(local, remote)) return local;
  if (sameSide(local, base)) return remote;
  if (sameSide(remote, base)) return local;

  if (local.present && remote.present && isPlainObject(local.value) && isPlainObject(remote.value)) {
    const baseObject = base.present && isPlainObject(base.value) ? base.value : {};
    const merged = mergeObject(baseObject, local.value, remote.value);
    return merged === UNRESOLVED ? UNRESOLVED : { present: true, value: merged };
  }
  if (local.present && remote.present && Array.isArray(local.value) && Array.isArray(remote.value)) {
    return { present: true, value: unionArrays(local.value, remote.value) };
  }
  return UNRESOLVED;
}

/** Recursively merge plain objects field-by-field; unresolved if any leaf is. */
function mergeObject(
  base: SyncSnapshot,
  local: SyncSnapshot,
  remote: SyncSnapshot,
): SyncSnapshot | typeof UNRESOLVED {
  const out: Record<string, unknown> = {};
  for (const field of unionKeys([base, local, remote])) {
    const side = mergeSide(readSide(base, field), readSide(local, field), readSide(remote, field));
    if (side === UNRESOLVED) return UNRESOLVED;
    if (side.present) out[field] = side.value;
  }
  return out;
}

/** Assemble a public conflict entry from the three sides. */
function toConflict(field: string, base: Side, local: Side, remote: Side): FieldConflict {
  return {
    field,
    base: base.present ? base.value : undefined,
    local: local.present ? local.value : undefined,
    remote: remote.present ? remote.value : undefined,
    localOp: opFor(base, local),
    remoteOp: opFor(base, remote),
  };
}

/** Shared three-way analysis used by both public entry points. */
function analyze(
  local: unknown,
  remote: unknown,
  base: unknown,
  strategy: ResolutionStrategy,
  merge: MergeFunction | undefined,
): Resolution {
  const localRecord = asRecord(local);
  const remoteRecord = asRecord(remote);
  const baseRecord = asRecord(base);

  const record: Record<string, unknown> = {};
  const conflicts: FieldConflict[] = [];
  const resolved: string[] = [];
  const unresolved: FieldConflict[] = [];

  for (const field of unionKeys([baseRecord, localRecord, remoteRecord])) {
    const baseSide = readSide(baseRecord, field);
    const localSide = readSide(localRecord, field);
    const remoteSide = readSide(remoteRecord, field);

    // Both sides agree -> keep it (or leave it absent).
    if (sameSide(localSide, remoteSide)) {
      if (localSide.present) record[field] = localSide.value;
      continue;
    }
    // Only remote moved -> take remote.
    if (sameSide(localSide, baseSide)) {
      if (remoteSide.present) record[field] = remoteSide.value;
      continue;
    }
    // Only local moved -> take local.
    if (sameSide(remoteSide, baseSide)) {
      if (localSide.present) record[field] = localSide.value;
      continue;
    }

    // Both moved, differently -> a conflict.
    const conflict = toConflict(field, baseSide, localSide, remoteSide);
    conflicts.push(conflict);

    if (strategy === "local-wins") {
      if (localSide.present) record[field] = localSide.value;
      resolved.push(field);
      continue;
    }
    if (strategy === "remote-wins") {
      if (remoteSide.present) record[field] = remoteSide.value;
      resolved.push(field);
      continue;
    }
    if (strategy === "manual") {
      unresolved.push(conflict);
      continue;
    }

    // merge
    if (merge !== undefined) {
      const custom = merge(conflict);
      if (custom === UNRESOLVED) {
        unresolved.push(conflict);
        continue;
      }
      record[field] = custom;
      resolved.push(field);
      continue;
    }
    const merged = mergeSide(baseSide, localSide, remoteSide);
    if (merged === UNRESOLVED) {
      unresolved.push(conflict);
      continue;
    }
    if (merged.present) record[field] = merged.value;
    resolved.push(field);
  }

  return { strategy, record, conflicts, resolved, unresolved };
}

/**
 * Field-level conflicts between `local` and `remote` relative to `base`:
 * exactly the fields both sides changed to different values. Shallow, ASCII-
 * ordered, and non-mutating; non-records degrade to `{}`.
 */
export function detectConflicts(local: unknown, remote: unknown, base: unknown): FieldConflict[] {
  return [...analyze(local, remote, base, "merge", undefined).conflicts];
}

/**
 * Three-way merge `local` / `remote` over `base` under a resolution strategy
 * (default `"merge"`). Clean one-sided changes are always applied; conflicts are
 * resolved by `local-wins` / `remote-wins`, deferred by `manual`, or reconciled
 * by `merge` (objects merged, arrays unioned, the rest deferred). Returns a
 * fresh {@link Resolution}; inputs are never mutated.
 */
export function autoResolve(
  local: unknown,
  remote: unknown,
  base: unknown,
  options: ResolveOptions = {},
): Resolution {
  return analyze(local, remote, base, options.strategy ?? "merge", options.merge);
}

/** Render a value for {@link describeConflict}; absent reads as `none`. */
function formatValue(value: unknown): string {
  if (value === undefined) return "none";
  const json = JSON.stringify(value);
  return json === undefined ? "none" : json;
}

/**
 * One-line human summary of a conflict, e.g.
 * `title: local changed "B", remote changed "C"; base "A"`.
 */
export function describeConflict(conflict: FieldConflict): string {
  const local = `local ${conflict.localOp} ${formatValue(conflict.local)}`;
  const remote = `remote ${conflict.remoteOp} ${formatValue(conflict.remote)}`;
  return `${conflict.field}: ${local}, ${remote}; base ${formatValue(conflict.base)}`;
}
