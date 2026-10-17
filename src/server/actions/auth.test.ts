import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

/**
 * B03 + B24 — the sign-in / sign-up actions.
 *
 * B03 (upstream #17) closes the missing rate limit: the server actions never
 * reached the API rate limit, so the password could be guessed as fast as
 * bcrypt allows, the account was never locked and the 2FA code could be
 * searched at will. Three defences are pinned here:
 *
 *   - a budget per client address and per account, charged before any
 *     password work happens;
 *   - a persisted failure counter that locks the account temporarily;
 *   - a separate budget for 2FA code guesses.
 *
 * B24 (upstream #31) closes the account enumeration: the sign-up and the
 * sign-in must not disclose whether an address is registered. Three channels
 * are pinned here:
 *
 *   - the sign-up answer for an address that is already registered is the very
 *     same text as the answer for a sign-up that lost the race against a
 *     concurrent sign-up for the same address, and it names neither the reason
 *     nor an e-mail the app would never send;
 *   - a sign-in for an address that does not exist still runs a bcrypt
 *     comparison — against a real cost-12 dummy hash — so the response time
 *     does not give the account away;
 *   - a wrong two-factor code answers with the same text as a wrong password.
 *
 * Both suites live in this one file: the two branches mocked the same modules
 * with the same shapes, so there is one coherent mock set (one `vi.mock` per
 * module). Only the database edge, the session edge and the router are
 * mocked — the limiter, the schemas, the password policy and the TOTP check
 * run for real.
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
  workspaceCreate: vi.fn(),
  workspaceFindFirst: vi.fn(),
  memberFindFirst: vi.fn(),
  pageCreate: vi.fn(),
  createSession: vi.fn(),
  destroySession: vi.fn(),
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: h.userFindUnique,
      update: h.userUpdate,
      create: h.userCreate,
    },
    workspace: { create: h.workspaceCreate, findFirst: h.workspaceFindFirst },
    workspaceMember: { findFirst: h.memberFindFirst, create: vi.fn() },
    page: { create: h.pageCreate },
  },
}));
vi.mock("@/lib/auth", () => ({
  createSession: h.createSession,
  destroySession: h.destroySession,
  hashPassword: h.hashPassword,
  verifyPassword: h.verifyPassword,
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock("@/server/unique", () => ({
  uniqueWorkspaceSlug: vi.fn(async () => "acme"),
}));
vi.mock("@/lib/welcome", () => ({
  welcomeDoc: () => ({ type: "doc", content: [] }),
}));

import { totp } from "@/lib/totp";
import { loginAction, signupAction } from "./auth";
import {
  AUTH_TWO_FACTOR_LIMIT,
  DEFAULT_RATE_TIERS,
  checkTwoFactorLimit,
  resetAuthLimits,
} from "@/lib/rate-limit";

/** The single user row the mocked database holds (B03's fixture). */
let user: UserRow;

