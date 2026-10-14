"use server";

import { destroySession, getSessionId, requireUser } from "@/lib/auth";
import { revokeAllSessionsForUser, revokeSessionForUser } from "@/lib/session-store";

/** Registry sids are uuids; anything else never reaches the store. */
const SID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

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
