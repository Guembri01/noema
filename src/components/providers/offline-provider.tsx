"use client";

/**
 * Offline provider (§17 Offline cache / Incremental syncing; docs/FEATURE_MATRIX.md
 * "Offline cache", "Sync only changed blocks"). Engine in `offline-cache.ts`,
 * composed by `offline-storage.ts`.
 *
 * Mounts exactly one canonical {@link OfflineCache} and one queue-policy
 * {@link OfflineStore} for the whole app, then publishes them with the derived
 * sync state the offline indicator renders.
 *
 * CANONICAL RELATIONSHIP
 *  - `offline-cache.ts` is canonical: it owns the namespace, the schema version
 *    and the on-disk queue envelope (see `offline-storage.ts`).
 *  - `offline-store.ts` is load-bearing as the *queue policy/delivery layer* over
 *    that same canonical queue (coalescing, batching, retry), persisted through
 *    the `createOfflineBackend` bridge. A mutation written by either engine is
 *    read by the other.
 *  - `incremental-sync.ts` is the canonical *op-log* layer: {@link buildSyncPayload}
 *    diffs local changes into the minimal op set and {@link receiveSyncPayload}
 *    validates and folds an incoming log.
 *  - `sync-delta.ts` is *reused* (not delegated) as the coarse document-set layer:
 *    {@link pullDelta}/{@link acceptDelta}/{@link documentIsStale} bucket whole
 *    documents by `id`, one granularity above the op-log.
 *  - `sync-conflict.ts` renders merge conflicts *with provenance*: the indicator
 *    shows `describeConflict` text and resolves fields through
 *    {@link resolveDocConflict} without dropping the losing candidate.
 *
 * The pure bridges (`buildSyncPayload`, `receiveSyncPayload`, `surfaceConflicts`,
 * `resolveDocConflict`, `pullDelta`, `acceptDelta`, `deltaHasChanges`,
 * `documentIsStale`) are DOM-free and clock-free, so the wiring is provable in
 * the Node unit sandbox (see `offline-provider.test.ts`).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  createMemoryStorage,
  createOfflineCache,
  type OfflineCache,
  type OfflineCacheStats,
  type OfflineStorage,
} from "@/lib/offline-cache";
import {
  createOfflineStore,
  type DrainBatch,
  type OfflineSnapshot,
  type OfflineStore,
} from "@/lib/offline-store";
import { createDefaultStorage, createOfflineBackend } from "@/lib/offline-storage";
import type { MutationDraft, QueuedMutation } from "@/lib/offline-queue";
import {
  applyOps,
  buildOps,
  compactOps,
  cursorOf,
  opsSince,
  validateOpLog,
  type BuildContext,
  type DocEntity,
  type DocInput,
  type Op,
  type OpList,
  type OpLogValidation,
} from "@/lib/incremental-sync";
import {
  applyResolutions,
  describeConflict,
  mergeDoc,
  type ConflictChoice,
  type ConflictResolution,
  type MergeConflict,
  type MergeDocOptions,
  type MergedDoc,
} from "@/lib/sync-conflict";
import {
  applyDelta,
  diffSnapshot,
  hasChanges,
  isStale,
  type Snapshot,
  type SnapshotDelta,
  type SnapshotDocument,
  type SyncDocument,
} from "@/lib/sync-delta";

/** The minimal op-log the provider sends for a round of local changes. */
export type SyncPayload = {
  /** The minimal create/update/delete ops, ascending `seq`. */
  readonly ops: Op[];
  /** The payload cursor (`max(seq)`, or `0` for an empty log). */
  readonly cursor: number;
};

/**
 * Compute the minimal op-log between two local snapshots using
 * `incremental-sync.buildOps`, then compact redundant chains so the payload is
 * byte-for-byte the smallest log that reproduces `next`.
 */
export function buildSyncPayload(
  prev: DocInput,
  next: DocInput,
  ctx: BuildContext = {},
): SyncPayload {
  const ops = compactOps(buildOps(prev, next, ctx));
  return { ops, cursor: cursorOf(ops) };
}

/** What {@link receiveSyncPayload} did with an incoming log. */
export type SyncReceive = {
  /** The document after applying the accepted ops (id-ordered). */
  readonly doc: DocEntity[];
  /** The structural audit of the whole incoming log. */
  readonly validation: OpLogValidation;
  /** How many ops were applied. */
  readonly applied: number;
  /** `true` when the log was malformed and nothing was applied. */
  readonly rejected: boolean;
};

