import { describe, expect, it } from "vitest";
import {
  activeSessions,
  createSession,
  describeSession,
  isActive,
  isExpired,
  isIdle,
  isRevoked,
  needsRotation,
  pruneExpired,
  revokeAllForUser,
  revokeSession,
  touchSession,
  type SessionRecord,
} from "./session-management";

/**
 * §17 Session management — the pure session lifecycle engine.
 *
 * Red-first: this file was written BEFORE `src/lib/session-management.ts`
 * existed, so collection failed on the unresolved import. It pins the whole
 * lifecycle: issuing a record (`createSession`), evaluating it (`isActive`,
 * `isRevoked`/`isExpired`/`isIdle`), sliding its expiry with an absolute cap
 * (`touchSession`), revoking one or many (`revokeSession`,
 * `revokeAllForUser`), filtering (`activeSessions`, `pruneExpired`), describing
 * it for a device list (`describeSession`) and deciding when a credential is
 * old enough to rotate (`needsRotation`).
 *
 * Traceability: R28.12–R28.16 (§4.3 sessions & revocation). `now` is injected
 * everywhere so no test depends on the wall clock; the engine never mutates
 * its inputs and never reads the filesystem, network or DB.
 */

const NOW = Date.parse("2026-06-15T12:00:00.000Z");
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const iso = (ms: number): string => new Date(ms).toISOString();

/** A healthy one-hour-old session, active at `NOW`, overridable per test. */
function make(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s1",
    userId: "u1",
    createdAt: iso(NOW - HOUR),
    lastSeenAt: iso(NOW - MINUTE),
    expiresAt: iso(NOW + HOUR),
    ...overrides,
  };
}

const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const FIREFOX_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

describe("createSession — issuing a record", () => {
  it("builds the core fields from userId/now/ttlMs", () => {
    const session = createSession({ userId: "u1", now: NOW, ttlMs: HOUR });
    expect(session.userId).toBe("u1");
    expect(session.createdAt).toBe(iso(NOW));
    expect(session.lastSeenAt).toBe(iso(NOW));
    expect(session.expiresAt).toBe(iso(NOW + HOUR));
    expect(session.revokedAt).toBeUndefined();
  });

  it("mints a distinct id per session, or accepts one", () => {
    const a = createSession({ userId: "u1", now: NOW, ttlMs: HOUR });
    const b = createSession({ userId: "u1", now: NOW, ttlMs: HOUR });
    expect(a.id).not.toBe(b.id);
    expect(a.id.length).toBeGreaterThan(0);

    expect(createSession({ userId: "u1", now: NOW, ttlMs: HOUR, id: "fixed" }).id).toBe("fixed");
  });

  it("records userAgent and ip when supplied", () => {
    const session = createSession({
      userId: "u1",
      now: NOW,
      ttlMs: HOUR,
      userAgent: CHROME_WINDOWS,
      ip: "203.0.113.7",
    });
    expect(session.userAgent).toBe(CHROME_WINDOWS);
    expect(session.ip).toBe("203.0.113.7");
  });

  it("defaults the idle window and absolute cap to ttlMs", () => {
    const session = createSession({ userId: "u1", now: NOW, ttlMs: 30 * DAY });
    expect(session.idleTimeoutMs).toBe(30 * DAY);
    expect(session.maxLifetimeMs).toBe(30 * DAY);
  });

  it("honours an explicit idle window and absolute cap", () => {
    const session = createSession({
      userId: "u1",
      now: NOW,
      ttlMs: HOUR,
      idleTimeoutMs: 10 * MINUTE,
      maxLifetimeMs: DAY,
    });
    expect(session.idleTimeoutMs).toBe(10 * MINUTE);
    expect(session.maxLifetimeMs).toBe(DAY);
    expect(session.expiresAt).toBe(iso(NOW + HOUR));
  });

  it("treats `now` as a number, ISO string or Date identically", () => {
    const asNumber = createSession({ userId: "u1", now: NOW, ttlMs: HOUR, id: "x" });
    const asString = createSession({ userId: "u1", now: iso(NOW), ttlMs: HOUR, id: "x" });
    const asDate = createSession({ userId: "u1", now: new Date(NOW), ttlMs: HOUR, id: "x" });
    expect(asString).toEqual(asNumber);
    expect(asDate).toEqual(asNumber);
  });

  it("rejects a non-positive or non-finite ttl", () => {
    expect(() => createSession({ userId: "u1", now: NOW, ttlMs: 0 })).toThrow();
    expect(() => createSession({ userId: "u1", now: NOW, ttlMs: -1 })).toThrow();
    expect(() => createSession({ userId: "u1", now: NOW, ttlMs: Number.NaN })).toThrow();
  });
});

