/**
 * Backup manifest (F5) — the pure, deterministic core.
 *
 * A backup is a set of files; a manifest is the small, self-describing record
 * of what that set contained — one entry per file (path, size, content
 * checksum, kind) plus the aggregate totals. This module owns every decision
 * that must be provable without touching the filesystem, the network or the
 * DB: hashing content, building a path-sorted manifest, verifying it against
 * the files on hand, and merging several manifests into one.
 *
 * Everything is immutable: no function mutates its arguments, and each returns
 * fresh arrays/objects. `now` is injectable so a manifest is reproducible in a
 * test. Checksums use FNV-1a (32-bit) over UTF-8 bytes — tiny, dependency-free
 * and stable across platforms, so there is no crypto import to satisfy.
 */

/** A single file recorded in a manifest. */
export type BackupManifestEntry = {
  /** Relative, POSIX-style path within the backup. */
  path: string;
  /** Size of the entry's content, in bytes. */
  bytes: number;
  /** Deterministic content checksum (see `checksum`). */
  checksum: string;
  /** What the entry is, e.g. "page" | "database" | "attachment" | "file". */
  kind: string;
};

/** A complete description of a backup's contents. */
export type BackupManifest = {
  /** Manifest format version, bumped when the shape changes. */
  version: number;
  /** ISO-8601 timestamp of when the manifest was built. */
  createdAt: string;
  /** One entry per file, sorted by `path`. */
  entries: BackupManifestEntry[];
  /** Sum of every entry's `bytes`. */
  totalBytes: number;
  /** Number of entries (`entries.length`). */
  count: number;
};

/** A file to describe: text or raw bytes, plus an optional kind label. */
export type BackupSourceFile = {
  path: string;
  content: string | Uint8Array;
  kind?: string;
};

/** Options for `buildManifest`; `now` is injectable for deterministic tests. */
export type BuildManifestOptions = {
  /** Epoch millis or a `Date`; defaults to the current time. */
  now?: Date | number;
};

/** One file whose on-disk content no longer matches its manifest entry. */
export type ManifestMismatch = {
  path: string;
  expectedBytes: number;
  actualBytes: number;
  expectedChecksum: string;
  actualChecksum: string;
};

/** The result of checking a manifest against a set of files. */
export type ManifestVerification = {
  /** True only when there are no mismatches, missing or extra files. */
  ok: boolean;
  /** Entries present in both but whose bytes/checksum differ. */
  mismatches: ManifestMismatch[];
  /** Manifest paths with no matching file. */
  missing: string[];
  /** File paths absent from the manifest. */
  extra: string[];
};

/** Current manifest format version. */
export const BACKUP_MANIFEST_VERSION = 1;

/** Kind recorded for a file that does not declare one. */
export const DEFAULT_ENTRY_KIND = "file";

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const encoder = new TextEncoder();

/** Normalise declared content to bytes (UTF-8 for text). */
function toBytes(content: string | Uint8Array): Uint8Array {
  if (typeof content === "string") return encoder.encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(0);
}

/**
 * FNV-1a (32-bit) over bytes, as 8 lowercase hex characters (zero-padded).
 * Chosen because it is tiny, dependency-free and spreads short, similar inputs
 * far better than a naive length/char sum while staying fully deterministic.
 */
