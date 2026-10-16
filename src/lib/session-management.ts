import { randomUUID } from "node:crypto";

/**
 * §17 Session management — the pure session lifecycle engine.
 *
 * This module is the deterministic core behind a "where you're signed in"
 * device list and a "sign out everywhere" action. It does not store anything
 * and touches no clock, filesystem, network or DB: a `SessionRecord` is a
 * plain value and every function is either a predicate or a value → value
 * transform, so the same inputs always produce the same outputs. The I/O-
 * backed registry that persists these records is a separate concern
 * (`src/lib/session-store.ts`); this engine only decides what a record *means*.
 *
 * Lifecycle in one line: `createSession` mints a record, `isActive` evaluates
 * it (revocation + expiry + idle timeout, failing closed on corrupt dates),
 * `touchSession` slides its expiry forward — never past `createdAt +
 * maxLifetimeMs` — `revokeSession` / `revokeAllForUser` end it, `pruneExpired`
 * drops dead rows, `activeSessions` filters, `describeSession` renders it for
 * the UI and `needsRotation` flags a credential that has lived long enough to
 * be worth rotating.
 *
 * Traceability: R28.12–R28.16 (§4.3 sessions & revocation of
 * `docs/specs/engineering-hardening.md`). Time is always injected as an
 * epoch-millisecond number, an ISO-8601 string or a `Date`; the engine never
 * mutates its inputs.
 */

/** Any accepted clock input; normalised to epoch milliseconds internally. */
export type TimeInput = number | string | Date;

/**
 * One session, as seen by the engine.
 *
 * The first six fields are the identity/lifetime core; `revokedAt`, `userAgent`
 * and `ip` are optional metadata. `revokedReason`, `idleTimeoutMs` and
 * `maxLifetimeMs` are additive policy/diagnostics carried on the record so the
 * two-argument predicates (`isActive`, `touchSession`) stay self-describing:
 *
 *  - `idleTimeoutMs` — inactivity window measured from `lastSeenAt`; when
 *    absent, only `expiresAt` governs. Defaults to `ttlMs` on creation.
 *  - `maxLifetimeMs` — absolute lifetime measured from `createdAt`; sliding
 *    expiry can never move `expiresAt` past this cap. Defaults to `ttlMs`.
 *  - `revokedReason` — the free-text reason recorded by the first revocation;
 *    a later revocation never overwrites it (revocation is idempotent).
 */
export type SessionRecord = {
  id: string;
  userId: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601; bumped by `touchSession`. */
  lastSeenAt: string;
  /** ISO-8601; the deadline `isActive` enforces. */
  expiresAt: string;
  /** ISO-8601; present once the session has been revoked. */
  revokedAt?: string;
  /** User-agent string the session was issued with, for `describeSession`. */
  userAgent?: string;
  /** Originating IP, for `describeSession`. */
  ip?: string;
  /** Reason recorded by the first revocation. */
  revokedReason?: string;
  /** Inactivity window from `lastSeenAt`; absent means "no idle timeout". */
  idleTimeoutMs?: number;
  /** Absolute cap from `createdAt` for sliding expiry. */
  maxLifetimeMs?: number;
};

/** Input to `createSession`: the caller supplies the clock and the TTL. */
export type CreateSessionInput = {
  userId: string;
  now: TimeInput;
  /** Session lifetime in ms; also the default idle window and absolute cap. */
  ttlMs: number;
  /** Stable id, injectable for determinism/tests; a random UUID otherwise. */
  id?: string;
  userAgent?: string;
  ip?: string;
  /** Overrides the default idle window (`ttlMs`). */
  idleTimeoutMs?: number;
  /** Overrides the default absolute cap (`ttlMs`). */
  maxLifetimeMs?: number;
};

