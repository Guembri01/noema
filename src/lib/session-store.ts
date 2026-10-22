import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * B54 — the session registry: bookkeeping for stateless JWT sessions.
 *
 * Sessions themselves stay HS256 JWTs in the `noema_session` cookie
 * (src/lib/auth.ts); this module keeps the record that makes them *manageable*
 * — a `sid` claim maps to a record here, which is what the security settings
 * UI lists and revokes (matrix §17 "Session management").
 *
 * Storage is a small JSON file with atomic rename writes (`.data/sessions.json`
 * by default, `SESSION_STORE_PATH` override), because B54 must not change the
 * prisma schema — the spec deferred the `Session` table (D28.2/O28.2). Dev
 * :3201 and prod :3200 may share the file on one host; the lock below keeps
 * their read-modify-write cycles from dropping each other's record update.
 * This is still a single-host store, not a multi-host database.
 *
 * Reads are fail-closed for the **request path**: a missing or corrupt file
 * yields "no sessions", and `getSessionUserId` rejects a token that carries a
 * `sid` when the registry cannot prove the session is live. Tokens without a
 * `sid` (legacy cookies issued before the registry existed) keep working until
 * their own 30-day expiry. A broken registry must not silently turn revocation
 * off.
 *
 * Writes take an on-disk lock around the read-modify-write cycle and publish
 * with an atomic rename, so two server processes sharing the store cannot drop
 * each other's record update. A stale lock left by a crash is reclaimed after
 * `LOCK_STALE_MS`.
 *
 * §17 deepening (session management row): on top of the B54 list/revoke
 * primitives this module adds `validateSession` (fail-closed: a revoked or
 * expired token is rejected even though the record still exists),
 * `listSessionsForUser` (active-only panel view with a `current` flag),
 * `revokeSession` (unscoped revoke for trusted server-side paths), and sliding
 * expiry via `touchSession(sid, now, { maxLifetimeMs })` — activity extends a
 * session's deadline, but never past the absolute `createdAt + maxLifetimeMs`
 * cap, so a session cannot be kept alive forever. All new time-dependent
 * logic takes an injected `now` (ms since epoch) for determinism; the
 * wall-clock defaults exist only for the legacy no-argument call shapes.
 *
 * B39 — the same policy (`{ idleTimeoutMs, maxLifetimeMs }`) also drives the
 * deadline `validateSession` enforces, so the request path can ask "is this
 * session still alive?" with the very policy that `touchSession` slides on
 * activity: a session that saw no activity for `idleTimeoutMs` is dead, even
 * when its stored `expiresAt` is still in the future (a row written before
 * sliding expiry existed has none), and no session outlives
 * `createdAt + maxLifetimeMs`.
 */

export type SessionRecord = {
  sid: string;
  userId: string;
  /** Rendered by the settings UI; null when the user-agent was unknown. */
  device: string | null;
  createdAt: string;
  lastActiveAt: string;
  /**
   * Sliding expiry deadline (ISO). Absent on records written before sliding
   * expiry existed → falls back to the fixed createdAt + SESSION_TTL_MS
   * window, so legacy rows keep their original semantics.
   */
  expiresAt?: string;
  revokedAt: string | null;
};

/** Mirrors SESSION_DAYS in src/lib/auth.ts — expired records are pruned. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * A revoked row lives as long as its token can be replayed.
 *
 * B129: the row used to be dropped a week after the revocation. The token of
 * the session lives 30 days, and the request path used to treat an **unknown**
 * sid as a legacy session — so a revoked session that was forgotten by the
 * registry was accepted again, for the rest of the token's life. The request
 * path now rejects an unknown sid too, and the retention still outlives the
 * token: both halves keep "revoked" equal to "revoked".
 */
const REVOKED_RETENTION_MS = SESSION_TTL_MS;
/** lastActiveAt rewrites are throttled to one per minute per session. */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * A lock file older than this is treated as a crash leftover. Writes are a
 * few milliseconds, so a live writer never holds it anywhere near this long.
 */
const LOCK_STALE_MS = 30_000;
const LOCK_ATTEMPTS = 200;
const LOCK_RETRY_MS = 10;

export function storePath(): string {
  return process.env.SESSION_STORE_PATH || join(process.cwd(), ".data", "sessions.json");
}

function isRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sid === "string" &&
    typeof record.userId === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.lastActiveAt === "string" &&
    // Optional on pre-sliding rows; validated by shape when present.
    (record.expiresAt === undefined || typeof record.expiresAt === "string") &&
    (record.revokedAt === null || typeof record.revokedAt === "string") &&
    (record.device === null || typeof record.device === "string")
  );
}

