import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B39 — the request path enforces the deadline of a session.
 *
 * The registry (src/lib/session-store.ts) knows when a session dies; the
 * request path (`getSessionUserId` in src/lib/auth.ts) is what turns that into
 * "the cookie no longer works". Before the fix the request path only asked
 * for the revocation flag, so a stolen cookie stayed usable for the whole
 * 30-day lifetime of the JWT — no matter how long it went unused.
 *
 * `next/headers` is replaced by an in-memory cookie jar and the clock is
 * faked, so the idle window can be crossed deterministically. The registry
 * itself is real and lives in a per-test tmp file — the app's
 * `.data/sessions.json` is never touched.
 */

process.env.AUTH_SECRET = "b39-unit-secret-0123456789abcdef";

const jar = vi.hoisted(() => new Map<string, string>());

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) as string } : undefined),
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
  headers: async () => new Headers({ "user-agent": USER_AGENT }),
}));

import { createSession, getSessionUserId } from "@/lib/auth";

const COOKIE = "noema_session";
const HOUR = 60 * 60 * 1000;
/** The idle window the request path enforces (SESSION_IDLE_MS in src/lib/auth.ts). */
const IDLE = 12 * HOUR;
/** A fixed start instant — the clock is fake, so the walk is deterministic. */
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

let dir: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  jar.clear();
  dir = mkdtempSync(join(tmpdir(), "b39-session-idle-"));
  process.env.SESSION_STORE_PATH = join(dir, "sessions.json");
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SESSION_STORE_PATH;
});

describe("session idle timeout — the request path", () => {
  it("a session that goes unused past the idle window is dead on its next request", async () => {
    await createSession("user-a");
    expect(await getSessionUserId()).toBe("user-a");

    // No request for 13 hours: the cookie is stale.
    vi.setSystemTime(T0 + 13 * HOUR);
    expect(await getSessionUserId()).toBeNull();
  });

  it("measures the idle window from the last activity, not from the sign-in", async () => {
    await createSession("user-a");
    expect(await getSessionUserId()).toBe("user-a");

    // Activity 11 hours in — the window restarts from here.
    vi.setSystemTime(T0 + 11 * HOUR);
    expect(await getSessionUserId()).toBe("user-a");

    // Exactly at the deadline the session is over.
    vi.setSystemTime(T0 + 11 * HOUR + IDLE);
    expect(await getSessionUserId()).toBeNull();
  });

  it("keeps a session that is used alive", async () => {
    await createSession("user-a");
    for (let hour = 0; hour < 24; hour += 1) {
      vi.setSystemTime(T0 + hour * HOUR);
      expect(await getSessionUserId()).toBe("user-a");
    }
  });

  it("fails open when the registry does not know the session", async () => {
    await createSession("user-a");
    // The registry file is gone (wiped volume, fresh deploy): the request
    // must not sign every device out.
    rmSync(join(dir, "sessions.json"), { force: true });
    expect(await getSessionUserId()).toBe("user-a");
  });

  it("keeps the cookie itself — an expired session is not deleted, only refused", async () => {
    await createSession("user-a");
    vi.setSystemTime(T0 + 13 * HOUR);

    expect(await getSessionUserId()).toBeNull();
    expect(jar.has(COOKIE)).toBe(true);
  });
});