/**
 * Validate an incoming log with `incremental-sync.validateOpLog`, then fold the
 * ops after `since` onto `doc` with `applyOps`. A structurally invalid log is
 * rejected wholesale — the document is returned unchanged (id-ordered) and the
 * `validation.issues` explain why, so a corrupt payload can never half-apply.
 */
export function receiveSyncPayload(
  doc: DocInput,
  payload: OpList,
  since?: number | null,
): SyncReceive {
  const validation = validateOpLog(payload);
  if (!validation.valid) {
    return { doc: applyOps(doc, []), validation, applied: 0, rejected: true };
  }
  const incoming = opsSince(payload, since);
  return { doc: applyOps(doc, incoming), validation, applied: incoming.length, rejected: false };
}

/** One surfaced conflict plus its human one-liner. */
export type ConflictView = {
  readonly conflict: MergeConflict;
  /** `sync-conflict.describeConflict(conflict)` — the provenance line. */
  readonly summary: string;
};

/** The result of {@link surfaceConflicts}: the merged doc and the readable rows. */
export type ConflictSurface = {
  readonly doc: MergedDoc;
  readonly views: readonly ConflictView[];
};

/**
 * Merge two versioned documents and expose every genuine conflict for a human.
 * Defaults to the `"manual"` strategy so nothing is silently overwritten — each
 * `ConflictView` carries the losing and winning candidate for the indicator to
 * render and for {@link resolveDocConflict} to resolve.
 */
export function surfaceConflicts(
  local: unknown,
  remote: unknown,
  options: MergeDocOptions = {},
): ConflictSurface {
  const doc = mergeDoc(local, remote, { strategy: options.strategy ?? "manual" });
  const views = doc.conflicts.map((conflict) => ({
    conflict,
    summary: describeConflict(conflict),
  }));
  return { doc, views };
}

/**
 * Resolve one surfaced conflict by field and side, keeping the provenance: the
 * conflict stays in `conflicts` with `resolved: true` and both candidates
 * intact, and the chosen value lands in `fields`.
 */
export function resolveDocConflict(
  doc: MergedDoc,
  field: string,
  choice: ConflictChoice,
): MergedDoc {
  const resolution: ConflictResolution = { field, choice };
  return applyResolutions(doc, [resolution]);
}

/** Coarse, whole-document diff — `sync-delta.diffSnapshot`, reused as-is. */
export function pullDelta(
  prev: Snapshot | null | undefined,
  next: Snapshot | null | undefined,
): SnapshotDelta {
  return diffSnapshot(prev, next);
}

/** Fold a coarse delta back onto a snapshot — `sync-delta.applyDelta`. */
export function acceptDelta(
  snapshot: Snapshot | null | undefined,
  delta: SnapshotDelta | null | undefined,
): SnapshotDocument[] {
  return applyDelta(snapshot, delta);
}

/** Whether a coarse delta carries anything — `sync-delta.hasChanges`. */
export function deltaHasChanges(delta: SnapshotDelta | null | undefined): boolean {
  return hasChanges(delta);
}

/** Whether a local doc must be refreshed from remote — `sync-delta.isStale`. */
export function documentIsStale(
  local: SyncDocument | null | undefined,
  remote: SyncDocument | null | undefined,
): boolean {
  return isStale(local, remote);
}

/** Default entry TTL for the mounted cache (5 minutes). */
export const OFFLINE_DEFAULT_TTL_MS = 5 * 60_000;

/** The two engines plus the storage seam they share. */
type OfflineEngines = {
  readonly storage: OfflineStorage;
  readonly cache: OfflineCache;
  readonly store: OfflineStore;
};

/** Build the mounted engines over one storage seam. */
function createEngines(ttlMs: number | undefined): OfflineEngines {
  const storage = createDefaultStorage();
  const cache = createOfflineCache(storage, { now: () => Date.now(), ttlMs });
  const store = createOfflineStore(createOfflineBackend(storage));
  return { storage, cache, store };
}

/** The handle every consumer receives from {@link useOffline}. */
export type OfflineApi = {
  /** Conflict surface for the indicator (empty until `surface` is called). */
  mergedDoc: MergedDoc | null;
  /** Every surfaced conflict, ASCII-ordered by field. */
  conflicts: readonly MergeConflict[];
  /** Whether the browser currently reports connectivity. */
  online: boolean;
  /** How many mutations await delivery. */
  pending: number;
  /** The canonical engines, exposed for surfaces that need them directly. */
  cache: OfflineCache;
  store: OfflineStore;
  /** The last queue snapshot, or `null` before the first refresh. */
  snapshot: OfflineSnapshot | null;
  /** The last cache stats, or `null` before the first refresh. */
  stats: OfflineCacheStats | null;
  /** Epoch ms of the last successful flush, or `null`. */
  lastSyncedAt: number | null;
  /** Admit a local edit to the durable queue. */
  queue(draft: MutationDraft): Promise<QueuedMutation>;
  /** Acknowledge a delivered batch (or every pending mutation) and refresh. */
  flush(batch?: DrainBatch): Promise<void>;
  /** Re-read the queue snapshot and cache stats. */
  refresh(): Promise<void>;
  /** Merge two versioned docs and surface the conflicts for resolution. */
  surface(local: unknown, remote: unknown, options?: MergeDocOptions): ConflictSurface;
  /** Resolve a surfaced conflict to one side, updating the merged doc. */
  resolve(field: string, choice: ConflictChoice): void;
};