describe("isActive — expiry, revocation and idle timeout", () => {
  it("is active inside its window", () => {
    expect(isActive(make(), NOW)).toBe(true);
  });

  it("is active one millisecond before expiry", () => {
    expect(isActive(make({ expiresAt: iso(NOW + 1) }), NOW)).toBe(true);
  });

  it("is inactive exactly at the expiry boundary", () => {
    expect(isActive(make({ expiresAt: iso(NOW) }), NOW)).toBe(false);
  });

  it("is inactive after expiry", () => {
    expect(isActive(make({ expiresAt: iso(NOW - 1) }), NOW)).toBe(false);
  });

  it("is inactive when revoked, even if unexpired", () => {
    expect(isActive(make({ revokedAt: iso(NOW - MINUTE) }), NOW)).toBe(false);
  });

  it("is inactive exactly at the idle boundary", () => {
    const idle = make({ idleTimeoutMs: HOUR, lastSeenAt: iso(NOW - HOUR) });
    expect(isActive(idle, NOW)).toBe(false);
  });

  it("is active one millisecond inside the idle window", () => {
    const idle = make({ idleTimeoutMs: HOUR, lastSeenAt: iso(NOW - HOUR + 1) });
    expect(isActive(idle, NOW)).toBe(true);
  });

  it("ignores idle time when no idle window is configured", () => {
    expect(isActive(make({ lastSeenAt: iso(NOW - 30 * DAY) }), NOW)).toBe(true);
  });

  it("exposes isRevoked / isExpired / isIdle seams that agree with isActive", () => {
    const revoked = make({ revokedAt: iso(NOW - MINUTE) });
    expect(isRevoked(revoked)).toBe(true);
    expect(isActive(revoked, NOW)).toBe(false);

    const expired = make({ expiresAt: iso(NOW) });
    expect(isExpired(expired, NOW)).toBe(true);

    const idle = make({ idleTimeoutMs: MINUTE, lastSeenAt: iso(NOW - MINUTE) });
    expect(isIdle(idle, NOW)).toBe(true);

    const fresh = make();
    expect(isRevoked(fresh)).toBe(false);
    expect(isExpired(fresh, NOW)).toBe(false);
    expect(isIdle(fresh, NOW)).toBe(false);
  });

  it("fails closed on an unparseable expiry", () => {
    expect(isExpired(make({ expiresAt: "not-a-date" }), NOW)).toBe(true);
  });
});

describe("touchSession — sliding expiry with an absolute cap", () => {
  it("slides the expiry forward by the idle window and stamps lastSeenAt", () => {
    const session = make({
      createdAt: iso(NOW - HOUR),
      expiresAt: iso(NOW + HOUR),
      idleTimeoutMs: 2 * HOUR,
      maxLifetimeMs: 24 * HOUR,
    });
    const touched = touchSession(session, NOW);
    expect(touched.lastSeenAt).toBe(iso(NOW));
    expect(touched.expiresAt).toBe(iso(NOW + 2 * HOUR));
  });

  it("never extends past createdAt + maxLifetimeMs", () => {
    const session = make({
      createdAt: iso(NOW - 20 * HOUR),
      expiresAt: iso(NOW + 4 * HOUR),
      idleTimeoutMs: 10 * HOUR,
      maxLifetimeMs: 24 * HOUR,
    });
    const touched = touchSession(session, NOW);
    expect(touched.expiresAt).toBe(iso(NOW + 4 * HOUR)); // capped, not now + 10h
    expect(touched.lastSeenAt).toBe(iso(NOW));
  });

  it("does not extend an expired session", () => {
    const session = make({ expiresAt: iso(NOW - MINUTE) });
    expect(touchSession(session, NOW)).toBe(session);
  });

  it("does not resurrect a revoked session", () => {
    const session = make({ revokedAt: iso(NOW - MINUTE) });
    expect(touchSession(session, NOW)).toBe(session);
  });

  it("does not extend an idle-expired session", () => {
    const session = make({ idleTimeoutMs: MINUTE, lastSeenAt: iso(NOW - MINUTE) });
    expect(touchSession(session, NOW)).toBe(session);
  });

  it("returns a new record and leaves the input untouched", () => {
    const session = make();
    const touched = touchSession(session, NOW);
    expect(touched).not.toBe(session);
    expect(session.expiresAt).toBe(iso(NOW + HOUR));
    expect(session.lastSeenAt).toBe(iso(NOW - MINUTE));
  });

  it("keeps successive touches inside the absolute cap", () => {
    const session = make({
      createdAt: iso(NOW - 1 * HOUR),
      expiresAt: iso(NOW + HOUR),
      idleTimeoutMs: 2 * HOUR,
      maxLifetimeMs: 4 * HOUR,
    });
    const first = touchSession(session, NOW);
    const second = touchSession(first, NOW + HOUR);
    // cap = NOW - 1h + 4h = NOW + 3h
    expect(second.expiresAt).toBe(iso(NOW + 3 * HOUR));
  });
});

