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
 * record update (accepted for the parity loop, noted in the B54 report).
 *
 * Reads fail OPEN: a missing or corrupt file yields "no sessions", never an
 * auth outage — a broken registry must not lock every device out.
 */

export type SessionRecord = {
  sid: string;
  userId: string;
  /** Rendered by the settings UI; null when the user-agent was unknown. */
  device: string | null;
  createdAt: string;
  lastActiveAt: string;
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

/** Drop records that outlived the session TTL (or their revocation retention). */
function prune(records: SessionRecord[]): SessionRecord[] {
  const now = Date.now();
  return records.filter((record) => {
    if (now - Date.parse(record.createdAt) > SESSION_TTL_MS) return false;
    if (record.revokedAt && now - Date.parse(record.revokedAt) > REVOKED_RETENTION_MS) {
      return false;
    }
    return true;
  });
}

/** Register a freshly issued session; returns the record (with its sid). */
export function registerSession(input: {
  userId: string;
  device: string | null;
}): SessionRecord {
  const now = new Date().toISOString();
  const record: SessionRecord = {
    sid: randomUUID(),
    userId: input.userId,
    device: input.device,
    createdAt: now,
    lastActiveAt: now,
    revokedAt: null,
  };
  mutate((records) => [...prune(records), record]);
  return record;
}

export function findSession(sid: string): SessionRecord | null {
  return readAll().find((record) => record.sid === sid) ?? null;
}

/** Revocation check for the request path. Unknown sid → false (fail open). */
export function isSessionRevoked(sid: string): boolean {
  const record = findSession(sid);
  return record !== null && record.revokedAt !== null;
}

/** Bump lastActiveAt (throttled to one write per minute per session). */
export function touchSession(sid: string): void {
  const now = Date.now();
  const record = findSession(sid);
  if (!record || record.revokedAt) return;
  if (now - Date.parse(record.lastActiveAt) < TOUCH_INTERVAL_MS) return;
  const iso = new Date(now).toISOString();
  mutate((records) =>
    records.map((entry) => (entry.sid === sid ? { ...entry, lastActiveAt: iso } : entry)),
  );
}

/** Active sessions of one user, most recently active first. */
export function listActiveSessions(userId: string): SessionRecord[] {
  return readAll()
    .filter((record) => record.userId === userId && !record.revokedAt)
    .sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
}

export type RevokeOutcome = "revoked" | "not-found" | "forbidden";

/** Revoke one session — only its owner may do it (B54 owner-of-session guard). */
export function revokeSessionForUser(sid: string, userId: string): RevokeOutcome {
  const record = findSession(sid);
  if (!record || record.revokedAt) return "not-found";
  if (record.userId !== userId) return "forbidden";
  const iso = new Date().toISOString();
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
  options: { exceptSid?: string } = {},
): number {
  const iso = new Date().toISOString();
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