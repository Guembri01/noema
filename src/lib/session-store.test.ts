import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describeDevice,
  isSessionRevoked,
  listActiveSessions,
  registerSession,
  revokeAllSessionsForUser,
  revokeSessionForUser,
  storePath,
  touchSession,
} from "@/lib/session-store";

/**
 * B54 — session registry (list + revoke) guards, red-first.
 *
 * The registry is the bookkeeping half of session management: a `sid` claim in
 * the stateless JWT maps to a record here so the security settings UI can list
 * signed-in devices and revoke them. Every test runs against its own tmp-file
 * store (SESSION_STORE_PATH) — never the app's `.data/sessions.json`.
 *
 * The owner-scoped tests are the security core: a session may only be revoked
 * by the user that owns it (B54 brief: "member cannot revoke another user's
 * session").
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "b54-session-store-"));
  process.env.SESSION_STORE_PATH = join(dir, "sessions.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SESSION_STORE_PATH;
});

describe("session registry — register & list", () => {
  it("registers a session and lists it as active for its owner only", () => {
    const record = registerSession({ userId: "user-a", device: "Chrome on Windows" });
    expect(record.sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.revokedAt).toBeNull();

    const mine = listActiveSessions("user-a");
    expect(mine).toHaveLength(1);
    expect(mine[0]?.sid).toBe(record.sid);
    expect(mine[0]?.device).toBe("Chrome on Windows");
    expect(mine[0]?.lastActiveAt).toBe(record.createdAt);

    // Scoped by owner: another user's list stays empty.
    expect(listActiveSessions("user-b")).toHaveLength(0);
  });

  it("keeps a device label of null when the user-agent is unknown", () => {
    const record = registerSession({ userId: "user-a", device: describeDevice(null) });
    expect(record.device).toBeNull();
    expect(listActiveSessions("user-a")[0]?.device).toBeNull();
  });

  it("fails open on a corrupt store file instead of throwing", () => {
    writeFileSync(storePath(), "{not json", "utf8");
    expect(listActiveSessions("user-a")).toEqual([]);
    expect(isSessionRevoked("anything")).toBe(false);
  });

  it("prunes records past the 30-day session lifetime on the next write", () => {
    const stale = registerSession({ userId: "user-a", device: "Chrome" });
    // Backdate the record beyond SESSION_DAYS.
    const records = JSON.parse(readFileSync(storePath(), "utf8")) as Array<{
      sid: string;
      createdAt: string;
    }>;
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      storePath(),
      JSON.stringify(records.map((r) => (r.sid === stale.sid ? { ...r, createdAt: old } : r))),
      "utf8",
    );

    registerSession({ userId: "user-a", device: "Edge" });
    const sids = listActiveSessions("user-a").map((r) => r.sid);
    expect(sids).not.toContain(stale.sid);
  });
});

describe("session registry — revoke (owner-scoped)", () => {
  it("lets the owner revoke a session: it leaves the active list", () => {
    const record = registerSession({ userId: "user-a", device: "Firefox on macOS" });
    expect(revokeSessionForUser(record.sid, "user-a")).toBe("revoked");

    expect(isSessionRevoked(record.sid)).toBe(true);
    expect(listActiveSessions("user-a")).toHaveLength(0);
  });

  it("refuses to let another user revoke the session (owner-only)", () => {
    const victim = registerSession({ userId: "user-b", device: "Safari on iOS" });

    expect(revokeSessionForUser(victim.sid, "user-a")).toBe("forbidden");
    // The victim's session is untouched: not revoked, still listed.
    expect(isSessionRevoked(victim.sid)).toBe(false);
    expect(listActiveSessions("user-b").map((r) => r.sid)).toContain(victim.sid);
  });

  it("answers not-found for unknown or already-revoked sids", () => {
    expect(revokeSessionForUser("no-such-sid-000", "user-a")).toBe("not-found");

    const record = registerSession({ userId: "user-a", device: "Chrome" });
    expect(revokeSessionForUser(record.sid, "user-a")).toBe("revoked");
    expect(revokeSessionForUser(record.sid, "user-a")).toBe("not-found");
  });

  it("revoke-all ends every session of the caller, sparing other users", () => {
    const keep = registerSession({ userId: "user-a", device: "current" });
    registerSession({ userId: "user-a", device: "phone" });
    const stranger = registerSession({ userId: "user-b", device: "other user" });

    expect(revokeAllSessionsForUser("user-a")).toBe(2);
    expect(listActiveSessions("user-a")).toHaveLength(0);
    expect(isSessionRevoked(keep.sid)).toBe(true);
    expect(isSessionRevoked(stranger.sid)).toBe(false);
    expect(listActiveSessions("user-b")).toHaveLength(1);
  });

  it("revoke-all can keep the calling device signed in (exceptSid)", () => {
    const current = registerSession({ userId: "user-a", device: "current" });
    const other = registerSession({ userId: "user-a", device: "other" });

    expect(revokeAllSessionsForUser("user-a", { exceptSid: current.sid })).toBe(1);
    const alive = listActiveSessions("user-a").map((r) => r.sid);
    expect(alive).toEqual([current.sid]);
    expect(isSessionRevoked(other.sid)).toBe(true);
  });
});

describe("session registry — last-active touch", () => {
  it("stays inside the throttle window and then moves lastActiveAt", () => {
    const record = registerSession({ userId: "user-a", device: "Chrome" });

    // Freshly created: a touch inside the window must not rewrite anything.
    touchSession(record.sid);
    expect(listActiveSessions("user-a")[0]?.lastActiveAt).toBe(record.lastActiveAt);

    // Backdate lastActiveAt past the throttle, then touch again.
    const records = JSON.parse(readFileSync(storePath(), "utf8")) as Array<{
      sid: string;
      lastActiveAt: string;
    }>;
    const old = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    writeFileSync(
      storePath(),
      JSON.stringify(records.map((r) => (r.sid === record.sid ? { ...r, lastActiveAt: old } : r))),
      "utf8",
    );

    touchSession(record.sid);
    const after = listActiveSessions("user-a")[0]?.lastActiveAt;
    expect(after).not.toBe(old);
    expect(Date.parse(after ?? 0)).toBeGreaterThanOrEqual(Date.now() - 5_000);
  });

  it("never resurrects a revoked session's last-active", () => {
    const record = registerSession({ userId: "user-a", device: "Chrome" });
    revokeSessionForUser(record.sid, "user-a");

    const records = JSON.parse(readFileSync(storePath(), "utf8")) as Array<{
      sid: string;
      lastActiveAt: string;
    }>;
    const old = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    writeFileSync(
      storePath(),
      JSON.stringify(records.map((r) => (r.sid === record.sid ? { ...r, lastActiveAt: old } : r))),
      "utf8",
    );

    touchSession(record.sid);
    expect(listActiveSessions("user-a")).toHaveLength(0);
    const raw = JSON.parse(readFileSync(storePath(), "utf8")) as Array<{
      sid: string;
      lastActiveAt: string;
    }>;
    expect(raw.find((r) => r.sid === record.sid)?.lastActiveAt).toBe(old);
  });
});

describe("describeDevice — user-agent to a readable label", () => {
  it("names browser and OS", () => {
    expect(
      describeDevice(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome on Windows");
    expect(describeDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Firefox/133.0")).toBe(
      "Firefox on macOS",
    );
    expect(describeDevice("curl/8.5.0")).toBe("curl");
  });

  it("detects Edge and Opera before Chrome (their UAs embed Chrome/)", () => {
    const edge =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
    const opera =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/116.0.0.0";
    expect(describeDevice(edge)).toBe("Edge on Windows");
    expect(describeDevice(opera)).toBe("Opera on Windows");
  });

  it("detects Android before Linux and iOS before macOS (embedded UAs)", () => {
    expect(
      describeDevice(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe("Chrome on Android");
    expect(
      describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1"),
    ).toBe("Safari on iOS");
  });

  it("returns null for a missing or blank user-agent", () => {
    expect(describeDevice(null)).toBeNull();
    expect(describeDevice("")).toBeNull();
    expect(describeDevice("   ")).toBeNull();
  });
});
