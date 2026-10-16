/**
 * Offline cache engine (§17 Offline cache) — the async, storage-backed TTL+LRU
 * cache and pending-mutation replay queue behind the "read and edit while
 * offline, reconcile when back online" path.
 *
 * Everything is layered over an injected {@link OfflineStorage} seam
 * (`getItem` / `setItem` / `removeItem` / `keys`, all promise-returning), so the
 * same engine runs unchanged over `localStorage`, IndexedDB, a service-worker
 * `Cache`, or — in tests — {@link createMemoryStorage}. The engine never reads a
 * clock of its own: callers inject `now` (a `() => number` returning unix
 * milliseconds) once at construction, so a sequence of operations is fully
 * reproducible.
 *
 * Two independent key spaces share one storage:
 *
 *  - **entries** — `put`/`get` values under `"@offline-cache/entry/<key>"`,
 *    wrapped in a versioned envelope (`{ schemaVersion, value, storedAt,
 *    lastAccess, expiresAt, bytes, meta }`). An entry whose `schemaVersion` no
 *    longer matches {@link OFFLINE_CACHE_SCHEMA_VERSION} is treated as a miss
 *    (and swept), so shipping a new payload shape invalidates old caches for
 *    free.
 *  - **the mutation queue** — the replay log is stored under
 *    `"@offline-cache/mutations"` as `{ schemaVersion, mutations }`, ordered by
 *    a monotonic `seq`.
 *
 * The cache is **size-bounded by `maxBytes`** (summed `bytes`, defaulting to the
 * UTF-8 length of the stored envelope or an explicit `meta.sizeBytes`).
 * {@link OfflineCache.evictLRU} trims the least-recently-used entries first,
 * ordered by `lastAccess`; every successful `get` (and every entry read by
 * `getMany`) promotes its `lastAccess`, so a hot key survives a cold one.
 *
 * TTL is advisory: a stale entry (`now >= expiresAt`) is **still returned**,
 * with `stale: true`, so callers can render cached content and revalidate in the
 * background. `expiresAt` is `null` when an entry never expires.
 *
 * A store is a stateful, async handle by design (like `offline-store.ts`).
 * Concurrent calls are serialized through a private promise chain, so two
 * read-modify-writes racing across microtasks can never lose an update.
 */

/** The persistence seam. All four methods are async and side-effect only. */
export type OfflineStorage = {
  /** Read a stored string, or `null` for a miss. */
  getItem(key: string): Promise<string | null>;
  /** Insert or overwrite a stored string. */
  setItem(key: string, value: string): Promise<void>;
  /** Drop a stored string; a miss is a no-op. */
  removeItem(key: string): Promise<void>;
  /** Every stored key (order is not significant to the engine). */
  keys(): Promise<string[]>;
};

/**
 * The payload schema version. Bump it whenever the stored envelope shape or the
 * meaning of `value` changes: entries written under any other version are
 * treated as a miss and removed on read.
 */
export const OFFLINE_CACHE_SCHEMA_VERSION = 1;

/** Namespace prefix for every key the engine owns. */
export const OFFLINE_CACHE_PREFIX = "@offline-cache/";

/** Prefix for stored entry envelopes. */
const ENTRY_PREFIX = `${OFFLINE_CACHE_PREFIX}entry/`;

/** The single key holding the pending-mutation replay log. */
const MUTATIONS_KEY = `${OFFLINE_CACHE_PREFIX}mutations`;

/** The storage key an entry is persisted under. */
export function entryStorageKey(key: string): string {
  return `${ENTRY_PREFIX}${key}`;
}

/** Per-entry write options accepted by {@link OfflineCache.put}. */
export type PutMeta = {
  /** Overrides the cache-wide default TTL for this entry. */
  ttlMs?: number;
  /** Explicit size for the LRU byte budget; defaults to the envelope length. */
  sizeBytes?: number;
  /** Free-form labels carried alongside the value. */
  tags?: readonly string[];
};

