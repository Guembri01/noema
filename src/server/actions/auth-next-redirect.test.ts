import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B28 — the `next` parameter of the sign-in form.
 *
 * A successful sign-in sends the browser to the `next` the form carried. Only
 * a destination inside the app may be used: the URL parser reads a backslash
 * in a special scheme as a slash, so `/\evil.example` leaves the origin, and
 * a percent-encoded `//` decodes to one. The weakened check
 * (`startsWith("/") && !startsWith("//")`) admits all of them.
 *
 * The hardened check (`isSafeReturnTo` in `src/lib/auth-strategies.ts`) is the
 * real module; only the database, the session issuer and the router are
 * mocked, so the check runs exactly as the server runs it.
 */

const h = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  userCreate: vi.fn(),
  workspaceFindFirst: vi.fn(),
  workspaceMemberFindFirst: vi.fn(),
  pageCreate: vi.fn(),
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
  createSession: vi.fn(),
  destroySession: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: h.userFindUnique,
      update: h.userUpdate,
      create: h.userCreate,
    },
    workspace: { findFirst: h.workspaceFindFirst },
    workspaceMember: { findFirst: h.workspaceMemberFindFirst },
    page: { create: h.pageCreate },
  },
}));
vi.mock("@/lib/auth", () => ({
  hashPassword: h.hashPassword,
  verifyPassword: h.verifyPassword,
  createSession: h.createSession,
  destroySession: h.destroySession,
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

import { redirect } from "next/navigation";
import { resetAuthLimits } from "@/lib/rate-limit";
import { loginAction } from "./auth";

/**
 * The stored hash of the fixture user: a real bcrypt hash at the cost 12
 * `hashPassword` uses, so the sign-in path sees the shape it expects.
 */
const STORED_HASH =
  "$2b$12$DDATzCAs4idfq89J5AQgj.xDjyjiwPleCbBHhzWDH1HywDCLKgoYi";

/**
 * The destinations that only look like a path. Each of them is admitted by
 * the weakened check `startsWith("/") && !startsWith("//")` and refused by
 * `isSafeReturnTo`.
 */
const OFF_ORIGIN_NEXT = [
  // A backslash is a slash in a special scheme, so the parser reads
  // `/\evil.example` as the host `evil.example`.
  "/\\evil.example",
  // The same, percent-encoded — the link an attacker spreads.
  "/%5Cevil.example",
  // A percent-encoded protocol-relative URL.
  "/%2F%2Fevil.example",
];

/** A `next` the URL parser rewrites instead of reading (it drops the NUL). */
const REWRITTEN_NEXT = "/\u0000evil.example";

const ENV_KEYS = ["AUTH_PASSWORD", "AUTH_STRATEGIES"] as const;
const savedEnv = new Map<string, string | undefined>();

/** A sign-in form for the fixture user, with an optional `next`. */
function loginForm(next?: string): FormData {
  const form = new FormData();
  form.set("email", "member@example.test");
  form.set("password", "Vivid-Quartz-91!Lantern");
  if (next !== undefined) form.set("next", next);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAuthLimits();
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  h.userFindUnique.mockResolvedValue({
    id: "user-1",
    email: "member@example.test",
    passwordHash: STORED_HASH,
    twoFactorEnabled: false,
    twoFactorSecret: null,
    failedLoginCount: 0,
    lockedUntil: null,
  });
  h.userUpdate.mockResolvedValue({ failedLoginCount: 0 });
  h.verifyPassword.mockResolvedValue(true);
  h.createSession.mockResolvedValue(undefined);
  h.workspaceMemberFindFirst.mockResolvedValue(null);
  h.workspaceFindFirst.mockResolvedValue({ slug: "acme" });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("loginAction — the `next` parameter", () => {
  it("follows a `next` that stays inside the app", async () => {
    await expect(
      loginAction({}, loginForm("/w/acme/roadmap")),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(vi.mocked(redirect)).toHaveBeenCalledWith("/w/acme/roadmap");
  });

  it("follows the `next` the invitation pages produce", async () => {
    // An unclaimed invitation sends the user to the sign-in form with the
    // path of the invitation in `next` (a base64url token, so the path
    // carries no percent-encoding).
    const token = "3Qh1x7bB0kP2sV8nL5mZ9dRf4TgW6yU";

    for (const next of [`/invite/${token}`, `/invite/teamspace/${token}`]) {
      vi.mocked(redirect).mockClear();

      await expect(loginAction({}, loginForm(next))).rejects.toThrow(
        "NEXT_REDIRECT",
      );

      expect(vi.mocked(redirect)).toHaveBeenCalledWith(next);
    }
  });

  it("lands on the workspace when no `next` is given", async () => {
    await expect(loginAction({}, loginForm())).rejects.toThrow("NEXT_REDIRECT");

    expect(vi.mocked(redirect)).toHaveBeenCalledWith("/w/acme");
  });

  it("never hands a `next` the URL parser would read as another origin", async () => {
    for (const next of OFF_ORIGIN_NEXT) {
      vi.mocked(redirect).mockClear();

      await expect(loginAction({}, loginForm(next))).rejects.toThrow(
        "NEXT_REDIRECT",
      );

      // The sign-in itself still succeeds — only the destination changes.
      expect(h.createSession).toHaveBeenCalledWith("user-1");
      expect(vi.mocked(redirect)).toHaveBeenCalledWith("/w/acme");
      expect(vi.mocked(redirect)).not.toHaveBeenCalledWith(next);
    }
  });

  it("never hands a `next` the URL parser would rewrite", async () => {
    vi.mocked(redirect).mockClear();

    await expect(
      loginAction({}, loginForm(REWRITTEN_NEXT)),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(vi.mocked(redirect)).toHaveBeenCalledWith("/w/acme");
    expect(vi.mocked(redirect)).not.toHaveBeenCalledWith(REWRITTEN_NEXT);
  });
});
