import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const itPosix = process.platform === "win32" ? it.skip : it;
import {
  describeDevice,
  isSessionRevoked,
  listActiveSessions,
  listSessionsForUser,
  registerSession,
  revokeAllSessionsForUser,
  revokeSession,
  revokeSessionForUser,
  storePath,
  touchSession,
  validateSession,
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
 * by the user that owns it (B54: "member cannot revoke another user's
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

describe("session registry — the store is owner-only (B67)", () => {
  // The store names the devices that are signed in. The desktop app puts it
  // next to the database, in the user's data directory; with the umask's
  // defaults (0755/0644) every user on the machine could read it.
  const storeIn = (sub: string) => {
    process.env.SESSION_STORE_PATH = join(dir, sub, "sessions.json");
    return process.env.SESSION_STORE_PATH;
  };

  itPosix("writes the store as a 0600 file inside a 0700 directory", () => {
    const file = storeIn("data");
    registerSession({ userId: "user-a", device: "Chrome on Windows" });

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
  });

  itPosix("hardens a store that an older version created with the umask's modes", () => {
    const file = storeIn("legacy");
    // An install from before the modes were set: the directory is 0755 and the
    // file in it 0644.
    mkdirSync(dirname(file), { recursive: true });
    chmodSync(dirname(file), 0o755);
    writeFileSync(file, "[]", { mode: 0o644 });

    registerSession({ userId: "user-a", device: "Chrome on Windows" });

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
  });
});

describe("session registry — fail-closed validation (validateSession)", () => {
  it("accepts an active session; rejects unknown and expired ones", () => {
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const day = 24 * 60 * 60 * 1000;
    const record = registerSession({ userId: "user-a", device: "Chrome", now: t0 });

    // Active an hour in: well inside the 30-day window.
    expect(validateSession(record.sid, t0 + 60 * 60 * 1000)?.sid).toBe(record.sid);

    // Unknown sid → rejected (fail closed, unlike the isSessionRevoked probe,
    // which stays fail-open so a broken registry can't mass sign-out devices).
    expect(validateSession("no-such-sid", t0)).toBeNull();

    // Past the fixed TTL: the record exists but the session is over.
    expect(validateSession(record.sid, t0 + 30 * day + 1)).toBeNull();
  });

  it("rejects a revoked-but-unexpired token (revoke → validate fails closed)", () => {
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const record = registerSession({ userId: "user-a", device: "Chrome", now: t0 });
    expect(validateSession(record.sid, t0 + 60_000)).not.toBeNull();

    // Unscoped revoke by sid, for trusted server-side/forced paths.
    expect(revokeSession(record.sid, t0 + 61_000)).toBe("revoked");
    // An hour later — nowhere near expiry — the token must already be dead.
    expect(validateSession(record.sid, t0 + 2 * 60 * 60 * 1000)).toBeNull();
    // Re-revoking an ended session reports not-found (same as owner-scoped).
    expect(revokeSession(record.sid, t0 + 62_000)).toBe("not-found");
    expect(revokeSession("no-such-sid", t0)).toBe("not-found");
  });

  it("owner-scoped revocation fails validation closed too, and only for the owner", () => {
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const record = registerSession({ userId: "user-b", device: "Safari on iOS", now: t0 });

    // Another user may not revoke it, and the token stays alive.
    expect(revokeSessionForUser(record.sid, "user-a", t0 + 1_000)).toBe("forbidden");
    expect(validateSession(record.sid, t0 + 2_000)).not.toBeNull();

    // The owner can — and the token dies immediately, not at expiry.
    expect(revokeSessionForUser(record.sid, "user-b", t0 + 3_000)).toBe("revoked");
    expect(validateSession(record.sid, t0 + 4_000)).toBeNull();
  });
});

describe("session registry — revoke-all keeps the current device", () => {
  it("exceptSid spares the caller's session and stamps revokedAt at the injected now", () => {
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const current = registerSession({ userId: "user-a", device: "current", now: t0 });
    const other = registerSession({ userId: "user-a", device: "phone", now: t0 });

    expect(
      revokeAllSessionsForUser("user-a", { exceptSid: current.sid, now: t0 + 5_000 }),
    ).toBe(1);

    // The spared device is still valid; the other one is dead despite being
    // nowhere near its 30-day expiry.
    expect(validateSession(current.sid, t0 + 10_000)).not.toBeNull();
    expect(validateSession(other.sid, t0 + 10_000)).toBeNull();

    const raw = JSON.parse(readFileSync(storePath(), "utf8")) as Array<{
      sid: string;
      revokedAt: string | null;
    }>;
    expect(raw.find((r) => r.sid === other.sid)?.revokedAt).toBe(
      new Date(t0 + 5_000).toISOString(),
    );
    expect(raw.find((r) => r.sid === current.sid)?.revokedAt).toBeNull();
  });
});

describe("session registry — listSessionsForUser (settings panel view)", () => {
  it("lists active sessions with metadata, most recent first, flagging the current one", () => {
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const laptop = registerSession({ userId: "user-a", device: "Chrome on Windows", now: t0 });
    const phone = registerSession({
      userId: "user-a",
      device: "Safari on iOS",
      now: t0 + 5_000,
    });
    const revoked = registerSession({ userId: "user-a", device: "old tablet", now: t0 });
    registerSession({ userId: "user-b", device: "other user", now: t0 + 5_000 });
    revokeSession(revoked.sid, t0 + 6_000);

    const listed = listSessionsForUser("user-a", t0 + 10_000, { currentSid: phone.sid });

    expect(listed.map((s) => s.sid)).toEqual([phone.sid, laptop.sid]); // recent first
    expect(listed.map((s) => s.device)).toEqual(["Safari on iOS", "Chrome on Windows"]);
    expect(listed[0]?.current).toBe(true);
    expect(listed[1]?.current).toBe(false);
    expect(listed.map((s) => s.createdAt)).toContain(laptop.createdAt);
    expect(listed.map((s) => s.lastActiveAt)).toContain(phone.lastActiveAt);
    // The revoked tablet and the other user's session are absent.
    expect(listed.map((s) => s.sid)).not.toContain(revoked.sid);
  });

  it("excludes expired and revoked sessions at the injected now", () => {
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const day = 24 * 60 * 60 * 1000;
    const alive = registerSession({ userId: "user-a", device: "Chrome", now: t0 });
    const revoked = registerSession({ userId: "user-a", device: "phone", now: t0 });
    revokeSession(revoked.sid, t0 + 1_000);

    // A day in: only the non-revoked session is listed.
    expect(listSessionsForUser("user-a", t0 + day).map((s) => s.sid)).toEqual([alive.sid]);

    // 31 days in — past the fixed 30-day TTL, nothing slid — everything is gone.
    expect(listSessionsForUser("user-a", t0 + 31 * day)).toEqual([]);

    // An unknown currentSid simply flags nothing as current.
    const flags = listSessionsForUser("user-a", t0 + day, { currentSid: "ghost" });
    expect(flags.every((s) => !s.current)).toBe(true);
  });
});

describe("session registry — sliding expiry (touchSession with an injected clock)", () => {
  const day = 24 * 60 * 60 * 1000;
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");

  it("extends expiry on activity within the absolute cap", () => {
    const record = registerSession({ userId: "user-a", device: "Chrome", now: t0 });

    const first = touchSession(record.sid, t0 + 2 * 60_000, { maxLifetimeMs: 90 * day });
    expect(first).toEqual({
      status: "extended",
      // Idle window (30d) measured from the touch: two minutes past the
      // original fixed deadline.
      expiresAt: new Date(t0 + 2 * 60_000 + 30 * day).toISOString(),
    });

    // The record is valid right up to (but not including) the slid deadline.
    const slidExpiry = t0 + 30 * day + 2 * 60_000;
    expect(validateSession(record.sid, slidExpiry - 1)).not.toBeNull();
    expect(validateSession(record.sid, slidExpiry)).toBeNull();
  });

  it("keeps sliding on each touch, so activity outlives the original window", () => {
    const record = registerSession({ userId: "user-a", device: "Chrome", now: t0 });
    touchSession(record.sid, t0 + 2 * 60_000, { maxLifetimeMs: 90 * day });

    // Another touch just before the slid deadline pushes it out by a full
    // idle window again.
    const second = touchSession(record.sid, t0 + 30 * day + 60_000, {
      maxLifetimeMs: 90 * day,
    });
    expect(second).toEqual({
      status: "extended",
      expiresAt: new Date(t0 + 30 * day + 60_000 + 30 * day).toISOString(),
    });
    // Long past the original 30-day window, still active.
    expect(validateSession(record.sid, t0 + 59 * day)).not.toBeNull();
  });

  it("stops extending at the absolute-lifetime cap (maxLifetimeMs)", () => {
    const record = registerSession({ userId: "user-a", device: "Chrome", now: t0 });

    // t0 + 2d + 30d would overshoot the 10-day cap → clipped to createdAt + cap.
    const first = touchSession(record.sid, t0 + 2 * day, { maxLifetimeMs: 10 * day });
    expect(first).toEqual({
      status: "extended",
      expiresAt: new Date(t0 + 10 * day).toISOString(),
    });

    // A later touch cannot push the deadline past the cap either…
    const second = touchSession(record.sid, t0 + 9 * day, { maxLifetimeMs: 10 * day });
    expect(second).toEqual({
      status: "extended",
      expiresAt: new Date(t0 + 10 * day).toISOString(),
    });
    // …and the session dies exactly at createdAt + maxLifetimeMs.
    expect(validateSession(record.sid, t0 + 10 * day - 1)).not.toBeNull();
    expect(validateSession(record.sid, t0 + 10 * day)).toBeNull();
  });

  it("never resurrects revoked, expired, or unknown sessions", () => {
    const revoked = registerSession({ userId: "user-a", device: "Chrome", now: t0 });
    revokeSession(revoked.sid, t0 + 1_000);
    expect(
      touchSession(revoked.sid, t0 + 10 * 60_000, { maxLifetimeMs: 90 * day }),
    ).toEqual({ status: "revoked" });

    const expired = registerSession({ userId: "user-a", device: "phone", now: t0 });
    expect(touchSession(expired.sid, t0 + 31 * day)).toEqual({ status: "expired" });

    expect(touchSession("no-such-sid", t0)).toEqual({ status: "not-found" });

    // Nothing was written for any of them: lastActiveAt still reads the
    // creation instant.
    const raw = JSON.parse(readFileSync(storePath(), "utf8")) as Array<{
      sid: string;
      lastActiveAt: string;
    }>;
    expect(raw.find((r) => r.sid === revoked.sid)?.lastActiveAt).toBe(
      new Date(t0).toISOString(),
    );
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