/** A live entry as returned by {@link OfflineCache.get}. */
export type OfflineCacheEntry<V> = {
  /** The logical key. */
  key: string;
  /** The cached value. */
  value: V;
  /** Unix milliseconds the entry was written. */
  storedAt: number;
  /** Unix milliseconds of this read (the promoted recency). */
  lastAccess: number;
  /** Unix milliseconds the entry goes stale, or `null` for never. */
  expiresAt: number | null;
  /** Whether the entry is at or past its expiry at read time. */
  stale: boolean;
  /** `now - storedAt` at read time. */
  ageMs: number;
  /** The byte size used for the LRU budget. */
  bytes: number;
  /** The meta the entry was written with. */
  meta: PutMeta;
};

/** The outcome of a {@link OfflineCache.put}. */
export type PutResult = {
  /** The logical key. */
  key: string;
  /** Unix milliseconds the entry was written. */
  storedAt: number;
  /** Unix milliseconds the entry goes stale, or `null` for never. */
  expiresAt: number | null;
  /** The byte size recorded for the LRU budget. */
  bytes: number;
  /** Whether an entry already existed under this key. */
  replaced: boolean;
};

/** A mutation admitted to the replay queue. */
export type OfflineMutation = {
  /** Caller-supplied identity, stable across retries. */
  id: string;
  /** Monotonic insertion counter; defines replay order. */
  seq: number;
  /** The verb (`"update"`, `"create"`, `"delete"`, …). */
  kind: string;
  /** The entity the mutation applies to, when it has one. */
  targetId: string | null;
  /** An opaque change payload. */
  payload: unknown;
  /** Caller-supplied creation timestamp (unix ms). */
  createdAt: number;
  /** Failed delivery attempts so far; `0` until the first failure. */
  attempts: number;
};

/** A caller-supplied mutation before the queue assigns `seq` and defaults. */
export type MutationInput = {
  id: string;
  kind: string;
  targetId?: string | null;
  payload?: unknown;
  /** Defaults to the injected `now()`. */
  createdAt?: number;
  /** Defaults to `0`. */
  attempts?: number;
};

/** A deterministic summary of the cache, cheap enough to recompute for a badge. */
export type OfflineCacheStats = {
  /** The current payload schema version. */
  schemaVersion: number;
  /** Number of live entries. */
  entries: number;
  /** Summed entry bytes. */
  bytes: number;
  /** The configured byte budget, or `null` when unbounded. */
  maxBytes: number | null;
  /** Oldest `lastAccess` across entries, or `null` when empty. */
  oldestLastAccess: number | null;
  /** Newest `lastAccess` across entries, or `null` when empty. */
  newestLastAccess: number | null;
  /** How many mutations await delivery. */
  pendingMutations: number;
  /** The default TTL in milliseconds, or `null` when entries never expire. */
  defaultTtlMs: number | null;
};

/** Options accepted by {@link createOfflineCache}. */
export type OfflineCacheOptions = {
  /** The injected clock: returns unix milliseconds. */
  now: () => number;
  /** Byte budget for {@link OfflineCache.evictLRU}; unbounded when omitted. */
  maxBytes?: number;
  /** Default entry TTL in milliseconds; entries never expire when omitted. */
  ttlMs?: number;
};

/** The stored envelope. `expiresAt` is `null` for "never". */
type StoredEnvelope<V> = {
  schemaVersion: number;
  key: string;
  value: V;
  storedAt: number;
  lastAccess: number;
  expiresAt: number | null;
  bytes: number;
  meta: PutMeta;
};

/** A record as read by the bulk operations. */
type LoadedEntry<V> = {
  storageKey: string;
  envelope: StoredEnvelope<V>;
};

/** A plain object check that narrows `unknown` without `any`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The UTF-8 byte length of `text`, without depending on Node's `Buffer`. */
function byteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/** Normalize a `maxBytes` value: a finite integer ≥ 0, else `null` (unbounded). */
function normalizeMaxBytes(maxBytes: number | undefined): number | null {
  if (maxBytes === undefined || !Number.isFinite(maxBytes)) return null;
  return Math.max(0, Math.floor(maxBytes));
}

/**
 * Resolve an expiry from a stored-at time and a ttl. `undefined`/`Infinity`/`NaN`
 * mean "never"; a finite value is clamped to `≥ 0` (so `0` is immediately stale).
 */
function resolveExpiresAt(storedAt: number, ttlMs: number | undefined): number | null {
  if (ttlMs === undefined || !Number.isFinite(ttlMs)) return null;
  return storedAt + Math.max(0, Math.floor(ttlMs));
}