/** A human-facing view of a session for a device list (`describeSession`). */
export type SessionDescription = {
  id: string;
  /** "Chrome on Windows", or a partial/`null` when the agent is unreadable. */
  device: string | null;
  browser: string | null;
  platform: string | null;
  ip: string | null;
  status: "active" | "idle" | "expired" | "revoked";
  /** Relative age since `createdAt`, e.g. "3 days ago". */
  age: string;
  /** Age in ms since `createdAt`, clamped to ≥ 0. */
  ageMs: number;
  /** Relative time since `lastSeenAt`, e.g. "2 minutes ago". */
  lastSeen: string;
  /** Idle time in ms since `lastSeenAt`, clamped to ≥ 0. */
  idleMs: number;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Normalise any `TimeInput` to epoch ms; a bad value is a programming error. */
function asMillis(input: TimeInput, label = "now"): number {
  const ms =
    typeof input === "number"
      ? input
      : input instanceof Date
        ? input.getTime()
        : Date.parse(input);
  if (!Number.isFinite(ms)) {
    throw new RangeError(`Invalid ${label}: ${String(input)}`);
  }
  return ms;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** A relative-time phrase for a non-negative duration in ms. */
function ago(ms: number): string {
  if (!Number.isFinite(ms) || ms < 45_000) return "just now";
  if (ms < 90_000) return "a minute ago";
  if (ms < 45 * MINUTE) return `${Math.round(ms / MINUTE)} minutes ago`;
  if (ms < 90 * MINUTE) return "an hour ago";
  if (ms < 22 * HOUR) return `${Math.round(ms / HOUR)} hours ago`;
  if (ms < 36 * HOUR) return "a day ago";
  if (ms < 25 * DAY) return `${Math.round(ms / DAY)} days ago`;
  if (ms < 45 * DAY) return "a month ago";
  if (ms < 320 * DAY) return `${Math.round(ms / (30 * DAY))} months ago`;
  if (ms < 548 * DAY) return "a year ago";
  return `${Math.round(ms / (365 * DAY))} years ago`;
}

/** Browser + platform best-effort extraction; each part is `null` if unknown. */
function parseUserAgent(userAgent: string | undefined): {
  browser: string | null;
  platform: string | null;
} {
  if (!userAgent || !userAgent.trim()) return { browser: null, platform: null };

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
  const platform = /Windows NT/.test(userAgent)
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

  return { browser, platform };
}

/**
 * Mint a session record. `createdAt` and `lastSeenAt` are `now`; `expiresAt`
 * is `now + ttlMs`. The idle window and absolute cap default to `ttlMs`, so a
 * record only slides beyond its first deadline when the caller opts in with a
 * larger `maxLifetimeMs`. Throws on a non-positive/non-finite `ttlMs`.
 */
export function createSession(input: CreateSessionInput): SessionRecord {
  const at = asMillis(input.now);
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
    throw new RangeError("ttlMs must be a positive, finite number");
  }
  const record: SessionRecord = {
    id: input.id ?? randomUUID(),
    userId: input.userId,
    createdAt: iso(at),
    lastSeenAt: iso(at),
    expiresAt: iso(at + input.ttlMs),
    idleTimeoutMs: input.idleTimeoutMs ?? input.ttlMs,
    maxLifetimeMs: input.maxLifetimeMs ?? input.ttlMs,
  };
  if (input.userAgent !== undefined) record.userAgent = input.userAgent;
  if (input.ip !== undefined) record.ip = input.ip;
  return record;
}

/** True once the session has a `revokedAt` stamp. */
export function isRevoked(session: SessionRecord): boolean {
  return typeof session.revokedAt === "string" && session.revokedAt.length > 0;
}

/**
 * True when the session is at or past its expiry at `now`. An unparseable
 * `expiresAt` counts as expired — corruption fails closed, never open.
 */
export function isExpired(session: SessionRecord, now: TimeInput): boolean {
  const expires = Date.parse(session.expiresAt);
  if (Number.isNaN(expires)) return true;
  return expires <= asMillis(now);
}

/**
 * True when no activity has been seen within the session's idle window. With
 * no `idleTimeoutMs` configured the session has no idle limit. An unparseable
 * `lastSeenAt` counts as idle (fail closed).
 */
export function isIdle(session: SessionRecord, now: TimeInput): boolean {
  const idle = session.idleTimeoutMs;
  if (idle === undefined) return false;
  const last = Date.parse(session.lastSeenAt);
  if (Number.isNaN(last)) return true;
  return asMillis(now) - last >= idle;
}

/** A session is active iff it is neither revoked, expired nor idle. */
export function isActive(session: SessionRecord, now: TimeInput): boolean {
  return !isRevoked(session) && !isExpired(session, now) && !isIdle(session, now);
}

/**
 * Slide an active session's expiry forward. The new deadline is
 * `min(now + idleWindow, createdAt + maxLifetimeMs)`, so activity renews an
 * idle window without ever letting a session outlive its absolute cap.
 * `lastSeenAt` is stamped with `now`. Inactive sessions (revoked, expired or
 * idle) are returned unchanged — activity cannot resurrect them; the same
 * reference is returned, so callers can detect a no-op with `===`.
 */
export function touchSession(session: SessionRecord, now: TimeInput): SessionRecord {
  if (!isActive(session, now)) return session;

  const at = asMillis(now);
  const created = Date.parse(session.createdAt);
  const expires = Date.parse(session.expiresAt);
  const idleWindow =
    session.idleTimeoutMs ?? (Number.isFinite(expires) && Number.isFinite(created) ? expires - created : 0);

  let cap: number;
  if (Number.isFinite(created) && session.maxLifetimeMs !== undefined) {
    cap = created + session.maxLifetimeMs;
  } else if (Number.isFinite(expires)) {
    cap = expires;
  } else {
    cap = at + idleWindow;
  }

  return {
    ...session,
    lastSeenAt: iso(at),
    expiresAt: iso(Math.min(at + idleWindow, cap)),
  };
}

/**
 * Revoke one session, stamping `revokedAt` and the reason. Idempotent: a
 * second call is a no-op and returns the same (first-revocation) record, so
 * the original time and reason are preserved. The input is never mutated.
 */
export function revokeSession(
  session: SessionRecord,
  options: { now: TimeInput; reason: string },
): SessionRecord {
  if (isRevoked(session)) return session;
  return {
    ...session,
    revokedAt: iso(asMillis(options.now)),
    revokedReason: options.reason,
  };
}

/**
 * Revoke every unrevoked session belonging to `userId` — the "sign out
 * everywhere" primitive. `exceptId` preserves the calling device. Already-
 * revoked records of the user are left exactly as they are, and other users'
 * sessions are untouched. Returns a new array; the input is never mutated.
 */
export function revokeAllForUser(
  sessions: readonly SessionRecord[],
  userId: string,
  options: { now: TimeInput; reason: string; exceptId?: string },
): SessionRecord[] {
  const revokedAt = iso(asMillis(options.now));
  return sessions.map((session) => {
    if (session.userId !== userId) return session;
    if (isRevoked(session)) return session;
    if (options.exceptId !== undefined && session.id === options.exceptId) return session;
    return { ...session, revokedAt, revokedReason: options.reason };
  });
}

/** The sessions still active at `now`, in the caller's input order. */
export function activeSessions(sessions: readonly SessionRecord[], now: TimeInput): SessionRecord[] {
  return sessions.filter((session) => isActive(session, now));
}

/**
 * Drop sessions that have reached expiry at `now` (kept iff `expiresAt > now`).
 * Revoked-but-unexpired records survive on purpose, so "recently revoked"
 * stays observable; expiry — not revocation — is what this prunes.
 */
export function pruneExpired(sessions: readonly SessionRecord[], now: TimeInput): SessionRecord[] {
  return sessions.filter((session) => !isExpired(session, now));
}

/**
 * Render a session for a device list: the browser/platform (and a combined
 * `device` label) parsed from the user-agent, the ip, a status
 * (`active`/`idle`/`expired`/`revoked`) and relative age / last-seen strings
 * computed from the injected `now`. Ages are clamped to ≥ 0 for clock skew.
 */
export function describeSession(session: SessionRecord, now: TimeInput): SessionDescription {
  const at = asMillis(now);
  const { browser, platform } = parseUserAgent(session.userAgent);
  const device =
    browser && platform ? `${browser} on ${platform}` : (browser ?? platform ?? null);

  const created = Date.parse(session.createdAt);
  const last = Date.parse(session.lastSeenAt);
  const ageMs = Number.isFinite(created) ? Math.max(0, at - created) : 0;
  const idleMs = Number.isFinite(last) ? Math.max(0, at - last) : 0;

  const status = isRevoked(session)
    ? "revoked"
    : isExpired(session, at)
      ? "expired"
      : isIdle(session, at)
        ? "idle"
        : "active";

  return {
    id: session.id,
    device,
    browser,
    platform,
    ip: session.ip ?? null,
    status,
    age: ago(ageMs),
    ageMs,
    lastSeen: ago(idleMs),
    idleMs,
  };
}

/**
 * Whether a live credential has aged past `maxAgeMs` and should be rotated.
 * Only active sessions qualify — a revoked or expired session is already dead,
 * so rotating it would be pointless. The boundary is inclusive: exactly
 * `maxAgeMs` old ⇒ `true`. An unparseable `createdAt` is treated as ancient
 * (rotate), the safe default.
 */
export function needsRotation(
  session: SessionRecord,
  options: { now: TimeInput; maxAgeMs: number },
): boolean {
  const at = asMillis(options.now);
  if (!isActive(session, at)) return false;
  const created = Date.parse(session.createdAt);
  if (Number.isNaN(created)) return true;
  return at - created >= options.maxAgeMs;
}
