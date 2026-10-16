/**
 * Incremental syncing (docs/MISSING_FEATURES.md "Incremental syncing — sync
 * only changed blocks") — pure, deterministic, no Prisma.
 *
 * A client that re-sends a whole document tree on every tick wastes bandwidth;
 * the op-log approach the roadmap points at needs a diff at its core. This
 * module is that core: reconcile two document snapshots **by `id`**, using
 * `updatedAt` as the version marker, so a surface can pull/merge only what
 * actually moved.
 *
 * {@link diffSnapshot} buckets the id space into `added`/`updated`/`removed`/
 * `unchanged`; {@link applyDelta} folds a delta back onto a snapshot; and
 * {@link isStale} answers the "must I fetch?" question from two `updatedAt`
 * values. It is the *document-set* sibling of `version-history.ts` (block diff):
 * same no-Prisma, unit-sandbox discipline.
 *
 * DESIGN NOTES
 *  - IDENTITY IS `id`: a document with no stable, non-empty string `id` is
 *    skipped, so one bad row can never poison a whole sync. Duplicate ids keep
 *    the FIRST occurrence (stable ids are unique; the guard is defensive).
 *  - CHANGE = CANONICAL CONTENT: a shared id is `updated` when its canonical
 *    JSON differs from before. `updatedAt` alone is sufficient (the common
 *    case), but a payload change with a stale `updatedAt` is still caught —
 *    silently missing a write is far worse than one redundant upsert. Object
 *    key order never matters; arrays compare by content and position.
 *  - DETERMINISM: every bucket is ASCII-ascending by `id` and `applyDelta`
 *    returns an id-ordered array, so equal input always yields a byte-identical
 *    delta. `applyDelta(prev, diffSnapshot(prev, next))` reproduces `next`'s
 *    content exactly (ordering isn't part of a delta — there is no "moved").
 *  - STALENESS IS TIME: `isStale(local, remote)` compares `updatedAt` as epoch
 *    ms (`Date`, number or a `Date.parse`-able string). When a timestamp cannot
 *    be parsed it falls back to comparing the raw text, erring toward a pull.
 *  - GRACEFUL & PURE: non-snapshots degrade to empty, non-deltas to no-ops, and
 *    no helper mutates its arguments or throws.
 *
 * Unit-pinned red-first by `src/lib/sync-delta.test.ts`.
 */

/** A version marker accepted from callers: epoch ms, a `Date`, or a parsable string. */
export type SyncTimestamp = string | number | Date;

/** The minimal contract of a syncable document: a stable id and a version stamp. */
export type SyncDocument = {
  readonly id: string;
  readonly updatedAt: SyncTimestamp;
};

/** A syncable document plus arbitrary JSON-shaped payload fields. */
export type SnapshotDocument = {
  readonly id: string;
  readonly updatedAt: SyncTimestamp;
  readonly [field: string]: unknown;
};

/** One side of a reconciliation: an ordered (or unordered) set of documents. */
export type Snapshot = readonly SnapshotDocument[];

/**
 * The result of {@link diffSnapshot}. `added`, `updated` and `unchanged`
 * carry the NEXT document; `removed` carries the PREVIOUS one. Every list is
 * `id`-ascending.
 */
export type SnapshotDelta = {
  readonly added: readonly SnapshotDocument[];
  readonly updated: readonly SnapshotDocument[];
  readonly removed: readonly SnapshotDocument[];
  readonly unchanged: readonly SnapshotDocument[];
};

/** ASCII-ascending comparator for `id`s — a total, locale-independent order. */
function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** `id`-ascending copy; never sorts the caller's array. */
function sortById(documents: readonly SnapshotDocument[]): SnapshotDocument[] {
  return [...documents].sort((left, right) => compareIds(left.id, right.id));
}

/**
 * Key-order-independent JSON with `Date` support, so re-serialised equal
 * content compares equal. Cycles are out of scope: snapshots are JSON-shaped.
 */
function canonicalJson(value: unknown): string {
  if (value instanceof Date) {
    const time = value.getTime();
    return JSON.stringify(Number.isFinite(time) ? value.toISOString() : null);
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([leftKey], [rightKey]) => compareIds(leftKey, rightKey))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
  return `{${entries.join(",")}}`;
}

/** True for a record carrying a non-empty string `id` (a syncable document). */
function isDocument(value: unknown): value is SnapshotDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0;
}

