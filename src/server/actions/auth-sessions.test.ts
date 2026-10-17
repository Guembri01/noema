import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B54 — server-action guard pins for the session revoke actions.
 *
 * Only the transport edge (`requireUser`, `getSessionId`, `destroySession`) is
 * mocked; the real session registry backs every call, so these exercise the
 * actual owner-of-session authorization chain (B54 red-first guard:
 * "member cannot revoke another user's session").
 */

const auth = vi.hoisted(() => ({
  currentUserId: "user-a",
  currentSid: null as string | null,
  requireUser: vi.fn(),
  getSessionId: vi.fn(),
  destroySession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireUser: auth.requireUser,
  getSessionId: auth.getSessionId,
  destroySession: auth.destroySession,
}));

import { isSessionRevoked, listActiveSessions, registerSession } from "@/lib/session-store";
import { destroySession } from "@/lib/auth";
import { revokeAllSessionsAction, revokeSessionAction } from "./auth-sessions";

let dir: string;

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), "b54-auth-actions-"));
  process.env.SESSION_STORE_PATH = join(dir, "sessions.json");
  auth.currentUserId = "user-a";
  auth.currentSid = null;
  auth.requireUser.mockImplementation(async () => ({ id: auth.currentUserId }));
  auth.getSessionId.mockImplementation(async () => auth.currentSid);
  auth.destroySession.mockImplementation(async () => undefined);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SESSION_STORE_PATH;
});

describe("revokeSessionAction — owner-of-session guard", () => {
  it("refuses to revoke another user's session and leaves it alive", async () => {
    const victim = registerSession({ userId: "user-b", device: "victim device" });

    const result = await revokeSessionAction(victim.sid);

    expect(result).toEqual({ error: "You can only revoke your own sessions." });
    expect(isSessionRevoked(victim.sid)).toBe(false);
    expect(listActiveSessions("user-b").map((r) => r.sid)).toContain(victim.sid);
    expect(destroySession).not.toHaveBeenCalled();
  });

  it("revokes the caller's own other device without touching the current cookie", async () => {
    const other = registerSession({ userId: "user-a", device: "other device" });
    auth.currentSid = registerSession({ userId: "user-a", device: "current device" }).sid;

    const result = await revokeSessionAction(other.sid);

    expect(result).toEqual({ ok: true, signedOut: false });
    expect(isSessionRevoked(other.sid)).toBe(true);
    expect(listActiveSessions("user-a").map((r) => r.sid)).toEqual([auth.currentSid]);
    expect(destroySession).not.toHaveBeenCalled();
  });

  it("clears the cookie when the revoked session is the current one", async () => {
    const mine = registerSession({ userId: "user-a", device: "current device" });
    auth.currentSid = mine.sid;

    const result = await revokeSessionAction(mine.sid);

    expect(result).toEqual({ ok: true, signedOut: true });
    expect(isSessionRevoked(mine.sid)).toBe(true);
    expect(destroySession).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed or unknown session ids", async () => {
    await expect(revokeSessionAction("short")).resolves.toEqual({
      error: "Invalid session id.",
    });
    await expect(revokeSessionAction(`sid_${"x".repeat(200)}`)).resolves.toEqual({
      error: "Invalid session id.",
    });
    await expect(revokeSessionAction("00000000-0000-4000-8000-000000000000")).resolves.toEqual({
      error: "That session is no longer active.",
    });
  });
});

describe("revokeAllSessionsAction — every device of the caller", () => {
  it("ends all of the caller's sessions, spares other users, clears the cookie", async () => {
    const current = registerSession({ userId: "user-a", device: "current" });
    registerSession({ userId: "user-a", device: "phone" });
    const stranger = registerSession({ userId: "user-b", device: "stranger" });
    auth.currentSid = current.sid;

    const result = await revokeAllSessionsAction();

    expect(result).toEqual({ ok: true, revoked: 2, signedOut: true });
    expect(listActiveSessions("user-a")).toHaveLength(0);
    expect(isSessionRevoked(stranger.sid)).toBe(false);
    expect(listActiveSessions("user-b")).toHaveLength(1);
    expect(destroySession).toHaveBeenCalledTimes(1);
  });

  it("requires an authenticated caller (requireUser first, store untouched)", async () => {
    const record = registerSession({ userId: "user-a", device: "device" });
    auth.requireUser.mockImplementation(async () => {
      throw new Error("NEXT_REDIRECT");
    });

    await expect(revokeAllSessionsAction()).rejects.toThrow("NEXT_REDIRECT");
    expect(isSessionRevoked(record.sid)).toBe(false);
  });
});
