import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
 * prisma schema — the spec deferred the `Session` table (D28.2/O28.2). One
 * writer process per file is the design point: dev :3201 and prod :3200 share
 * the file, and a simultaneous write from two live servers can drop the slower
 * record update (accepted for now).
 *
 * Reads fail OPEN: a missing or corrupt file yields "no sessions", never an
 * auth outage — a broken registry must not lock every device out.
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
/** Revoked rows linger a week so "recently revoked" stays observable in logs. */
const REVOKED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** lastActiveAt rewrites are throttled to one per minute per session. */
const TOUCH_INTERVAL_MS = 60_000;

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

function readAll(): SessionRecord[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(storePath(), "utf8"));
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    return []; // missing or corrupt → empty (fail open)
  }
}

function writeAll(records: SessionRecord[]): void {
  const file = storePath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(records), "utf8");
  renameSync(tmp, file); // atomic: readers never see a half-written file
}

function mutate(fn: (records: SessionRecord[]) => SessionRecord[]): void {
  writeAll(fn(readAll()));
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
    if (effectiveExpiryMs(record) <= nowMs) return false;
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
 * Revocation flag of a session. Unknown sid → false (fail open).
 *
 * B39: the request path asks `validateSession` instead — it also knows the
 * deadline, so a revoked-but-unexpired *and* an expired-but-unrevoked
 * session are both rejected.
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