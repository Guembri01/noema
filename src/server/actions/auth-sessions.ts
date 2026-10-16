"use server";

import { destroySession, getSessionId, requireUser } from "@/lib/auth";
import {
  listSessionsForUser,
  revokeAllSessionsForUser,
  revokeSessionForUser,
  type ListedSession as StoredSession,
} from "@/lib/session-store";
import {
  activeSessions,
  describeSession,
  pruneExpired,
  type SessionRecord as EngineSessionRecord,
} from "@/lib/session-management";

/** Registry sids are uuids; anything else never reaches the store. */
const SID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * The fixed lifetime the registry falls back to for rows written before sliding
 * expiry existed (mirrors `SESSION_TTL_MS` in `src/lib/session-store.ts`). The
 * pure engine needs an explicit `expiresAt`, so adapt rows that lack one.
 */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Project a persisted registry row onto the pure engine's `SessionRecord`.
 * `device` is already a parsed label, so the engine's user-agent parser is left
 * out of it (`userAgent` stays undefined) — the UI keeps the stored label.
 */
function toEngineRecord(session: StoredSession): EngineSessionRecord {
  const created = Date.parse(session.createdAt);
  const fallbackExpiry = Number.isFinite(created)
    ? new Date(created + SESSION_TTL_MS).toISOString()
    : "";
  const record: EngineSessionRecord = {
    id: session.sid,
    userId: session.userId,
    createdAt: session.createdAt,
    lastSeenAt: session.lastActiveAt,
    expiresAt: session.expiresAt ?? fallbackExpiry,
  };
  if (session.revokedAt) record.revokedAt = session.revokedAt;
  return record;
}

export type RevokeSessionResult =
  | { ok: true; signedOut: boolean }
  | { error: string };

/**
 * Revoke one active session of the caller (B54).
 *
 * Owner-of-session only: the registry answers `forbidden` for another user's
 * sid and this action turns that into a plain error — a member can never end
 * somebody else's session. Revoking the *current* session also clears the
 * cookie (`signedOut: true`).
 */
export async function revokeSessionAction(sid: string): Promise<RevokeSessionResult> {
  const user = await requireUser();
  if (typeof sid !== "string" || !sid.trim() || !SID_PATTERN.test(sid)) {
    return { error: "Invalid session id." };
  }

  const currentSid = await getSessionId();
  const outcome = revokeSessionForUser(sid, user.id);
  if (outcome === "forbidden") {
    return { error: "You can only revoke your own sessions." };
  }
  if (outcome === "not-found") {
    return { error: "That session is no longer active." };
  }

  if (sid === currentSid) {
    await destroySession();
    return { ok: true, signedOut: true };
  }
  return { ok: true, signedOut: false };
}

export type RevokeAllSessionsResult =
  | { ok: true; revoked: number; signedOut: true }
  | { error: string };

/**
 * Revoke every session of the caller — devices and this one (B54 revoke-all).
 * The cookie is cleared last, so the caller is signed out everywhere too.
 */
export async function revokeAllSessionsAction(): Promise<RevokeAllSessionsResult> {
  const user = await requireUser();
  const revoked = revokeAllSessionsForUser(user.id);
  await destroySession();
  return { ok: true, revoked, signedOut: true };
}

/** A session rendered for the security settings device list. */
export type ListedSessionRow = {
  sid: string;
  device: string | null;
  createdAt: string;
  lastActiveAt: string;
  current: boolean;
  /** ISO deadline the session ends at, or `null` when the row exposed none. */
  expiresAt: string | null;
  /** Lifecycle status from the pure session engine. */
  status: "active" | "idle" | "expired" | "revoked";
  /** Relative age since `createdAt`, e.g. "3 days ago". */
  age: string;
  /** Relative time since the last activity, e.g. "2 minutes ago". */
  lastSeen: string;
};

export type ListSessionsResult =
  | { ok: true; sessions: ListedSessionRow[] }
  | { error: string };

/**
 * List the caller's still-valid sessions (B54 settings panel).
 *
 * The registry is the source of truth for *which* rows exist; the pure session
 * engine, fed a projected record per row, decides what each row *means*:
 * `pruneExpired` drops anything past its deadline, `activeSessions` applies the
 * full revoked/expired/idle decision, and `describeSession` renders the status
 * and relative ages the UI shows. Fail-closed: a row the engine rejects never
 * reaches the panel.
 */
export async function listSessionsAction(): Promise<ListSessionsResult> {
  const user = await requireUser();
  const currentSid = await getSessionId();
  const now = Date.now();

  const listed = listSessionsForUser(user.id, now, { currentSid });
  const records = listed.map(toEngineRecord);
  const liveIds = new Set(
    activeSessions(pruneExpired(records, now), now).map((record) => record.id),
  );

  const sessions: ListedSessionRow[] = [];
  listed.forEach((session, index) => {
    const record = records[index];
    if (!record || !liveIds.has(session.sid)) return;
    const description = describeSession(record, now);
    sessions.push({
      sid: session.sid,
      device: session.device,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      current: session.current,
      expiresAt: session.expiresAt ?? null,
      status: description.status,
      age: description.age,
      lastSeen: description.lastSeen,
    });
  });

  return { ok: true, sessions };
}
