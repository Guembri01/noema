import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B03 — the sign-in / sign-up actions are server actions, so they never
 * reached the API rate limit: the password could be guessed as fast as
 * bcrypt allows, the account was never locked and the 2FA code could be
 * searched at will.
 *
 * These tests pin the three defences that close it:
 *   - a budget per client address and per account, charged before any
 *     password work happens;
 *   - a persisted failure counter that locks the account temporarily;
 *   - a separate budget for 2FA code guesses.
 *
 * Only the database edge is mocked — the limiter, the backoff rule and the
 * actions themselves are the real ones.
 */

type UserRow = {
  id: string;
  email: string;
  passwordHash: string;
  twoFactorEnabled: boolean;
  twoFactorSecret: string | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
};

type FindArgs = { where: { email?: string; id?: string } };
type UpdateArgs = {
  where: { id: string };
  data: {
    failedLoginCount?: number | { increment: number };
    lockedUntil?: Date | null;
  };
};

const h = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  userCreate: vi.fn(),
  createSession: vi.fn(),
  verifyPassword: vi.fn(),
  workspaceFindFirst: vi.fn(),
  memberFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: h.userFindUnique,
      update: h.userUpdate,
      create: h.userCreate,
    },
    workspace: { create: vi.fn(), findFirst: h.workspaceFindFirst },
    workspaceMember: { findFirst: h.memberFindFirst, create: vi.fn() },
    page: { create: vi.fn() },
  },
}));
vi.mock("@/lib/auth", () => ({
  createSession: h.createSession,
  destroySession: vi.fn(),
  hashPassword: vi.fn(async () => "hashed"),
  verifyPassword: h.verifyPassword,
}));
vi.mock("@/lib/totp", () => ({ verifyTotp: vi.fn(() => false) }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));
vi.mock("@/server/unique", () => ({
  uniqueWorkspaceSlug: vi.fn(async () => "acme"),
}));
vi.mock("@/lib/welcome", () => ({
  welcomeDoc: () => ({ type: "doc", content: [] }),
}));

import { loginAction, signupAction } from "./auth";
import {
  AUTH_TWO_FACTOR_LIMIT,
  DEFAULT_RATE_TIERS,
  checkTwoFactorLimit,
  resetAuthLimits,
} from "@/lib/rate-limit";

/** The single user row the mocked database holds. */
let user: UserRow;

/** Build a `FormData` the way the sign-in form submits it. */
function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

const SIGN_IN = { email: "victim@corp.test", password: "correct-horse" };

beforeEach(() => {
  vi.clearAllMocks();
  resetAuthLimits();
  // The two-factor seed is sealed at rest (B05): a row that still holds a
  // cleartext seed is re-sealed on the first successful sign-in, and a
  // re-seal that cannot be done denies the sign-in (fail closed). Without a
  // usable `AUTH_SECRET` nothing can be sealed, so the test needs one.
  process.env.AUTH_SECRET = "auth-test-secret-for-the-two-factor-gate";
  user = {
    id: "user-1",
    email: "victim@corp.test",
    // #127 validates the stored value's bcrypt shape before comparing.
    passwordHash: "$2b$12$DDATzCAs4idfq89J5AQgj.xDjyjiwPleCbBHhzWDH1HywDCLKgoYi",
    twoFactorEnabled: false,
    twoFactorSecret: null,
    failedLoginCount: 0,
    lockedUntil: null,
  };
  h.userFindUnique.mockImplementation(async (args: FindArgs) => {
    if (args.where.email && args.where.email !== user.email) return null;
    if (args.where.id && args.where.id !== user.id) return null;
    return { ...user };
  });
  h.userUpdate.mockImplementation(async (args: UpdateArgs) => {
    const count = args.data.failedLoginCount;
    if (typeof count === "number") user.failedLoginCount = count;
    else if (count && typeof count === "object") user.failedLoginCount += count.increment;
    if ("lockedUntil" in args.data) user.lockedUntil = args.data.lockedUntil ?? null;
    return { ...user };
  });
  h.workspaceFindFirst.mockResolvedValue(null);
  h.memberFindFirst.mockResolvedValue(null);
});

