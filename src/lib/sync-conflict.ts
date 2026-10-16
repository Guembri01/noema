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
 * One-line human summary of a three-way-merge conflict, e.g.
 * `title: local changed "B", remote changed "C"; base "A"`.
 */
export function describeConflict(conflict: FieldConflict): string;
/**
 * One-line human summary of a logical-clock conflict, e.g.
 * `title: alice@1 "A" -> bob@2 "B"; actors alice, bob; unresolved`.
 */
export function describeConflict(conflict: MergeConflict): string;
export function describeConflict(conflict: FieldConflict | MergeConflict): string {
  if ("before" in conflict) return describeMergeConflict(conflict);
  const local = `local ${conflict.localOp} ${formatValue(conflict.local)}`;
  const remote = `remote ${conflict.remoteOp} ${formatValue(conflict.remote)}`;
  return `${conflict.field}: ${local}, ${remote}; base ${formatValue(conflict.base)}`;
}

/* ============================================================================
 * S17 - logical-clock conflict resolution with visible provenance
 *
 * The three-way helpers above detect conflicts relative to a shared `base`.
 * A local-first replica does not always have one: two offline clients each
 * stamp their edit with a Lamport clock and reconcile on reconnect. That path
 * is modelled here and it is deliberately **not silent** — last-writer-wins
 * picks a value, but every competitor is retained in `provenance` / `conflicts`
 * so a UI (or a resolver policy) can show what was overwritten and by whom.
 *
 *  - CLOCK: `tick(clock, actorId)` advances a Lamport counter; `compare(a, b)`
 *    orders two stamps by `(clock, actorId)` ascending, so a given pair of
 *    edits always wins/loses the same way on every replica.
 *  - VERSION: `RecordVersion` is one field's `{clock, actorId, value, at}`.
 *  - MERGE: `mergeField` and `mergeDoc` are commutative — `merge(a, b)` deep-
 *    equals `merge(b, a)` — because ordering is canonical and no result field
 *    is relative to argument position.
 *  - VISIBILITY: `conflicts[]` carries `before`/`after` and the `actors`, and
 *    `resolveConflict` / `applyResolutions` turn a deferred conflict into a
 *    chosen value without dropping the losing candidate.
 * ========================================================================== */

/** A Lamport clock reading: a monotonic counter branded with its issuing actor. */
export type ClockStamp = {
  /** Monotonic logical counter. */
  readonly clock: number;
  /** The actor that issued the reading; the tiebreak when counters collide. */
  readonly actorId: string;
};

/** One field's value on a replica, stamped for last-writer-wins ordering. */
export type RecordVersion<T = unknown> = {
  /** Monotonic Lamport counter of the write. */
  readonly clock: number;
  /** Actor that authored the write (the clock-tie tiebreak). */
  readonly actorId: string;
  /** The field value at that stamp. */
  readonly value: T;
  /** Caller-supplied wall-clock stamp (epoch ms); display only, never ordered. */
  readonly at: number;
};

/**
 * Advance a Lamport clock: the next counter for `actorId` after observing
 * `clock`. A local edit calls `tick(lastSeen, me)`; merging a peer's clock and
 * then editing calls `tick(max(mine, theirs), me)`. The result never decreases,
 * so a later edit can never sort before an earlier one, and a non-finite input
 * degrades to `1` rather than poisoning the clock.
 */
export function tick(clock: ClockStamp | number, actorId: string): ClockStamp {
  const current = typeof clock === "number" ? clock : clock.clock;
  const counter = Number.isFinite(current) ? Math.max(0, Math.trunc(current)) : 0;
  return { clock: counter + 1, actorId };
}

/**
 * Total order on two clock stamps: higher logical clock first, then
 * `actorId` ascending. The **greater** stamp wins, so a later edit beats an
 * earlier one and a genuine tie is decided deterministically by author —
 * every replica that sees the same two stamps agrees which one wins.
 */
export function compare(a: ClockStamp, b: ClockStamp): number {
  if (a.clock !== b.clock) return a.clock < b.clock ? -1 : 1;
  if (a.actorId === b.actorId) return 0;
  return a.actorId < b.actorId ? -1 : 1;
}