describe("revokeSession — one device", () => {
  it("stamps revokedAt and the reason", () => {
    const revoked = revokeSession(make(), { now: NOW, reason: "user-logout" });
    expect(revoked.revokedAt).toBe(iso(NOW));
    expect(revoked.revokedReason).toBe("user-logout");
  });

  it("is idempotent — the first revocation wins", () => {
    const first = revokeSession(make(), { now: NOW - MINUTE, reason: "first" });
    const second = revokeSession(first, { now: NOW, reason: "second" });
    expect(second).toBe(first);
    expect(second.revokedAt).toBe(iso(NOW - MINUTE));
    expect(second.revokedReason).toBe("first");
  });

  it("does not mutate the input and flips isActive to false", () => {
    const session = make();
    const revoked = revokeSession(session, { now: NOW, reason: "admin" });
    expect(session.revokedAt).toBeUndefined();
    expect(isActive(session, NOW)).toBe(true);
    expect(isActive(revoked, NOW)).toBe(false);
  });
});

describe("revokeAllForUser — sign out everywhere", () => {
  const sessions = (): SessionRecord[] => [
    make({ id: "a", userId: "u1" }),
    make({ id: "b", userId: "u1" }),
    make({ id: "c", userId: "u2" }),
  ];

  it("revokes every unrevoked session of the user", () => {
    const result = revokeAllForUser(sessions(), "u1", { now: NOW, reason: "logout-all" });
    expect(result.find((s) => s.id === "a")?.revokedAt).toBe(iso(NOW));
    expect(result.find((s) => s.id === "b")?.revokedAt).toBe(iso(NOW));
  });

  it("keeps the current device via exceptId", () => {
    const result = revokeAllForUser(sessions(), "u1", {
      now: NOW,
      reason: "logout-all",
      exceptId: "b",
    });
    expect(result.find((s) => s.id === "a")?.revokedAt).toBe(iso(NOW));
    expect(result.find((s) => s.id === "b")?.revokedAt).toBeUndefined();
    expect(isActive(result.find((s) => s.id === "b") as SessionRecord, NOW)).toBe(true);
  });

  it("leaves other users untouched", () => {
    const result = revokeAllForUser(sessions(), "u1", { now: NOW, reason: "logout-all" });
    expect(result.find((s) => s.id === "c")?.revokedAt).toBeUndefined();
  });

  it("does not overwrite an already-revoked record", () => {
    const already = make({ id: "a", userId: "u1", revokedAt: iso(NOW - HOUR), revokedReason: "old" });
    const result = revokeAllForUser([already, make({ id: "b", userId: "u1" })], "u1", {
      now: NOW,
      reason: "logout-all",
    });
    const kept = result.find((s) => s.id === "a");
    expect(kept).toBe(already);
    expect(kept?.revokedReason).toBe("old");
  });

  it("returns a new array without mutating the input", () => {
    const input = sessions();
    const result = revokeAllForUser(input, "u1", { now: NOW, reason: "logout-all" });
    expect(result).not.toBe(input);
    expect(input[0]?.revokedAt).toBeUndefined();
    expect(input).toHaveLength(3);
  });
});