/**
 * The inert, provider-less handle. Backed by a private memory store so a
 * consumer rendered outside the shell stays functional instead of throwing; the
 * real handle is always present under the root layout.
 */
const DETACHED_STORAGE = createMemoryStorage();
const DETACHED_CACHE = createOfflineCache(DETACHED_STORAGE, { now: () => 0 });
const DETACHED_STORE = createOfflineStore(createOfflineBackend(DETACHED_STORAGE));

const DETACHED: OfflineApi = {
  mergedDoc: null,
  conflicts: [],
  online: true,
  pending: 0,
  cache: DETACHED_CACHE,
  store: DETACHED_STORE,
  snapshot: null,
  stats: null,
  lastSyncedAt: null,
  queue: (draft) => DETACHED_STORE.enqueue(draft),
  flush: async () => {
    /* not mounted */
  },
  refresh: async () => {
    /* not mounted */
  },
  surface: (local, remote, options) => surfaceConflicts(local, remote, options),
  resolve: () => {
    /* not mounted */
  },
};

const OfflineContext = createContext<OfflineApi | null>(null);

export function OfflineProvider({
  children,
  ttlMs,
}: {
  children: React.ReactNode;
  ttlMs?: number;
}) {
  const engines = useState<OfflineEngines>(() => createEngines(ttlMs))[0];

  const [online, setOnline] = useState(true);
  const [snapshot, setSnapshot] = useState<OfflineSnapshot | null>(null);
  const [stats, setStats] = useState<OfflineCacheStats | null>(null);
  const [mergedDoc, setMergedDoc] = useState<MergedDoc | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const [nextSnapshot, nextStats] = await Promise.all([
      engines.store.snapshot(),
      engines.cache.stats(),
    ]);
    setSnapshot(nextSnapshot);
    setStats(nextStats);
  }, [engines]);

  // Browser connectivity + the initial queue/stats read. Guarded so an SSR
  // render (no `window`) mounts cleanly.
  useEffect(() => {
    if (typeof navigator !== "undefined") setOnline(navigator.onLine);
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    void refresh();
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [refresh]);

  const queue = useCallback(
    async (draft: MutationDraft) => {
      const queued = await engines.store.enqueue(draft);
      await refresh();
      return queued;
    },
    [engines, refresh],
  );

  const flush = useCallback(
    async (batch?: DrainBatch) => {
      if (batch !== undefined) {
        await engines.store.drain(batch);
      } else {
        const pending = await engines.store.pending();
        if (pending.length > 0) await engines.store.drain(pending);
      }
      setLastSyncedAt(Date.now());
      await refresh();
    },
    [engines, refresh],
  );

  const surface = useCallback((local: unknown, remote: unknown, options: MergeDocOptions = {}) => {
    const next = surfaceConflicts(local, remote, options);
    setMergedDoc(next.doc);
    return next;
  }, []);

  const resolve = useCallback((field: string, choice: ConflictChoice) => {
    setMergedDoc((current) =>
      current === null ? current : resolveDocConflict(current, field, choice),
    );
  }, []);

  const conflicts = mergedDoc?.conflicts ?? [];

  const value = useMemo<OfflineApi>(
    () => ({
      mergedDoc,
      conflicts,
      online,
      pending: snapshot?.pending ?? 0,
      cache: engines.cache,
      store: engines.store,
      snapshot,
      stats,
      lastSyncedAt,
      queue,
      flush,
      refresh,
      surface,
      resolve,
    }),
    [
      mergedDoc,
      conflicts,
      online,
      engines,
      snapshot,
      stats,
      lastSyncedAt,
      queue,
      flush,
      refresh,
      surface,
      resolve,
    ],
  );

  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

/** Read the offline handle. Inert (memory-backed) when no provider is mounted. */
export function useOffline(): OfflineApi {
  return useContext(OfflineContext) ?? DETACHED;
}