/** Whether an entry with `expiresAt` is stale at `at` (inclusive). */
function isStale(expiresAt: number | null, at: number): boolean {
  return expiresAt !== null && at >= expiresAt;
}

/** Keep only the known meta fields, copying `tags` so callers can't alias it. */
function normalizeMeta(meta: PutMeta): PutMeta {
  const out: PutMeta = {};
  if (meta.ttlMs !== undefined) out.ttlMs = meta.ttlMs;
  if (meta.sizeBytes !== undefined) out.sizeBytes = meta.sizeBytes;
  if (meta.tags !== undefined) out.tags = [...meta.tags];
  return out;
}

/** Parse a stored envelope, or `null` when it is malformed or version-mismatched. */
function parseEnvelope<V>(raw: string, expectedKey: string): StoredEnvelope<V> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.schemaVersion !== OFFLINE_CACHE_SCHEMA_VERSION) return null;
  if (parsed.key !== expectedKey) return null;
  if (!("value" in parsed)) return null;
  if (typeof parsed.storedAt !== "number" || typeof parsed.lastAccess !== "number") return null;
  return {
    schemaVersion: OFFLINE_CACHE_SCHEMA_VERSION,
    key: expectedKey,
    value: parsed.value as V,
    storedAt: parsed.storedAt,
    lastAccess: parsed.lastAccess,
    expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : null,
    bytes: typeof parsed.bytes === "number" ? parsed.bytes : 0,
    meta: isRecord(parsed.meta) ? (parsed.meta as PutMeta) : {},
  };
}

/** Project a stored envelope onto the public {@link OfflineCacheEntry} view. */
function toEntry<V>(
  envelope: StoredEnvelope<V>,
  at: number,
  stale: boolean,
): OfflineCacheEntry<V> {
  return {
    key: envelope.key,
    value: envelope.value,
    storedAt: envelope.storedAt,
    lastAccess: at,
    expiresAt: envelope.expiresAt,
    stale,
    ageMs: Math.max(0, at - envelope.storedAt),
    bytes: envelope.bytes,
    meta: envelope.meta,
  };
}

/** Least-recently-used first: `lastAccess`, then `storedAt`, then key. */
function compareLru<V>(a: LoadedEntry<V>, b: LoadedEntry<V>): number {
  const access = a.envelope.lastAccess - b.envelope.lastAccess;
  if (access !== 0) return access;
  const stored = a.envelope.storedAt - b.envelope.storedAt;
  if (stored !== 0) return stored;
  return a.envelope.key < b.envelope.key ? -1 : a.envelope.key > b.envelope.key ? 1 : 0;
}

/**
 * Create an {@link OfflineStorage} backed by a private `Map` — the deterministic
 * double for tests and a client that wants a session-only cache. `keys()` is
 * sorted, so iteration is reproducible. `initial` is copied in, never aliased.
 */
export function createMemoryStorage(initial: Record<string, string> = {}): OfflineStorage {
  const store = new Map<string, string>();
  for (const key of Object.keys(initial).sort()) {
    store.set(key, initial[key]);
  }
  return {
    async getItem(key) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    async setItem(key, value) {
      store.set(key, value);
    },
    async removeItem(key) {
      store.delete(key);
    },
    async keys() {
      return [...store.keys()].sort();
    },
  };
}

/**
 * An async, storage-backed TTL+LRU cache with a pending-mutation replay queue.
 *
 * Mutable by design, but never reads a clock: the injected `now()` is the only
 * time source. Prefer the {@link createOfflineCache} factory.
 */
export class OfflineCache<V = unknown> {
  private readonly storage: OfflineStorage;
  private readonly clock: () => number;
  private readonly defaultTtlMs: number | undefined;
  private readonly byteLimit: number | null;

  /** Serializes every read-modify-write so concurrent calls cannot lose data. */
  private tail: Promise<void> = Promise.resolve();

  constructor(storage: OfflineStorage, options: OfflineCacheOptions) {
    this.storage = storage;
    this.clock = options.now;
    this.defaultTtlMs = options.ttlMs;
    this.byteLimit = normalizeMaxBytes(options.maxBytes);
  }

