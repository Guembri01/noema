import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Session list wiring — `auth-sessions.ts` on top of the session registry
 * (source of truth) and the pure session engine (decisions).
 *
 * Only the transport edge (`requireUser`, `getSessionId`, `destroySession`) is
 * mocked; the real registry backs every call, so the list/expiry/prune/describe
 * chain is exercised against actual persisted rows.
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

import {
  registerSession,
  revokeAllSessionsForUser,
  revokeSessionForUser,
  touchSession,
} from "@/lib/session-store";
import { listSessionsAction, type ListedSessionRow, type ListSessionsResult } from "./auth-sessions";

const DAY = 24 * 60 * 60 * 1000;

let dir: string;

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), "b54-session-list-"));
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

/** Unwrap the action result, failing loudly on the error arm. */
function sessionsOf(result: ListSessionsResult): ListedSessionRow[] {
  if (!("ok" in result)) throw new Error(`unexpected error: ${result.error}`);
  return result.sessions;
}

describe("listSessionsAction — registry + pure engine", () => {
  it("lists the caller's active sessions with device, status and expiry", async () => {
    const current = registerSession({ userId: "user-a", device: "Chrome on Windows" });
    const sibling = registerSession({ userId: "user-a", device: "Firefox on Linux" });
    registerSession({ userId: "user-b", device: "stranger" });
    auth.currentSid = current.sid;

    const sessions = sessionsOf(await listSessionsAction());

    expect(sessions.map((session) => session.sid).sort()).toEqual(
      [current.sid, sibling.sid].sort(),
    );

    const row = sessions.find((session) => session.sid === current.sid);
    expect(row?.current).toBe(true);
    expect(row?.device).toBe("Chrome on Windows");
    expect(row?.status).toBe("active");
    // registerSession persists no deadline until a sliding touch; the list
    // surfaces that absence rather than inventing one.
    expect(row?.expiresAt).toBeNull();
    expect(typeof row?.age).toBe("string");
    expect(typeof row?.lastSeen).toBe("string");

    // The other user's session never leaks into the caller's list.
    expect(sessions.some((session) => session.device === "stranger")).toBe(false);
  });

  it("renders the persisted deadline once a session has been touched", async () => {
    const session = registerSession({ userId: "user-a", device: "Chrome on Windows" });
    expect(touchSession(session.sid, Date.now() + 2 * 60 * 1000).status).toBe("extended");

    const sessions = sessionsOf(await listSessionsAction());

    const row = sessions.find((entry) => entry.sid === session.sid);
    expect(row?.expiresAt).not.toBeNull();
  });

  it("drops a revoked session (revoke decision reflected in the list)", async () => {
    const live = registerSession({ userId: "user-a", device: "live device" });
    const dead = registerSession({ userId: "user-a", device: "old device" });
    expect(revokeSessionForUser(dead.sid, "user-a")).toBe("revoked");

    const sessions = sessionsOf(await listSessionsAction());

    expect(sessions.map((session) => session.sid)).toEqual([live.sid]);
  });

  it("prunes sessions already past their deadline", async () => {
    const fresh = registerSession({ userId: "user-a", device: "fresh" });
    registerSession({
      userId: "user-a",
      device: "expired",
      now: Date.now() - 31 * DAY,
    });

    const sessions = sessionsOf(await listSessionsAction());

    expect(sessions.map((session) => session.sid)).toEqual([fresh.sid]);
  });

  it("empties after a revoke-all (sign out everywhere)", async () => {
    registerSession({ userId: "user-a", device: "one" });
    registerSession({ userId: "user-a", device: "two" });
    expect(revokeAllSessionsForUser("user-a")).toBe(2);

    expect(sessionsOf(await listSessionsAction())).toEqual([]);
  });

  it("requires an authenticated caller", async () => {
    auth.requireUser.mockImplementation(async () => {
      throw new Error("NEXT_REDIRECT");
    });

    await expect(listSessionsAction()).rejects.toThrow("NEXT_REDIRECT");
  });
});