describe("activeSessions and pruneExpired — filtering", () => {
  it("returns only active sessions, preserving input order", () => {
    const sessions = [
      make({ id: "fresh" }),
      make({ id: "revoked", revokedAt: iso(NOW - MINUTE) }),
      make({ id: "expired", expiresAt: iso(NOW - 1) }),
      make({ id: "alsoFresh", lastSeenAt: iso(NOW - 2 * MINUTE) }),
    ];
    expect(activeSessions(sessions, NOW).map((s) => s.id)).toEqual(["fresh", "alsoFresh"]);
  });

  it("returns an empty array when nothing is active", () => {
    const sessions = [make({ revokedAt: iso(NOW) }), make({ expiresAt: iso(NOW) })];
    expect(activeSessions(sessions, NOW)).toEqual([]);
  });

  it("prunes expired sessions at the boundary but keeps revoked-but-unexpired ones", () => {
    const sessions = [
      make({ id: "future", expiresAt: iso(NOW + 1) }),
      make({ id: "boundary", expiresAt: iso(NOW) }),
      make({ id: "past", expiresAt: iso(NOW - 1) }),
      make({ id: "revokedLive", revokedAt: iso(NOW - MINUTE), expiresAt: iso(NOW + HOUR) }),
    ];
    expect(pruneExpired(sessions, NOW).map((s) => s.id)).toEqual(["future", "revokedLive"]);
  });

  it("does not mutate its input", () => {
    const sessions = [make({ id: "a" }), make({ id: "b", expiresAt: iso(NOW) })];
    const snapshot = JSON.stringify(sessions);
    pruneExpired(sessions, NOW);
    expect(JSON.stringify(sessions)).toBe(snapshot);
  });
});

describe("describeSession — device, browser and relative age", () => {
  it("reads browser and platform from a Chrome/Windows user-agent", () => {
    const described = describeSession(make({ userAgent: CHROME_WINDOWS, ip: "198.51.100.9" }), NOW);
    expect(described.browser).toBe("Chrome");
    expect(described.platform).toBe("Windows");
    expect(described.device).toBe("Chrome on Windows");
    expect(described.ip).toBe("198.51.100.9");
  });

  it("reads Safari/iOS without mislabelling it as macOS", () => {
    const described = describeSession(make({ userAgent: SAFARI_IOS }), NOW);
    expect(described.browser).toBe("Safari");
    expect(described.platform).toBe("iOS");
    expect(described.device).toBe("Safari on iOS");
  });

  it("reads Firefox/Linux and degrades gracefully for unknown agents", () => {
    expect(describeSession(make({ userAgent: FIREFOX_LINUX }), NOW).device).toBe("Firefox on Linux");
    const unknown = describeSession(make({ userAgent: "" }), NOW);
    expect(unknown.browser).toBeNull();
    expect(unknown.platform).toBeNull();
    expect(unknown.device).toBeNull();
    expect(describeSession(make({}), NOW).device).toBeNull();
  });

  it("renders the relative age and last-seen from injected now", () => {
    const described = describeSession(make({ createdAt: iso(NOW - 3 * DAY), lastSeenAt: iso(NOW - 2 * MINUTE) }), NOW);
    expect(described.age).toBe("3 days ago");
    expect(described.lastSeen).toBe("2 minutes ago");
    expect(described.ageMs).toBe(3 * DAY);
    expect(described.idleMs).toBe(2 * MINUTE);
  });

  it("reports active / idle / expired / revoked status", () => {
    expect(describeSession(make(), NOW).status).toBe("active");
    expect(describeSession(make({ idleTimeoutMs: MINUTE, lastSeenAt: iso(NOW - MINUTE) }), NOW).status).toBe("idle");
    expect(describeSession(make({ expiresAt: iso(NOW) }), NOW).status).toBe("expired");
    expect(describeSession(make({ revokedAt: iso(NOW) }), NOW).status).toBe("revoked");
  });

  it("never reports a negative age for a clock-skewed record", () => {
    const described = describeSession(make({ createdAt: iso(NOW + HOUR), lastSeenAt: iso(NOW + HOUR) }), NOW);
    expect(described.ageMs).toBe(0);
    expect(described.age).toBe("just now");
  });
});

describe("needsRotation — credential age", () => {
  it("is true exactly at the rotation age", () => {
    expect(needsRotation(make({ createdAt: iso(NOW - 7 * DAY) }), { now: NOW, maxAgeMs: 7 * DAY })).toBe(true);
  });

  it("is false one millisecond before the rotation age", () => {
    expect(needsRotation(make({ createdAt: iso(NOW - 7 * DAY + 1) }), { now: NOW, maxAgeMs: 7 * DAY })).toBe(false);
  });

  it("is false for revoked or expired sessions (nothing left to rotate)", () => {
    expect(needsRotation(make({ createdAt: iso(NOW - 30 * DAY), revokedAt: iso(NOW) }), { now: NOW, maxAgeMs: DAY })).toBe(false);
    expect(needsRotation(make({ createdAt: iso(NOW - 30 * DAY), expiresAt: iso(NOW - 1) }), { now: NOW, maxAgeMs: DAY })).toBe(false);
  });

  it("is true for an old, still-active session", () => {
    expect(needsRotation(make({ createdAt: iso(NOW - 30 * DAY) }), { now: NOW, maxAgeMs: 14 * DAY })).toBe(true);
  });
});