describe("sign-in lockout and failure counter", () => {
  it("counts a failed sign-in", async () => {
    h.verifyPassword.mockResolvedValue(false);
    const res = await loginAction({}, form({ ...SIGN_IN, password: "wrong" }));
    expect(res.error).toBe("Incorrect email or password.");
    expect(user.failedLoginCount).toBe(1);
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it("locks the account after the threshold and refuses the correct password", async () => {
    h.verifyPassword.mockResolvedValue(false);
    for (let i = 0; i < 5; i++) {
      const res = await loginAction({}, form({ ...SIGN_IN, password: "wrong" }));
      expect(res.error).toBe("Incorrect email or password.");
    }
    expect(user.failedLoginCount).toBe(5);
    expect(user.lockedUntil).not.toBeNull();

    // the lock holds even when the password is right
    h.verifyPassword.mockResolvedValue(true);
    const locked = await loginAction({}, form(SIGN_IN));
    // The lock is enforced, but the reply is the same neutral text as any
    // other failure: "temporarily locked" would confirm the address exists.
    expect(locked.error).toBe("Incorrect email or password.");
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it("clears the counter and the lock after a successful sign-in", async () => {
    user.failedLoginCount = 3;
    user.lockedUntil = new Date(Date.now() - 1000); // an expired lock
    h.verifyPassword.mockResolvedValue(true);
    await expect(loginAction({}, form(SIGN_IN))).rejects.toThrow("NEXT_REDIRECT");
    expect(h.createSession).toHaveBeenCalledTimes(1);
    expect(user.failedLoginCount).toBe(0);
    expect(user.lockedUntil).toBeNull();
  });
});

describe("sign-in rate limit", () => {
  it("refuses further attempts once the account budget is spent", async () => {
    h.verifyPassword.mockResolvedValue(true);
    for (let i = 0; i < DEFAULT_RATE_TIERS.AUTH.limit; i++) {
      await expect(loginAction({}, form(SIGN_IN))).rejects.toThrow("NEXT_REDIRECT");
    }
    const res = await loginAction({}, form(SIGN_IN));
    expect(res.error).toMatch(/Too many attempts/);
    expect(h.createSession).toHaveBeenCalledTimes(DEFAULT_RATE_TIERS.AUTH.limit);
  });

  it("refuses a sign-up once the account budget is spent", async () => {
    user.email = "newcomer@corp.test";
    const signUp = {
      name: "New Comer",
      email: "newcomer@corp.test",
      password: "Str0ngPassphrase",
    };
    for (let i = 0; i < DEFAULT_RATE_TIERS.AUTH.limit; i++) {
      const res = await signupAction({}, form(signUp));
      // #127's neutral sign-up text replaced the enumeration-prone
      // "already exists" answer.
      expect(res.error).toMatch(/could not create the account/);
    }
    const res = await signupAction({}, form(signUp));
    expect(res.error).toMatch(/Too many attempts/);
  });
});

describe("two-factor verification", () => {
  it("counts a wrong code as a failed sign-in", async () => {
    user.twoFactorEnabled = true;
    user.twoFactorSecret = "JBSWY3DPEHPK3PXP";
    h.verifyPassword.mockResolvedValue(true);
    const res = await loginAction(
      {},
      form({ ...SIGN_IN, code: "000000" }),
    );
    // Same neutral text as a wrong password: the code field's presence must
    // not confirm that the password was right.
    expect(res.error).toBe("Incorrect email or password.");
    expect(res.requiresTwoFactor).toBe(true);
    // A wrong 2FA code uses its own budget; it must not lock the password
    // account (an attacker with the password could otherwise DoS it).
    expect(user.failedLoginCount).toBe(0);
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it("asks for the code before verifying it", async () => {
    user.twoFactorEnabled = true;
    user.twoFactorSecret = "JBSWY3DPEHPK3PXP";
    h.verifyPassword.mockResolvedValue(true);
    const res = await loginAction({}, form(SIGN_IN));
    expect(res.requiresTwoFactor).toBe(true);
    expect(res.error).toBeUndefined();
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it("refuses further code guesses once the guess budget is spent", async () => {
    user.twoFactorEnabled = true;
    user.twoFactorSecret = "JBSWY3DPEHPK3PXP";
    h.verifyPassword.mockResolvedValue(true);
    for (let i = 0; i < AUTH_TWO_FACTOR_LIMIT.limit; i++) {
      checkTwoFactorLimit({ key: "victim@corp.test" });
    }
    const res = await loginAction({}, form({ ...SIGN_IN, code: "000000" }));
    expect(res.error).toMatch(/Too many attempts/);
    expect(h.createSession).not.toHaveBeenCalled();
  });
});