/** A password the policy accepts (upper, lower, digit, long enough). */
const GOOD_PASSWORD = "Vivid-Quartz-91!Lantern";
/** The shape of a bcrypt hash: `$2<variant>$<cost>$<53 chars>`. */
const BCRYPT_SHAPE = /^\$2[aby]\$(?:0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/;
/** The cost `hashPassword` uses — the dummy hash has to match it. */
const BCRYPT_COST = 12;
/**
 * The stored hash of the fixture user. A real bcrypt hash (cost 4 keeps the
 * test fast) — the sign-in only reaches the account when the stored value is
 * a hash bcrypt can work with.
 */
const STORED_HASH = bcrypt.hashSync(GOOD_PASSWORD, 4);
/** A base32 TOTP secret for the two-factor fixtures. */
const TOTP_SECRET = "JBSWY3DPEHPK3PXP";
/**
 * A code that can never be the valid one: it belongs to the time step at the
 * epoch, so the comparison against the current window is decided, not lucky.
 */
const STALE_CODE = totp(TOTP_SECRET, 0);

/** Build a `FormData` the way the sign-in form submits it. */
function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

const SIGN_IN = { email: "victim@corp.test", password: GOOD_PASSWORD };

/**
 * A registered user, as `prisma.user.findUnique` hands it back. The counter
 * and the lock belong to the row (B03), the rest to the account (B24).
 */
function registeredUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    email: "member@example.test",
    passwordHash: STORED_HASH,
    twoFactorEnabled: false,
    twoFactorSecret: null,
    failedLoginCount: 0,
    lockedUntil: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAuthLimits();
  user = {
    id: "user-1",
    email: "victim@corp.test",
    passwordHash: STORED_HASH,
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
  h.hashPassword.mockImplementation(async (password: string) =>
    bcrypt.hashSync(password, 4),
  );
  h.verifyPassword.mockImplementation(
    async (password: string, hash: string) =>
      hash === STORED_HASH && password === GOOD_PASSWORD,
  );
  h.createSession.mockResolvedValue(undefined);
  h.destroySession.mockResolvedValue(undefined);
  h.workspaceCreate.mockResolvedValue({ id: "ws-1", slug: "acme" });
  h.workspaceFindFirst.mockResolvedValue({ slug: "acme" });
  h.memberFindFirst.mockResolvedValue(null);
  h.pageCreate.mockResolvedValue({ id: "page-1" });
});

/* ------------------------------------------------------------------ *
 * B03 — the budgets, the counter and the lock.
 * ------------------------------------------------------------------ */

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
    expect(locked.error).toMatch(/temporarily locked/);
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it("clears the counter and the lock after a successful sign-in", async () => {
    user.failedLoginCount = 3;
    user.lockedUntil = new Date(Date.now() - 1000); // an expired lock
    h.verifyPassword.mockResolvedValue(true);
    await expect(loginAction({}, form(SIGN_IN))).rejects.toThrow("REDIRECT:");
    expect(h.createSession).toHaveBeenCalledTimes(1);
    expect(user.failedLoginCount).toBe(0);
    expect(user.lockedUntil).toBeNull();
  });
});

describe("sign-in rate limit", () => {
  it("refuses further attempts once the account budget is spent", async () => {
    h.verifyPassword.mockResolvedValue(true);
    for (let i = 0; i < DEFAULT_RATE_TIERS.AUTH.limit; i++) {
      await expect(loginAction({}, form(SIGN_IN))).rejects.toThrow("REDIRECT:");
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
      password: GOOD_PASSWORD,
    };
    for (let i = 0; i < DEFAULT_RATE_TIERS.AUTH.limit; i++) {
      const res = await signupAction({}, form(signUp));
      // The neutral sign-up text (B24) — the budget is not what refuses it.
      expect(res.error).toBe(
        "We could not create the account for this address. If you already have an account, sign in instead.",
      );
    }
    const res = await signupAction({}, form(signUp));
    expect(res.error).toMatch(/Too many attempts/);
    expect(h.userCreate).not.toHaveBeenCalled();
  });
});