  /** Write `value` under `key`, refreshing its expiry and recency. */
  put(key: string, value: V, meta: PutMeta = {}): Promise<PutResult> {
    return this.exclusive(async () => {
      const storedAt = this.now();
      const envelope: StoredEnvelope<V> = {
        schemaVersion: OFFLINE_CACHE_SCHEMA_VERSION,
        key,
        value,
        storedAt,
        lastAccess: storedAt,
        expiresAt: resolveExpiresAt(storedAt, meta.ttlMs ?? this.defaultTtlMs),
        bytes: 0,
        meta: normalizeMeta(meta),
      };
      // Measure the envelope before the (self-referential) `bytes` field is set.
      envelope.bytes =
        meta.sizeBytes !== undefined && Number.isFinite(meta.sizeBytes)
          ? Math.max(0, Math.floor(meta.sizeBytes))
          : byteLength(JSON.stringify(envelope));
      const storageKey = entryStorageKey(key);
      const previous = await this.storage.getItem(storageKey);
      await this.storage.setItem(storageKey, JSON.stringify(envelope));
      return {
        key,
        storedAt,
        expiresAt: envelope.expiresAt,
        bytes: envelope.bytes,
        replaced: previous !== null,
      };
    });
  }

  /** Write many entries, in order. */
  async putMany(entries: readonly { key: string; value: V; meta?: PutMeta }[]): Promise<PutResult[]> {
    const results: PutResult[] = [];
    for (const entry of entries) {
      results.push(await this.put(entry.key, entry.value, entry.meta));
    }
    return results;
  }

  /**
   * Read `key`, promoting its recency. Returns `null` for a miss or a
   * version-mismatched (swept) entry; a stale entry is returned with
   * `stale: true`.
   */
  get(key: string): Promise<OfflineCacheEntry<V> | null> {
    return this.exclusive(async () => {
      const storageKey = entryStorageKey(key);
      const raw = await this.storage.getItem(storageKey);
      if (raw === null) return null;
      const envelope = parseEnvelope<V>(raw, key);
      if (envelope === null) {
        await this.storage.removeItem(storageKey);
        return null;
      }
      const at = this.now();
      const stale = isStale(envelope.expiresAt, at);
      const promoted: StoredEnvelope<V> = { ...envelope, lastAccess: at };
      await this.storage.setItem(storageKey, JSON.stringify(promoted));
      return toEntry(promoted, at, stale);
    });
  }

  /** Read many keys in request order, with `null` for misses. */
  async getMany(keys: readonly string[]): Promise<(OfflineCacheEntry<V> | null)[]> {
    const entries: (OfflineCacheEntry<V> | null)[] = [];
    for (const key of keys) {
      entries.push(await this.get(key));
    }
    return entries;
  }

  /** Remove every entry whose logical key starts with `prefix`; returns them. */
  invalidate(prefix: string): Promise<string[]> {
    return this.exclusive(async () => {
      const storageKeys = await this.storage.keys();
      const removed: string[] = [];
      for (const storageKey of storageKeys) {
        if (!storageKey.startsWith(ENTRY_PREFIX)) continue;
        const logicalKey = storageKey.slice(ENTRY_PREFIX.length);
        if (!logicalKey.startsWith(prefix)) continue;
        await this.storage.removeItem(storageKey);
        removed.push(logicalKey);
      }
      removed.sort();
      return removed;
    });
  }

  /**
   * Trim the least-recently-used entries until the summed `bytes` fit the
   * configured `maxBytes`; returns the evicted keys, least-recent first. A
   * no-op (empty array) for an unbounded cache.
   */
  evictLRU(): Promise<string[]> {
    return this.exclusive(async () => {
      const limit = this.byteLimit;
      if (limit === null) return [];
      const loaded = await this.loadEntries();
      let total = loaded.reduce((sum, entry) => sum + entry.envelope.bytes, 0);
      if (total <= limit) return [];
      const evicted: string[] = [];
      for (const entry of [...loaded].sort(compareLru)) {
        if (total <= limit) break;
        await this.storage.removeItem(entry.storageKey);
        evicted.push(entry.envelope.key);
        total -= entry.envelope.bytes;
      }
      return evicted;
    });
  }