export type SessionStoreStatus = "ok" | "missing" | "corrupt";
type StoreRead = { records: SessionRecord[]; status: SessionStoreStatus };

function readAllWithStatus(): StoreRead {
  let raw: string;
  try {
    raw = readFileSync(storePath(), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { records: [], status: code === "ENOENT" ? "missing" : "corrupt" };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { records: [], status: "corrupt" };
    return { records: parsed.filter(isRecord), status: "ok" };
  } catch {
    return { records: [], status: "corrupt" };
  }
}

function readAll(): SessionRecord[] {
  return readAllWithStatus().records;
}

/**
 * Whether the registry can currently prove a session's state. The request path
 * uses this to distinguish "no such session in a healthy registry" (reject)
 * from a registry that is missing or unreadable (also reject — fail closed).
 */
export function sessionStoreStatus(): SessionStoreStatus {
  return readAllWithStatus().status;
}


/**
 * Set a mode, but never let it stop a write.
 *
 * A filesystem without Unix permissions (a FAT stick, a network mount) answers
 * `EPERM`, and a directory that belongs to somebody else cannot be changed at
 * all. Neither is a reason to stop writing sessions — the mode is best effort,
 * and where the filesystem supports permissions the file is owner-only.
 */
function restrict(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[noema] could not set the mode of ${path}: ${reason}`);
  }
}

function writeAll(records: SessionRecord[]): void {
  const file = storePath();
  const dir = dirname(file);
  // The registry names the devices that are signed in: owner-only, like the
  // rest of the app's data. The desktop app puts the store next to the
  // database, and the umask's 0755/0644 would let every user on the machine
  // read it. `mkdir` only sets the mode of the directories it creates, so the
  // mode is enforced afterwards — a store from an older version keeps its old
  // mode otherwise.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  restrict(dir, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(records), { encoding: "utf8", mode: 0o600 });
  // A leftover file from an earlier run keeps its old mode; the rename below
  // publishes whatever this file is.
  restrict(tmp, 0o600);
  renameSync(tmp, file); // atomic: readers never see a half-written file
}

/** Sleep without a busy loop; the store is synchronous by design. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Acquire the process-shared lock file. `wx` is atomic: exactly one writer
 * creates it. A lock older than `LOCK_STALE_MS` is a crash leftover and is
 * removed so a dead process cannot block sign-in forever.
 */
function acquireLock(file: string): number {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      return openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
      } catch {
        // The owner removed it between `stat` and `unlink`; retry normally.
      }
      sleep(LOCK_RETRY_MS);
    }
  }
  throw new Error(`Session store lock timed out: ${lock}`);
}

function withStoreLock<T>(fn: () => T): T {
  const file = storePath();
  const fd = acquireLock(file);
  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Best effort: the lock file is unlinked below.
    }
    try {
      unlinkSync(`${file}.lock`);
    } catch {
      // Another writer may have reclaimed a stale lock already.
    }
  }
}

/**
 * The read-modify-write cycle runs under the lock: without it two live servers
 * sharing the file could both read the same list and one update would vanish.
 */
function mutate(fn: (records: SessionRecord[]) => SessionRecord[]): void {
  withStoreLock(() => writeAll(fn(readAll())));
}

/**
 * When a session stops being valid, in ms since epoch: the slid `expiresAt`
 * when present, else the fixed createdAt + SESSION_TTL_MS window that legacy
 * records rely on. An unparseable createdAt (corrupt row) yields -Infinity so
 * every expiry comparison treats the session as already over — corruption
 * fails closed, never open.
 */
function effectiveExpiryMs(record: SessionRecord): number {
  if (record.expiresAt) {
    const slid = Date.parse(record.expiresAt);
    if (Number.isFinite(slid)) return slid;
  }
  const created = Date.parse(record.createdAt);
  return Number.isFinite(created) ? created + SESSION_TTL_MS : Number.NEGATIVE_INFINITY;
}

/**
 * The deadline of a record under a session policy: the stored `expiresAt`
 * (or the legacy fixed window), clipped to the idle window measured from the
 * last activity and to the absolute cap measured from the creation.
 *
 * Without a policy only the stored deadline counts — the legacy behaviour.
 * With one, an idle session dies even when its stored deadline is still in
 * the future, and a session never outlives `createdAt + maxLifetimeMs`.
 * An unparseable `lastActiveAt` / `createdAt` fails closed (-Infinity).
 */
function deadlineMs(record: SessionRecord, options: TouchOptions): number {
  let deadline = effectiveExpiryMs(record);
  if (options.idleTimeoutMs !== undefined) {
    const last = Date.parse(record.lastActiveAt);
    deadline = Math.min(
      deadline,
      Number.isFinite(last) ? last + options.idleTimeoutMs : Number.NEGATIVE_INFINITY,
    );
  }
  if (options.maxLifetimeMs !== undefined) {
    const created = Date.parse(record.createdAt);
    deadline = Math.min(
      deadline,
      Number.isFinite(created) ? created + options.maxLifetimeMs : Number.NEGATIVE_INFINITY,
    );
  }
  return deadline;
}

/** Drop records that outlived their session deadline (or revocation retention). */
function prune(records: SessionRecord[], nowMs: number): SessionRecord[] {
  return records.filter((record) => {
    // Keep an idle-expired record until its absolute lifetime is over, so the
    // settings view can still show the session that died and an unknown sid
    // never has to stand in for it. The request path rejects the record via
    // `validateSession`'s deadline check either way.
    const created = Date.parse(record.createdAt);
    const absolute = Number.isFinite(created) ? created + SESSION_TTL_MS : Number.NEGATIVE_INFINITY;
    if (absolute <= nowMs) return false;
    if (record.revokedAt && nowMs - Date.parse(record.revokedAt) > REVOKED_RETENTION_MS) {
      return false;
    }
    return true;
  });
}

/** Register a freshly issued session; returns the record (with its sid). */
export function registerSession(input: {
  userId: string;
  device: string | null;
  /** Injected clock (ms since epoch); defaults to the wall clock. */
  now?: number;
}): SessionRecord {
  const at = input.now ?? Date.now();
  const now = new Date(at).toISOString();
  const record: SessionRecord = {
    sid: randomUUID(),
    userId: input.userId,
    device: input.device,
    createdAt: now,
    lastActiveAt: now,
    revokedAt: null,
  };
  mutate((records) => [...prune(records, at), record]);
  return record;
}

export function findSession(sid: string): SessionRecord | null {
  return readAll().find((record) => record.sid === sid) ?? null;
}

/**
 * Revocation flag of a session. Unknown sid → false (fail open by design: this
 * is a status probe, not an authentication gate).
 *
 * The request path uses `validateSession` instead — it also knows the deadline,
 * so a revoked-but-unexpired *and* an expired-but-unrevoked session are both
 * rejected, and an unknown sid is rejected rather than treated as legacy.
 */
export function isSessionRevoked(sid: string): boolean {
  const record = findSession(sid);
  return record !== null && record.revokedAt !== null;
}

/**
 * Strict validation for callers that can tolerate a registry outage being a
 * hard failure: the record must exist, be unrevoked, and be unexpired at the
 * injected `now`. Fail CLOSED on every one of those — a revoked-but-unexpired
 * token is rejected even though the record (and the JWT) is still "live".
 * (A caller that cannot tolerate that may probe `isSessionRevoked` instead,
 * which fails OPEN for an unknown sid.)
 *
 * B39: with a policy (`idleTimeoutMs` / `maxLifetimeMs`) the session must
 * also be inside its idle window and its absolute lifetime — the deadline
 * `touchSession` slides on activity. Without a policy only the stored
 * deadline counts.
 */
export function validateSession(
  sid: string,
  now: number,
  options: TouchOptions = {},
): SessionRecord | null {
  const record = findSession(sid);
  if (!record || record.revokedAt) return null;
  if (deadlineMs(record, options) <= now) return null;
  return record;
}

export type TouchResult =
  | { status: "extended"; expiresAt: string }
  | { status: "throttled" }
  | { status: "not-found" }
  | { status: "revoked" }
  | { status: "expired" };

export type TouchOptions = {
  /**
   * Idle window granted from `now` on a touch. Default: SESSION_TTL_MS.
   *
   * B39: the same window is the *idle timeout* of the session — the deadline
   * `validateSession` enforces, measured from the last activity.
   */
  idleTimeoutMs?: number;
  /**
   * Absolute lifetime measured from createdAt: the deadline is clipped to
   * createdAt + maxLifetimeMs, so sliding expiry cannot keep a session alive
   * forever. Default: SESSION_TTL_MS (i.e. no extension past the original
   * fixed window — existing expiry semantics unless a caller opts in).
   */
  maxLifetimeMs?: number;
};

/**
 * Bump lastActiveAt (throttled to one write per minute per session) and, when
 * an injected `now` is given, slide the session's expiry: the new deadline is
 * min(now + idleTimeoutMs, createdAt + maxLifetimeMs). Fail closed: revoked,
 * expired, and unknown sessions are never touched, so activity can't
 * resurrect them. Without `now` the legacy wall-clock behavior applies.
 *
 * B39: the "expired" verdict is taken under the same policy
 * (`idleTimeoutMs` / `maxLifetimeMs`) that the write slides, so a session
 * that saw no activity for `idleTimeoutMs` is reported as expired even when
 * its stored deadline is still in the future.
 */
export function touchSession(
  sid: string,
  now?: number,
  options: TouchOptions = {},
): TouchResult {
  const at = now ?? Date.now();
  const record = findSession(sid);
  if (!record) return { status: "not-found" };
  if (record.revokedAt) return { status: "revoked" };
  if (deadlineMs(record, options) <= at) return { status: "expired" };
  if (at - Date.parse(record.lastActiveAt) < TOUCH_INTERVAL_MS) return { status: "throttled" };
  const idle = options.idleTimeoutMs ?? SESSION_TTL_MS;
  const cap = options.maxLifetimeMs ?? SESSION_TTL_MS;
  const deadline = Math.min(at + idle, Date.parse(record.createdAt) + cap);
  const iso = new Date(at).toISOString();
  const expiresAt = new Date(deadline).toISOString();
  mutate((records) =>
    records.map((entry) =>
      entry.sid === sid ? { ...entry, lastActiveAt: iso, expiresAt } : entry,
    ),
  );
  return { status: "extended", expiresAt };
}

/** Active sessions of one user, most recently active first. */
export function listActiveSessions(userId: string): SessionRecord[] {
  return readAll()
    .filter((record) => record.userId === userId && !record.revokedAt)
    .sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
}

export type ListedSession = SessionRecord & { current: boolean };

/**
 * Panel view for a "Sessions" settings page: the user's sessions that are
 * still valid at the injected `now` (revoked and expired ones excluded),
 * most recently active first, each carrying a `current` flag for the
 * caller-supplied sid of the requesting device.
 */
export function listSessionsForUser(
  userId: string,
  now: number,
  options: { currentSid?: string | null } = {},
): ListedSession[] {
  return readAll()
    .filter(
      (record) =>
        record.userId === userId && !record.revokedAt && effectiveExpiryMs(record) > now,
    )
    .sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt))
    .map((record) => ({ ...record, current: record.sid === options.currentSid }));
}

/**
 * Revoke a session by sid alone — for trusted server-side paths that have
 * already established ownership (e.g. forced sign-out). The request path must
 * keep using the owner-scoped `revokeSessionForUser` guard below.
 */
export function revokeSession(sid: string, now?: number): "revoked" | "not-found" {
  const record = findSession(sid);
  if (!record || record.revokedAt) return "not-found";
  const iso = new Date(now ?? Date.now()).toISOString();
  mutate((records) =>
    records.map((entry) => (entry.sid === sid ? { ...entry, revokedAt: iso } : entry)),
  );
  return "revoked";
}

export type RevokeOutcome = "revoked" | "not-found" | "forbidden";

/** Revoke one session — only its owner may do it (B54 owner-of-session guard). */
export function revokeSessionForUser(
  sid: string,
  userId: string,
  now?: number,
): RevokeOutcome {
  const record = findSession(sid);
  if (!record || record.revokedAt) return "not-found";
  if (record.userId !== userId) return "forbidden";
  const iso = new Date(now ?? Date.now()).toISOString();
  mutate((records) =>
    records.map((entry) => (entry.sid === sid ? { ...entry, revokedAt: iso } : entry)),
  );
  return "revoked";
}

/**
 * Revoke every active session of a user (sign out everywhere), optionally
 * keeping the calling device. Returns how many sessions were ended.
 */
export function revokeAllSessionsForUser(
  userId: string,
  options: { exceptSid?: string; now?: number } = {},
): number {
  const iso = new Date(options.now ?? Date.now()).toISOString();
  let revoked = 0;
  mutate((records) =>
    records.map((record) => {
      if (record.userId !== userId || record.revokedAt) return record;
      if (options.exceptSid && record.sid === options.exceptSid) return record;
      revoked += 1;
      return { ...record, revokedAt: iso };
    }),
  );
  return revoked;
}

/**
 * Best-effort device label for the security settings list: "Chrome on Windows".
 * Returns null when there is nothing to describe (no/blank user-agent).
 */
export function describeDevice(userAgent: string | null | undefined): string | null {
  if (!userAgent || !userAgent.trim()) return null;

  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Chrome\//.test(userAgent)
          ? "Chrome"
          : /Version\/[\d.]+ .*Safari\//.test(userAgent)
            ? "Safari"
            : /\bcurl\//.test(userAgent)
              ? "curl"
              : null;

  // Order matters: Android UAs embed "Linux", iOS UAs embed "Mac OS X".
  const os = /Windows NT/.test(userAgent)
    ? "Windows"
    : /Android/.test(userAgent)
      ? "Android"
      : /iPhone|iPad|iPod/.test(userAgent)
        ? "iOS"
        : /Mac OS X/.test(userAgent)
          ? "macOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : null;

  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? null;
}