/**
 * Index a snapshot by `id`, skipping malformed entries and keeping the first
 * occurrence of a duplicate. A non-array degrades to an empty map.
 */
function indexById(snapshot: Snapshot | null | undefined): Map<string, SnapshotDocument> {
  const index = new Map<string, SnapshotDocument>();
  if (!Array.isArray(snapshot)) return index;
  for (const entry of snapshot) {
    if (!isDocument(entry) || index.has(entry.id)) continue;
    index.set(entry.id, entry);
  }
  return index;
}

/** Length of a bucket, tolerating a malformed (non-array) delta field. */
function bucketSize(bucket: readonly SnapshotDocument[] | undefined): number {
  return Array.isArray(bucket) ? bucket.length : 0;
}

/**
 * Diff two snapshots by `id`, bucketing the id space into the four sets a sync
 * client acts on. `added`/`updated`/`unchanged` expose the NEXT document,
 * `removed` the PREVIOUS one; every bucket is `id`-ascending. Neither input is
 * mutated and malformed sides degrade to empty.
 */
export function diffSnapshot(
  prev: Snapshot | null | undefined,
  next: Snapshot | null | undefined,
): SnapshotDelta {
  const before = indexById(prev);
  const after = indexById(next);

  const added: SnapshotDocument[] = [];
  const updated: SnapshotDocument[] = [];
  const unchanged: SnapshotDocument[] = [];

  for (const [id, document] of after) {
    const previous = before.get(id);
    if (previous === undefined) {
      added.push(document);
    } else if (canonicalJson(previous) === canonicalJson(document)) {
      unchanged.push(document);
    } else {
      updated.push(document);
    }
  }

  const removed: SnapshotDocument[] = [];
  for (const [id, document] of before) {
    if (!after.has(id)) removed.push(document);
  }

  return {
    added: sortById(added),
    updated: sortById(updated),
    removed: sortById(removed),
    unchanged: sortById(unchanged),
  };
}

/**
 * Fold `delta` onto `snapshot` and return an `id`-ordered snapshot.
 *
 * Removals are applied first, then every document carried by
 * `added`/`updated`/`unchanged` is upserted (so an id that is both removed and
 * re-added survives, and a later duplicate wins). The snapshot and delta are
 * never mutated; null/malformed input degrades to an id-ordered copy / no-op.
 */
export function applyDelta(
  snapshot: Snapshot | null | undefined,
  delta: SnapshotDelta | null | undefined,
): SnapshotDocument[] {
  const merged = indexById(snapshot);

  for (const document of delta?.removed ?? []) {
    if (isDocument(document)) merged.delete(document.id);
  }

  const upserts = [
    ...(delta?.added ?? []),
    ...(delta?.updated ?? []),
    ...(delta?.unchanged ?? []),
  ];
  for (const document of upserts) {
    if (isDocument(document)) merged.set(document.id, document);
  }

  return sortById([...merged.values()]);
}

/** Normalise a version marker to epoch ms, or `null` when it cannot be parsed. */
function toEpochMs(value: SyncTimestamp | null | undefined): number | null {
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : typeof value === "string"
          ? Date.parse(value)
          : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Whether a local copy must be refreshed from `remote` (R: incremental sync).
 *
 * `true` when `remote` exists and is newer than `local`, when there is no local
 * copy to trust, or when a timestamp cannot be parsed and the raw text differs
 * (a conservative pull beats a silent miss). A missing `remote` is never stale.
 * Neither argument is mutated.
 */
export function isStale(
  local: SyncDocument | null | undefined,
  remote: SyncDocument | null | undefined,
): boolean {
  if (remote === null || remote === undefined) return false;
  if (local === null || local === undefined) return true;

  const remoteMs = toEpochMs(remote.updatedAt);
  const localMs = toEpochMs(local.updatedAt);
  if (remoteMs !== null && localMs !== null) return remoteMs > localMs;

  return canonicalJson(remote.updatedAt) !== canonicalJson(local.updatedAt);
}

/**
 * Whether a delta carries anything to apply: any add, update or removal. A
 * delta that is empty — or holds only `unchanged` documents — has no changes.
 * Null/undefined counts as no changes.
 */
export function hasChanges(delta: SnapshotDelta | null | undefined): boolean {
  if (delta === null || delta === undefined) return false;
  return bucketSize(delta.added) > 0 || bucketSize(delta.updated) > 0 || bucketSize(delta.removed) > 0;
}
