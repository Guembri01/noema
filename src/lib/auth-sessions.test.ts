import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, decodeJwt } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B54 — session lifecycle through the REAL src/lib/auth.ts (JWT + registry).
 *
 * `next/headers` is replaced by an in-memory cookie jar + a fixed user-agent,
 * everything else (jose signing, the session registry) is real. The store
 * lives in a per-test tmp file so the app's `.data/sessions.json` is never
 * touched.
 *
 * Red-first targets:
 *  - "a revoked session dies on the next request" — the per-request check in
 *    `getSessionUserId` is the whole revocation guarantee;
 *  - logout must revoke the record, not only delete the cookie (a stolen copy
 *    of the token has to be dead too).
 */

process.env.AUTH_SECRET = "b54-unit-secret-0123456789abcdef";

const jar = vi.hoisted(() => new Map<string, string>());

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";

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

import { createSession, destroySession, getSessionUserId } from "@/lib/auth";
import { isSessionRevoked, listActiveSessions } from "@/lib/session-store";

const COOKIE = "noema_session";

let dir: string;

beforeEach(() => {
  jar.clear();
  dir = mkdtempSync(join(tmpdir(), "b54-auth-session-"));
  process.env.SESSION_STORE_PATH = join(dir, "sessions.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SESSION_STORE_PATH;
});

async function currentSid(): Promise<string> {
  const token = jar.get(COOKIE);
  if (!token) throw new Error("no session cookie issued");
  const payload = decodeJwt(token);
  if (typeof payload.sid !== "string") throw new Error("token carries no sid claim");
  return payload.sid;
}

describe("session issue", () => {
  it("issues a session that resolves the user and records its device", async () => {
    await createSession("user-a");

    expect(await getSessionUserId()).toBe("user-a");

    const listed = listActiveSessions("user-a");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.sid).toBe(await currentSid());
    expect(listed[0]?.device).toBe("Edge on Windows");
  });

  it("issues a distinct sid per sign-in (two devices, two records)", async () => {
    await createSession("user-a");
    const first = await currentSid();
    jar.clear();
    await createSession("user-a");
    const second = await currentSid();

    expect(second).not.toBe(first);
    expect(listActiveSessions("user-a")).toHaveLength(2);
  });
});

describe("session revocation — dies on the next request", () => {
  it("a revoked session no longer resolves the user", async () => {
    await createSession("user-a");
    const sid = await currentSid();

    // Revoke this exact device (as the owner).
    const { revokeSessionForUser } = await import("@/lib/session-store");
    expect(revokeSessionForUser(sid, "user-a")).toBe("revoked");

    expect(await getSessionUserId()).toBeNull();
  });

  it("revoking one device kills it while the sibling device stays signed in", async () => {
    await createSession("user-a");
    const tokenA = jar.get(COOKIE) as string;
    const deviceA = await currentSid();
    jar.clear();
    await createSession("user-a");
    const deviceB = await currentSid();

    const { revokeSessionForUser } = await import("@/lib/session-store");
    expect(revokeSessionForUser(deviceB, "user-a")).toBe("revoked");

    // The revoked device's own cookie is dead on its very next request…
    expect(await getSessionUserId()).toBeNull();
    // …while the sibling device is untouched.
    jar.set(COOKIE, tokenA);
    expect(await getSessionUserId()).toBe("user-a");
    expect(listActiveSessions("user-a").map((r) => r.sid)).toEqual([deviceA]);
  });

  it("logout destroys the record so a replayed copy of the cookie is dead", async () => {
    await createSession("user-a");
    const token = jar.get(COOKIE) as string;
    const sid = await currentSid();

    await destroySession();
    expect(jar.has(COOKIE)).toBe(false);
    expect(isSessionRevoked(sid)).toBe(true);

    // Plant the stolen copy back: it must NOT resolve.
    jar.set(COOKIE, token);
    expect(await getSessionUserId()).toBeNull();
  });
});

describe("legacy tokens (no sid claim)", () => {
  it("a sid-less token issued before B54 still resolves the user", async () => {
    // Characterization: pre-B54 cookies carry only `sub`. They are not listed
    // or individually revocable, but they must not be mass-logged-out by the
    // deploy.
    const legacy = await new SignJWT({ sub: "legacy-user" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(new TextEncoder().encode(process.env.AUTH_SECRET as string));
    jar.set(COOKIE, legacy);

    expect(await getSessionUserId()).toBe("legacy-user");
  });
});