describe("two-factor verification", () => {
  it("counts a wrong code as a failed sign-in", async () => {
    user.twoFactorEnabled = true;
    user.twoFactorSecret = TOTP_SECRET;
    h.verifyPassword.mockResolvedValue(true);
    const res = await loginAction({}, form({ ...SIGN_IN, code: STALE_CODE }));
    // The neutral sign-in text (B24): a text of its own would confirm that the
    // password was right.
    expect(res.error).toBe("Incorrect email or password.");
    expect(res.requiresTwoFactor).toBe(true);
    expect(user.failedLoginCount).toBe(1);
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it("asks for the code before verifying it", async () => {
    user.twoFactorEnabled = true;
    user.twoFactorSecret = TOTP_SECRET;
    h.verifyPassword.mockResolvedValue(true);
    const res = await loginAction({}, form(SIGN_IN));
    expect(res.requiresTwoFactor).toBe(true);
    expect(res.error).toBeUndefined();
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it("refuses further code guesses once the guess budget is spent", async () => {
    user.twoFactorEnabled = true;
    user.twoFactorSecret = TOTP_SECRET;
    h.verifyPassword.mockResolvedValue(true);
    for (let i = 0; i < AUTH_TWO_FACTOR_LIMIT.limit; i++) {
      checkTwoFactorLimit({ key: "victim@corp.test" });
    }
    const res = await loginAction({}, form({ ...SIGN_IN, code: STALE_CODE }));
    expect(res.error).toMatch(/Too many attempts/);
    expect(h.createSession).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * B24 — the answer never discloses whether an address is registered.
 * ------------------------------------------------------------------ */

describe("signupAction — the answer never names that an address is registered", () => {
  it("answers a registered address exactly like a sign-up that lost the race", async () => {
    h.userFindUnique.mockResolvedValue(registeredUser());
    const registered = await signupAction(
      {},
      form({
        name: "Ada",
        email: "member@example.test",
        password: GOOD_PASSWORD,
      }),
    );

    // The address looked free, but a concurrent sign-up for it won the race.
    h.userFindUnique.mockResolvedValue(null);
    h.userCreate.mockRejectedValue({ code: "P2002" });
    const raced = await signupAction(
      {},
      form({
        name: "Ada",
        email: "member@example.test",
        password: GOOD_PASSWORD,
      }),
    );

    expect(registered).toEqual(raced);
    expect(registered.error).toBeTruthy();
    // Neither the reason nor a promise of an e-mail the app never sends.
    expect(registered.error).not.toMatch(/exist|taken|registered|mail/i);
    expect(registered.error).not.toBe("An account with that email already exists.");
  });

  it("pays the same password-hashing cost whether or not the address is free", async () => {
    h.userFindUnique.mockResolvedValue(registeredUser());

    await signupAction(
      {},
      form({
        name: "Ada",
        email: "member@example.test",
        password: GOOD_PASSWORD,
      }),
    );

    expect(h.hashPassword).toHaveBeenCalledTimes(1);
    // The hash is computed before the lookup, so a registered address is not
    // answered measurably faster than a free one.
    expect(h.hashPassword.mock.invocationCallOrder[0]).toBeLessThan(
      h.userFindUnique.mock.invocationCallOrder[0],
    );
    expect(h.userCreate).not.toHaveBeenCalled();
  });

  it("still creates the account, the workspace and the session for a free address", async () => {
    h.userFindUnique.mockResolvedValue(null);
    h.userCreate.mockResolvedValue({ id: "user-2" });

    await expect(
      signupAction(
        {},
        form({
          name: "Ada",
          email: "new@example.test",
          password: GOOD_PASSWORD,
        }),
      ),
    ).rejects.toThrow("REDIRECT:/w/acme");

    expect(h.userCreate).toHaveBeenCalledTimes(1);
    expect(h.createSession).toHaveBeenCalledWith("user-2");
  });
});

describe("loginAction — the sign-in cost does not depend on the account", () => {
  it("still runs a bcrypt comparison for an address that does not exist", async () => {
    h.userFindUnique.mockResolvedValue(null);

    const result = await loginAction(
      {},
      form({ email: "ghost@example.test", password: "whatever" }),
    );

    expect(result).toEqual({ error: "Incorrect email or password." });
    expect(h.verifyPassword).toHaveBeenCalledTimes(1);
    const [, hash] = h.verifyPassword.mock.calls[0];
    // A real bcrypt hash at the cost `hashPassword` uses, so the comparison
    // costs what a real one costs.
    expect(hash).toMatch(BCRYPT_SHAPE);
    expect(bcrypt.getRounds(hash)).toBe(BCRYPT_COST);
  });

  it("answers a wrong password and an unknown address with the same text", async () => {
    h.userFindUnique.mockResolvedValue(registeredUser());
    const wrongPassword = await loginAction(
      {},
      form({ email: "member@example.test", password: "not-it" }),
    );

    h.userFindUnique.mockResolvedValue(null);
    const unknownAddress = await loginAction(
      {},
      form({ email: "ghost@example.test", password: "not-it" }),
    );

    expect(wrongPassword).toEqual(unknownAddress);
    expect(wrongPassword.error).toBe("Incorrect email or password.");
  });

  it("never grants access on the strength of the dummy comparison", async () => {
    h.verifyPassword.mockResolvedValue(true);
    h.userFindUnique.mockResolvedValue(null);

    const result = await loginAction(
      {},
      form({ email: "ghost@example.test", password: "guess" }),
    );

    expect(result).toEqual({ error: "Incorrect email or password." });
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it("refuses a password for an SSO account and still pays the bcrypt cost", async () => {
    h.userFindUnique.mockResolvedValue(
      registeredUser({ passwordHash: "sso:token" }),
    );

    const result = await loginAction(
      {},
      form({ email: "member@example.test", password: GOOD_PASSWORD }),
    );

    expect(result).toEqual({ error: "Incorrect email or password." });
    expect(h.verifyPassword).toHaveBeenCalledTimes(1);
    const [, hash] = h.verifyPassword.mock.calls[0];
    expect(hash).toMatch(BCRYPT_SHAPE);
    expect(bcrypt.getRounds(hash)).toBe(BCRYPT_COST);
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it("refuses an SSO account even when the dummy comparison matches", async () => {
    h.verifyPassword.mockResolvedValue(true);
    h.userFindUnique.mockResolvedValue(
      registeredUser({ passwordHash: "sso:token" }),
    );

    const result = await loginAction(
      {},
      form({ email: "member@example.test", password: GOOD_PASSWORD }),
    );

    expect(result).toEqual({ error: "Incorrect email or password." });
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it("refuses a stored hash that bcrypt cannot parse, and still pays the cost", async () => {
    // 60 characters and shaped like a hash, but `$2x$` is a revision bcrypt
    // does not know — it must not reach the comparison as it is, or the
    // sign-in would answer with an error instead of the neutral text.
    h.userFindUnique.mockResolvedValue(
      registeredUser({ passwordHash: `$2x$12$${"A".repeat(53)}` }),
    );

    const result = await loginAction(
      {},
      form({ email: "member@example.test", password: GOOD_PASSWORD }),
    );

    expect(result).toEqual({ error: "Incorrect email or password." });
    expect(h.verifyPassword).toHaveBeenCalledTimes(1);
    const [, hash] = h.verifyPassword.mock.calls[0];
    expect(hash).toMatch(BCRYPT_SHAPE);
    expect(bcrypt.getRounds(hash)).toBe(BCRYPT_COST);
    expect(h.createSession).not.toHaveBeenCalled();
  });
});

describe("loginAction — the two-factor gate speaks the same language", () => {
  const twoFactorUser = registeredUser({
    twoFactorEnabled: true,
    twoFactorSecret: TOTP_SECRET,
  });

  it("answers a wrong two-factor code with the same text as a wrong password", async () => {
    h.userFindUnique.mockResolvedValue(twoFactorUser);

    const wrongPassword = await loginAction(
      {},
      form({ email: "member@example.test", password: "not-it" }),
    );
    const wrongCode = await loginAction(
      {},
      form({
        email: "member@example.test",
        password: GOOD_PASSWORD,
        code: STALE_CODE,
      }),
    );

    expect(wrongCode.error).toBe(wrongPassword.error);
    expect(wrongCode.error).toBe("Incorrect email or password.");
    // The flag stays, so the code field remains on screen for another try.
    expect(wrongCode.requiresTwoFactor).toBe(true);
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it("asks for a code without naming a failure", async () => {
    h.userFindUnique.mockResolvedValue(twoFactorUser);

    const result = await loginAction(
      {},
      form({ email: "member@example.test", password: GOOD_PASSWORD }),
    );

    expect(result).toEqual({ requiresTwoFactor: true });
  });

  it("still signs a user in with the right code", async () => {
    h.userFindUnique.mockResolvedValue(twoFactorUser);

    await expect(
      loginAction(
        {},
        form({
          email: "member@example.test",
          password: GOOD_PASSWORD,
          code: totp(TOTP_SECRET),
        }),
      ),
    ).rejects.toThrow("REDIRECT:/w/acme");

    expect(h.createSession).toHaveBeenCalledWith("user-1");
  });
});
