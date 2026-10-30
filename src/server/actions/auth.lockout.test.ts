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
 *
 * P3-T03 — the lock write must not lose a race: a failing sign-in parked
 * *between* its counter increment and its lock write cannot overwrite a
 * bigger lock a concurrent failure armed. The mock reproduces that
 * interleaving by parking a writer in the middle of `registerFailedLogin`
 * (see `parkNextWriter`) and by giving `user.updateMany` the statement
 * semantics the fix relies on: the where-condition and the write run as
 * one indivisible step against the row as it stands.
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

/** One where-clause of a conditional lock write (`lockedUntil` only). */
type LockClause = { lockedUntil: null } | { lockedUntil: { lt?: Date; lte?: Date } };
type UpdateManyArgs = {
  where: { id: string; OR?: LockClause[] };
  data: { lockedUntil?: Date | null };
};

const h = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  userUpdateMany: vi.fn(),
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
      updateMany: h.userUpdateMany,
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
// B25: the sign-in asks for the time step a code belongs to; the mock refuses
// every code, like a wrong one.
vi.mock("@/lib/totp", () => ({ verifyTotpCounter: vi.fn(() => null) }));
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

/**
 * When armed by `parkNextWriter`, the *next* failing sign-in is parked right
 * after it has applied its counter increment — it has consumed the increment
 * statement and holds the fresh count, but it has not written its lock yet.
 * Releasing it then reproduces a slow client racing a concurrent failure.
 */
let holdNextWriter: Promise<void> | null = null;

/** Park the next failing sign-in between its two statements. */
function parkNextWriter(): { release: () => void } {
  let release!: () => void;
  holdNextWriter = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release };
}

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
    if (count && typeof count === "object") {
      user.failedLoginCount += count.increment;
      // A real statement returns the count *as of its own execution* — the
      // cursor is fixed here, before the client is parked between its two
      // statements. A later concurrent increment is not this writer's news.
      const own = user.failedLoginCount;
      // P3-T03: a parked writer sits HERE — increment landed, lock write not
      // issued yet. Everything a concurrent failure commits before the test
      // releases it happens "between" this writer's two statements.
      if (holdNextWriter) {
        const hold = holdNextWriter;
        holdNextWriter = null;
        await hold;
      }
      return { ...user, failedLoginCount: own };
    }
    if (typeof count === "number") user.failedLoginCount = count;
    if ("lockedUntil" in args.data) user.lockedUntil = args.data.lockedUntil ?? null;
    return { ...user };
  });
  /**
   * A conditional `updateMany`, with the statement semantics the fix relies
   * on: the where-condition is read and the value written in one indivisible
   * step against the row as it stands. A NULL lock satisfies only the
   * `lockedUntil: null` clause; a comparison (`lt` / `lte`) never matches
   * NULL — exactly what SQL does. An unmatched row is left untouched.
   */
  h.userUpdateMany.mockImplementation(async (args: UpdateManyArgs) => {
    if (args.where.id !== user.id) return { count: 0 };
    const match = (args.where.OR ?? []).some((clause) => {
      const until = user.lockedUntil;
      if (clause.lockedUntil === null) return until === null;
      if (until === null) return false;
      if (clause.lockedUntil?.lt)
        return until.getTime() < clause.lockedUntil.lt.getTime();
      if (clause.lockedUntil?.lte)
        return until.getTime() <= clause.lockedUntil.lte.getTime();
      return false;
    });
    if (!match) return { count: 0 };
    if ("lockedUntil" in args.data) user.lockedUntil = args.data.lockedUntil ?? null;
    return { count: 1 };
  });
  holdNextWriter = null;
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

describe("concurrent failures — the larger backoff survives (P3-T03)", () => {
  /**
   * Two sign-in failures for the same account race each other. One writer is
   * parked between its counter increment and its lock write; the other one
   * completes its whole failure flow first. Whatever the parked writer
   * proposes must not be able to shrink the lock the other one left on the
   * row — the backoff only ever moves forward in time.
   */
  it("a delayed smaller failure cannot overwrite a bigger lock with a smaller one", async () => {
    h.verifyPassword.mockResolvedValue(false);
    user.failedLoginCount = 4; // the slow writer crosses the threshold: a 15 s lock
    const { release } = parkNextWriter();

    const slow = loginAction({}, form({ ...SIGN_IN, password: "wrong" }));
    // The slow writer has landed its increment (4 → 5) and is parked holding
    // its stale count.
    await vi.waitFor(() => expect(user.failedLoginCount).toBe(5));

    // The fast writer runs the whole flow: it increments to 6, so its own
    // backoff is the larger one (30 s), and it arms the row.
    const fast = await loginAction({}, form({ ...SIGN_IN, password: "wrong" }));
    expect(fast.error).toBe("Incorrect email or password.");
    expect(user.failedLoginCount).toBe(6);
    const armed = user.lockedUntil;
    expect(armed).not.toBeNull();

    // Only now does the slow writer's lock write reach the row.
    release();
    const slowResult = await slow;
    expect(slowResult.error).toBe("Incorrect email or password.");

    // The 30 s lock of the fast writer survived the slower, smaller proposal.
    expect(user.lockedUntil).toBe(armed);
  });

  it("a delayed below-threshold failure cannot drop a lock a concurrent writer armed", async () => {
    h.verifyPassword.mockResolvedValue(false);
    user.failedLoginCount = 3; // the slow writer reads 4 — under the threshold
    const { release } = parkNextWriter();

    const slow = loginAction({}, form({ ...SIGN_IN, password: "wrong" }));
    await vi.waitFor(() => expect(user.failedLoginCount).toBe(4));

    const fast = await loginAction({}, form({ ...SIGN_IN, password: "wrong" }));
    expect(fast.error).toBe("Incorrect email or password.");
    const armed = user.lockedUntil; // the 5th failure is the threshold lock
    expect(armed).not.toBeNull();

    release();
    const slowResult = await slow;
    expect(slowResult.error).toBe("Incorrect email or password.");

    expect(user.failedLoginCount).toBe(5);
    // "No lock" is the smallest backoff there is — clearing it just because a
    // slower writer's count is small would silently end the account lock.
    expect(user.lockedUntil).toBe(armed);
  });

  it("keeps the plain increment path — failures below the threshold arm nothing", async () => {
    h.verifyPassword.mockResolvedValue(false);
    for (let i = 0; i < 3; i++) {
      const res = await loginAction({}, form({ ...SIGN_IN, password: "wrong" }));
      expect(res.error).toBe("Incorrect email or password.");
    }
    expect(user.failedLoginCount).toBe(3);
    expect(user.lockedUntil).toBeNull();
  });

  it("treats an expired lock as unlocked and cleans it up on the next failure", async () => {
    h.verifyPassword.mockResolvedValue(false);
    user.failedLoginCount = 2;
    user.lockedUntil = new Date(Date.now() - 1_000); // expired a second ago
    const res = await loginAction({}, form({ ...SIGN_IN, password: "wrong" }));
    expect(res.error).toBe("Incorrect email or password.");
    // The failure was recorded (the gate did not refuse it)…
    expect(user.failedLoginCount).toBe(3);
    // … and the expired lock value was wiped while nothing new was armed.
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