  /** Admit a mutation to the replay queue with a monotonic `seq`. */
  queueMutation(mutation: MutationInput): Promise<OfflineMutation> {
    return this.exclusive(async () => {
      const mutations = await this.readMutations();
      let maxSeq = 0;
      for (const queued of mutations) {
        if (queued.seq > maxSeq) maxSeq = queued.seq;
      }
      const admitted: OfflineMutation = {
        id: mutation.id,
        kind: mutation.kind,
        targetId: mutation.targetId ?? null,
        payload: mutation.payload ?? null,
        createdAt: mutation.createdAt ?? this.now(),
        attempts: mutation.attempts ?? 0,
        seq: maxSeq + 1,
      };
      mutations.push(admitted);
      await this.writeMutations(mutations);
      return admitted;
    });
  }

  /** The queued mutations in replay order (`seq` ascending). */
  pendingMutations(): Promise<OfflineMutation[]> {
    return this.exclusive(() => this.readMutations());
  }

  /** Drop the mutation with `id`; returns whether it was present. */
  markMutationSynced(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      const mutations = await this.readMutations();
      const remaining = mutations.filter((mutation) => mutation.id !== id);
      if (remaining.length === mutations.length) return false;
      await this.writeMutations(remaining);
      return true;
    });
  }

  /** A deterministic summary of entries and the pending queue. */
  stats(): Promise<OfflineCacheStats> {
    return this.exclusive(async () => {
      const loaded = await this.loadEntries();
      let bytes = 0;
      let oldest: number | null = null;
      let newest: number | null = null;
      for (const entry of loaded) {
        bytes += entry.envelope.bytes;
        const access = entry.envelope.lastAccess;
        if (oldest === null || access < oldest) oldest = access;
        if (newest === null || access > newest) newest = access;
      }
      const mutations = await this.readMutations();
      return {
        schemaVersion: OFFLINE_CACHE_SCHEMA_VERSION,
        entries: loaded.length,
        bytes,
        maxBytes: this.byteLimit,
        oldestLastAccess: oldest,
        newestLastAccess: newest,
        pendingMutations: mutations.length,
        defaultTtlMs:
          this.defaultTtlMs !== undefined && Number.isFinite(this.defaultTtlMs)
            ? this.defaultTtlMs
            : null,
      };
    });
  }

  /** The injected clock, normalized to a finite integer. */
  private now(): number {
    const at = this.clock();
    return Number.isFinite(at) ? Math.floor(at) : 0;
  }

  /** Run `task` after every previously queued task, whatever their outcome. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Read and parse every live entry, sweeping malformed/mismatched records. */
  private async loadEntries(): Promise<LoadedEntry<V>[]> {
    const storageKeys = await this.storage.keys();
    const loaded: LoadedEntry<V>[] = [];
    for (const storageKey of storageKeys) {
      if (!storageKey.startsWith(ENTRY_PREFIX)) continue;
      const logicalKey = storageKey.slice(ENTRY_PREFIX.length);
      const raw = await this.storage.getItem(storageKey);
      if (raw === null) continue;
      const envelope = parseEnvelope<V>(raw, logicalKey);
      if (envelope === null) {
        await this.storage.removeItem(storageKey);
        continue;
      }
      loaded.push({ storageKey, envelope });
    }
    return loaded;
  }

  /** Read the replay log in order, treating malformed/mismatched data as empty. */
  private async readMutations(): Promise<OfflineMutation[]> {
    const raw = await this.storage.getItem(MUTATIONS_KEY);
    if (raw === null) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.storage.removeItem(MUTATIONS_KEY);
      return [];
    }
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== OFFLINE_CACHE_SCHEMA_VERSION ||
      !Array.isArray(parsed.mutations)
    ) {
      await this.storage.removeItem(MUTATIONS_KEY);
      return [];
    }
    return [...(parsed.mutations as OfflineMutation[])].sort((a, b) => a.seq - b.seq);
  }

  /** Persist the replay log under the current schema version. */
  private async writeMutations(mutations: OfflineMutation[]): Promise<void> {
    await this.storage.setItem(
      MUTATIONS_KEY,
      JSON.stringify({ schemaVersion: OFFLINE_CACHE_SCHEMA_VERSION, mutations }),
    );
  }
}

/** Create an empty {@link OfflineCache} over `storage`. */
export function createOfflineCache<V = unknown>(
  storage: OfflineStorage,
  options: OfflineCacheOptions,
): OfflineCache<V> {
  return new OfflineCache<V>(storage, options);
}