/** Canonical JSON (object keys sorted, `undefined` omitted) for stable ties. */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => compareKeys(left, right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Canonical order of two versions: Lamport order, then the value as a
 * last-resort tiebreak. Two versions with the same actor and clock but
 * different values (a contract violation) still order deterministically, so
 * convergence never depends on argument order.
 */
function compareVersions(a: RecordVersion, b: RecordVersion): number {
  return compare(a, b) || compareKeys(canonicalJson(a.value), canonicalJson(b.value));
}

/** The outcome of merging one field. */
export type FieldMerge<T = unknown> = {
  /** The winning value (the last writer's). */
  readonly value: T;
  /** The winning version. */
  readonly winner: RecordVersion<T>;
  /** The candidates seen, canonically ordered; both on a conflict. */
  readonly provenance: readonly RecordVersion<T>[];
  /** `true` when the two candidates hold different values. */
  readonly conflict: boolean;
};

/**
 * Merge one field from two replicas by last-writer-wins on the logical clock,
 * never silently: on a conflict both candidates are returned in `provenance`
 * (loser first, winner last), so the overwritten value is recoverable. The
 * result is order-independent — `mergeField(a, b)` deep-equals
 * `mergeField(b, a)` — and neither version is mutated.
 */
export function mergeField<T>(local: RecordVersion<T>, remote: RecordVersion<T>): FieldMerge<T> {
  const order = compareVersions(local, remote);
  const winner = order >= 0 ? local : remote;
  const loser = order >= 0 ? remote : local;
  const conflict = !deepEqual(local.value, remote.value);
  return {
    value: winner.value,
    winner,
    provenance: conflict ? [loser, winner] : [winner],
    conflict,
  };
}

/** How a document merge resolves conflicts. */
export type MergeStrategy = "lww" | "manual";

/** Options for {@link mergeDoc}. */
export type MergeDocOptions = {
  /** `"lww"` (default) resolves automatically; `"manual"` defers every conflict. */
  readonly strategy?: MergeStrategy;
};

/**
 * One field both replicas moved to different values. `before` / `after` are the
 * superseded and winning candidates (canonical order, independent of argument
 * order) and `actors` lists both authors, ASCII-ascending.
 */
export type MergeConflict = {
  /** Top-level field name. */
  readonly field: string;
  /** The candidate last-writer-wins superseded (the loser). */
  readonly before: RecordVersion;
  /** The candidate that won (the current value, unless manually overridden). */
  readonly after: RecordVersion;
  /** The competing actors, ASCII-ascending and de-duplicated. */
  readonly actors: readonly string[];
  /** `true` once the field has a value under the active strategy. */
  readonly resolved: boolean;
};

/** The result of {@link mergeDoc}: the fields, their versions and any conflicts. */
export type MergedDoc = {
  /** The strategy applied. */
  readonly strategy: MergeStrategy;
  /** Field name -> winning {@link RecordVersion} (deferred fields omitted). */
  readonly versions: Record<string, RecordVersion>;
  /** Field name -> winning value (deferred fields omitted). */
  readonly fields: Record<string, unknown>;
  /** Every conflicting field, ASCII-ordered by name. */
  readonly conflicts: readonly MergeConflict[];
};

/** Defensively rebuild one version from untrusted input, or `null` if unusable. */
function toVersion(raw: unknown): RecordVersion | null {
  if (!isPlainObject(raw)) return null;
  const clock = typeof raw.clock === "number" && Number.isFinite(raw.clock) ? Math.trunc(raw.clock) : null;
  if (clock === null || clock < 0) return null;
  if (typeof raw.actorId !== "string" || raw.actorId.length === 0) return null;
  const at = typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : 0;
  return { clock, actorId: raw.actorId, value: raw.value, at };
}

/** Rebuild a `field -> version` map from untrusted input, dropping junk entries. */
function toVersionMap(raw: unknown): Record<string, RecordVersion> {
  const out: Record<string, RecordVersion> = {};
  if (!isPlainObject(raw)) return out;
  for (const [field, value] of Object.entries(raw)) {
    const version = toVersion(value);
    if (version !== null) out[field] = version;
  }
  return out;
}

/**
 * Merge two versioned documents, returning the merged fields plus a
 * `conflicts[]` list. Non-conflicting fields are always applied; a field both
 * replicas changed to different values is recorded in `conflicts[]` either way,
 * so the resolution is never silent. Under `"lww"` (default) the greater
 * `(clock, actorId)` wins; under `"manual"` every conflict is deferred (omitted
 * from `fields`/`versions`) for {@link resolveConflict} / {@link applyResolutions}.
 *
 * The merge is commutative — `mergeDoc(a, b)` deep-equals `mergeDoc(b, a)` —
 * and neither input is mutated.
 */
export function mergeDoc(
  local: unknown,
  remote: unknown,
  options: MergeDocOptions = {},
): MergedDoc {
  const strategy: MergeStrategy = options.strategy === "manual" ? "manual" : "lww";
  const left = toVersionMap(local);
  const right = toVersionMap(remote);
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort(compareKeys);

  const versions: Record<string, RecordVersion> = {};
  const fields: Record<string, unknown> = {};
  const conflicts: MergeConflict[] = [];

  for (const field of keys) {
    const localVersion = left[field];
    const remoteVersion = right[field];

    if (localVersion === undefined) {
      versions[field] = remoteVersion;
      fields[field] = remoteVersion.value;
      continue;
    }
    if (remoteVersion === undefined) {
      versions[field] = localVersion;
      fields[field] = localVersion.value;
      continue;
    }

    const merged = mergeField(localVersion, remoteVersion);
    if (!merged.conflict) {
      versions[field] = merged.winner;
      fields[field] = merged.value;
      continue;
    }

    const conflict: MergeConflict = {
      field,
      before: merged.provenance[0],
      after: merged.winner,
      actors: [...new Set([localVersion.actorId, remoteVersion.actorId])].sort(compareKeys),
      resolved: strategy === "lww",
    };
    conflicts.push(conflict);
    if (strategy === "lww") {
      versions[field] = merged.winner;
      fields[field] = merged.value;
    }
  }

  return { strategy, versions, fields, conflicts };
}

/** Which side of a conflict to keep when resolving it. */
export type ConflictChoice = "before" | "after";

/**
 * Resolve one conflict to a concrete version: `"after"` keeps the winner LWW
 * chose, `"before"` restores the superseded candidate. Returns a fresh copy and
 * never mutates the conflict.
 */
export function resolveConflict(conflict: MergeConflict, choice: ConflictChoice): RecordVersion {
  const chosen = choice === "before" ? conflict.before : conflict.after;
  return { ...chosen };
}

/** A deferred conflict and the side the resolver chose for it. */
export type ConflictResolution = {
  /** The conflict's field name. */
  readonly field: string;
  /** Which candidate to keep. */
  readonly choice: ConflictChoice;
};

/**
 * Apply manual resolutions to a {@link MergedDoc}: each resolved field gains the
 * chosen version, its conflict is marked `resolved` but keeps its `before`/
 * `after` provenance, and unknown fields are ignored. Pure and idempotent —
 * inputs are never mutated and re-applying the same resolutions is a no-op.
 */
export function applyResolutions(
  doc: MergedDoc,
  resolutions: readonly ConflictResolution[],
): MergedDoc {
  const choices = new Map<string, ConflictChoice>();
  for (const resolution of resolutions) {
    if (resolution && typeof resolution.field === "string") {
      choices.set(resolution.field, resolution.choice);
    }
  }

  const versions: Record<string, RecordVersion> = { ...doc.versions };
  const fields: Record<string, unknown> = { ...doc.fields };
  const conflicts = doc.conflicts.map((conflict) => {
    const choice = choices.get(conflict.field);
    if (choice === undefined) return conflict;
    const chosen = resolveConflict(conflict, choice);
    versions[conflict.field] = chosen;
    fields[conflict.field] = chosen.value;
    return { ...conflict, resolved: true };
  });

  return { strategy: doc.strategy, versions, fields, conflicts };
}

/** Render a logical-clock conflict for {@link describeConflict}. */
function describeMergeConflict(conflict: MergeConflict): string {
  const before = `${conflict.before.actorId}@${conflict.before.clock} ${formatValue(conflict.before.value)}`;
  const after = `${conflict.after.actorId}@${conflict.after.clock} ${formatValue(conflict.after.value)}`;
  const state = conflict.resolved ? "resolved" : "unresolved";
  return `${conflict.field}: ${before} -> ${after}; actors ${conflict.actors.join(", ")}; ${state}`;
}