function fnv1aHex(bytes: Uint8Array): string {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Deterministic checksum of text or raw bytes. Text is hashed as its UTF-8
 * bytes, so `checksum("abc") === checksum(new TextEncoder().encode("abc"))`
 * and the same input always yields the same hex string on every platform.
 */
export function checksum(input: string | Uint8Array): string {
  return fnv1aHex(toBytes(input));
}

/** Build one manifest entry from a source file. */
function entryFor(file: BackupSourceFile): BackupManifestEntry {
  const bytes = toBytes(file.content);
  return {
    path: file.path,
    bytes: bytes.byteLength,
    checksum: fnv1aHex(bytes),
    kind: file.kind ?? DEFAULT_ENTRY_KIND,
  };
}

/** Path-ascending comparator shared by every sorted output. */
function byPath(a: { path: string }, b: { path: string }): number {
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}

/** Resolve an injectable `now` (Date, epoch millis, or undefined) to an ISO string. */
function toIso(now: Date | number | undefined): string {
  const date = now instanceof Date ? now : new Date(typeof now === "number" ? now : Date.now());
  return date.toISOString();
}

/**
 * Describe a set of files: one entry per file, sorted by `path` (stably — equal
 * paths keep their input order), with the summed `totalBytes` and `count`.
 * The input array and its files are never mutated; each entry is a fresh object.
 */
export function buildManifest(
  files: readonly BackupSourceFile[],
  options?: BuildManifestOptions,
): BackupManifest {
  const list = Array.isArray(files) ? files : [];
  const entries = list.map(entryFor).sort(byPath);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  return {
    version: BACKUP_MANIFEST_VERSION,
    createdAt: toIso(options?.now),
    entries,
    totalBytes,
    count: entries.length,
  };
}

/**
 * Check a manifest against the files on hand, three ways:
 *
 * - `mismatches` — an entry exists in both, but the bytes or checksum differ;
 * - `missing` — the manifest names a path with no matching file;
 * - `extra` — a file exists that the manifest never recorded.
 *
 * Every report is sorted by path so two callers always see the same order, and
 * `ok` is true only when all three are empty. Inputs are not mutated.
 */
export function verifyManifest(
  manifest: BackupManifest,
  files: readonly BackupSourceFile[],
): ManifestVerification {
  const list = Array.isArray(files) ? files : [];
  const byPathMap = new Map<string, BackupSourceFile>();
  for (const file of list) byPathMap.set(file.path, file);

  const mismatches: ManifestMismatch[] = [];
  const missing: string[] = [];
  const recorded = new Set<string>();

  for (const entry of manifest?.entries ?? []) {
    recorded.add(entry.path);
    const file = byPathMap.get(entry.path);
    if (file === undefined) {
      missing.push(entry.path);
      continue;
    }
    const actual = entryFor(file);
    if (actual.bytes !== entry.bytes || actual.checksum !== entry.checksum) {
      mismatches.push({
        path: entry.path,
        expectedBytes: entry.bytes,
        actualBytes: actual.bytes,
        expectedChecksum: entry.checksum,
        actualChecksum: actual.checksum,
      });
    }
  }

  const extra: string[] = [];
  for (const file of list) {
    if (!recorded.has(file.path)) extra.push(file.path);
  }

  mismatches.sort(byPath);
  missing.sort();
  extra.sort();

  return {
    ok: mismatches.length === 0 && missing.length === 0 && extra.length === 0,
    mismatches,
    missing,
    extra,
  };
}

/**
 * Merge several manifests into one: entries are unioned by `path`, with a later
 * manifest winning for a shared path (the newest backup describes that file).
 * The result is re-sorted by path and its totals recomputed; `createdAt` is the
 * newest input and `version` the highest. Inputs are never mutated.
 */
export function mergeManifests(manifests: readonly BackupManifest[]): BackupManifest {
  const list = Array.isArray(manifests) ? manifests : [];
  const merged = new Map<string, BackupManifestEntry>();
  let version = BACKUP_MANIFEST_VERSION;
  let createdAt = "";

  for (const manifest of list) {
    if (!manifest) continue;
    if (typeof manifest.version === "number" && manifest.version > version) {
      version = manifest.version;
    }
    if (typeof manifest.createdAt === "string" && manifest.createdAt > createdAt) {
      createdAt = manifest.createdAt;
    }
    for (const entry of manifest.entries ?? []) {
      merged.set(entry.path, { ...entry });
    }
  }

  const entries = [...merged.values()].sort(byPath);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  return { version, createdAt, entries, totalBytes, count: entries.length };
}
