import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

/**
 * B24 — the sign-up / sign-in paths must not disclose whether an address is
 * registered.
 *
 * Three channels are pinned here:
 *
 *  - the sign-up answer for an address that is already registered is the very
 *    same text as the answer for a sign-up that lost the race against a
 *    concurrent sign-up for the same address, and it names neither the reason
 *    nor an e-mail the app would never send;
 *  - a sign-in for an address that does not exist still runs a bcrypt
 *    comparison — against a real cost-12 dummy hash — so the response time
 *    does not give the account away;
 *  - a wrong two-factor code answers with the same text as a wrong password.
 *
 * Only the database edge, the session edge and the router are mocked; the
 * schemas, the password policy and the TOTP check run for real.
 */

const db = vi.hoisted(() => ({
  userFindUnique: vi.fn<(args: { where: { email: string } }) => Promise<unknown>>(),
  userUpdate: vi.fn<(args: unknown) => Promise<{ failedLoginCount: number }>>(),
  userCreate: vi.fn<
    (args: {
      data: { name: string; email: string; passwordHash: string };
    }) => Promise<unknown>
  >(),
  workspaceCreate: vi.fn<(args: unknown) => Promise<{ id: string; slug: string }>>(),
  workspaceFindFirst: vi.fn<(args: unknown) => Promise<{ slug: string } | null>>(),
  workspaceMemberFindFirst: vi.fn<(args: unknown) => Promise<unknown>>(),
  pageCreate: vi.fn<(args: unknown) => Promise<unknown>>(),
}));

const auth = vi.hoisted(() => ({
  hashPassword: vi.fn<(password: string) => Promise<string>>(),
  verifyPassword: vi.fn<(password: string, hash: string) => Promise<boolean>>(),
  createSession: vi.fn<(userId: string) => Promise<void>>(),
  destroySession: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: db.userFindUnique,
      update: db.userUpdate,
      create: db.userCreate,
    },
    workspace: {
      create: db.workspaceCreate,
      findFirst: db.workspaceFindFirst,
    },
    workspaceMember: { findFirst: db.workspaceMemberFindFirst },
    page: { create: db.pageCreate },
  },
}));
vi.mock("@/lib/auth", () => ({
  hashPassword: auth.hashPassword,
  verifyPassword: auth.verifyPassword,
  createSession: auth.createSession,
  destroySession: auth.destroySession,
}));
vi.mock("@/server/unique", () => ({
  uniqueWorkspaceSlug: vi.fn(async () => "acme"),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

import { resetAuthLimits } from "@/lib/rate-limit";
import { totp } from "@/lib/totp";
import { loginAction, signupAction } from "./auth";

/** A password the policy accepts (upper, lower, digit, long enough). */
const GOOD_PASSWORD = "Vivid-Quartz-91!Lantern";
/** The shape of a bcrypt hash: `$2<variant>$<cost>$<53 chars>`. */
const BCRYPT_SHAPE = /^\$2[aby]\$(?:0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/;
/** The cost `hashPassword` uses — the dummy hash has to match it. */
const BCRYPT_COST = 12;
/** The stored hash of the fixture user (cost 4 keeps the test fast). */
const STORED_HASH = bcrypt.hashSync(GOOD_PASSWORD, 4);
/** A base32 TOTP secret for the two-factor fixtures. */
const TOTP_SECRET = "JBSWY3DPEHPK3PXP";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

/** A registered user, as `prisma.user.findUnique` hands it back. */
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
  db.userUpdate.mockResolvedValue({ failedLoginCount: 0 });
  auth.hashPassword.mockImplementation(async (password: string) =>
    bcrypt.hashSync(password, 4),
  );
  auth.verifyPassword.mockImplementation(
    async (password: string, hash: string) =>
      hash === STORED_HASH && password === GOOD_PASSWORD,
  );
  auth.createSession.mockResolvedValue(undefined);
  auth.destroySession.mockResolvedValue(undefined);
  db.workspaceCreate.mockResolvedValue({ id: "ws-1", slug: "acme" });
  db.workspaceFindFirst.mockResolvedValue({ slug: "acme" });
  db.workspaceMemberFindFirst.mockResolvedValue(null);
  db.pageCreate.mockResolvedValue({ id: "page-1" });
});

describe("signupAction — the answer never names that an address is registered", () => {
  it("answers a registered address exactly like a sign-up that lost the race", async () => {
    db.userFindUnique.mockResolvedValue(registeredUser());
    const registered = await signupAction(
      {},
      form({
        name: "Ada",
        email: "member@example.test",
        password: GOOD_PASSWORD,
      }),
    );

    // The address looked free, but a concurrent sign-up for it won the race.
    db.userFindUnique.mockResolvedValue(null);
    db.userCreate.mockRejectedValue({ code: "P2002" });
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
    db.userFindUnique.mockResolvedValue(registeredUser());

    await signupAction(
      {},
      form({
        name: "Ada",
        email: "member@example.test",
        password: GOOD_PASSWORD,
      }),
    );

    expect(auth.hashPassword).toHaveBeenCalledTimes(1);
    // The hash is computed before the lookup, so a registered address is not
    // answered measurably faster than a free one.
    expect(auth.hashPassword.mock.invocationCallOrder[0]).toBeLessThan(
      db.userFindUnique.mock.invocationCallOrder[0],
    );
    expect(db.userCreate).not.toHaveBeenCalled();
  });

  it("still creates the account, the workspace and the session for a free address", async () => {
    db.userFindUnique.mockResolvedValue(null);
    db.userCreate.mockResolvedValue({ id: "user-2" });

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

    expect(db.userCreate).toHaveBeenCalledTimes(1);
    expect(auth.createSession).toHaveBeenCalledWith("user-2");
  });
});

describe("loginAction — the sign-in cost does not depend on the account", () => {
  it("still runs a bcrypt comparison for an address that does not exist", async () => {
    db.userFindUnique.mockResolvedValue(null);

    const result = await loginAction(
      {},
      form({ email: "ghost@example.test", password: "whatever" }),
    );

    expect(result).toEqual({ error: "Incorrect email or password." });
    expect(auth.verifyPassword).toHaveBeenCalledTimes(1);
    const [, hash] = auth.verifyPassword.mock.calls[0];
    // A real bcrypt hash at the cost `hashPassword` uses, so the comparison
    // costs what a real one costs.
    expect(hash).toMatch(BCRYPT_SHAPE);
    expect(bcrypt.getRounds(hash)).toBe(BCRYPT_COST);
  });

  it("answers a wrong password and an unknown address with the same text", async () => {
    db.userFindUnique.mockResolvedValue(registeredUser());
    const wrongPassword = await loginAction(
      {},
      form({ email: "member@example.test", password: "not-it" }),
    );

    db.userFindUnique.mockResolvedValue(null);
    const unknownAddress = await loginAction(
      {},
      form({ email: "ghost@example.test", password: "not-it" }),
    );

    expect(wrongPassword).toEqual(unknownAddress);
    expect(wrongPassword.error).toBe("Incorrect email or password.");
  });

  it("never grants access on the strength of the dummy comparison", async () => {
    auth.verifyPassword.mockResolvedValue(true);
    db.userFindUnique.mockResolvedValue(null);

    const result = await loginAction(
      {},
      form({ email: "ghost@example.test", password: "guess" }),
    );

    expect(result).toEqual({ error: "Incorrect email or password." });
    expect(auth.createSession).not.toHaveBeenCalled();
  });

  it("refuses a password for an SSO account and still pays the bcrypt cost", async () => {
    db.userFindUnique.mockResolvedValue(
      registeredUser({ passwordHash: "sso:token" }),
    );

    const result = await loginAction(
      {},
      form({ email: "member@example.test", password: GOOD_PASSWORD }),
    );

    expect(result).toEqual({ error: "Incorrect email or password." });
    expect(auth.verifyPassword).toHaveBeenCalledTimes(1);
    const [, hash] = auth.verifyPassword.mock.calls[0];
    expect(hash).toMatch(BCRYPT_SHAPE);
    expect(bcrypt.getRounds(hash)).toBe(BCRYPT_COST);
    expect(auth.createSession).not.toHaveBeenCalled();
  });

  it("refuses an SSO account even when the dummy comparison matches", async () => {
    auth.verifyPassword.mockResolvedValue(true);
    db.userFindUnique.mockResolvedValue(
      registeredUser({ passwordHash: "sso:token" }),
    );

    const result = await loginAction(
      {},
      form({ email: "member@example.test", password: GOOD_PASSWORD }),
    );

    expect(result).toEqual({ error: "Incorrect email or password." });
    expect(auth.createSession).not.toHaveBeenCalled();
  });

  it("refuses a stored hash that bcrypt cannot parse, and still pays the cost", async () => {
    // 60 characters and shaped like a hash, but `$2x$` is a revision bcrypt
    // does not know — it must not reach the comparison as it is, or the
    // sign-in would answer with an error instead of the neutral text.
    db.userFindUnique.mockResolvedValue(
      registeredUser({ passwordHash: `$2x$12$${"A".repeat(53)}` }),
    );

    const result = await loginAction(
      {},
      form({ email: "member@example.test", password: GOOD_PASSWORD }),
    );

    expect(result).toEqual({ error: "Incorrect email or password." });
    expect(auth.verifyPassword).toHaveBeenCalledTimes(1);
    const [, hash] = auth.verifyPassword.mock.calls[0];
    expect(hash).toMatch(BCRYPT_SHAPE);
    expect(bcrypt.getRounds(hash)).toBe(BCRYPT_COST);
    expect(auth.createSession).not.toHaveBeenCalled();
  });
});

describe("loginAction — the two-factor gate speaks the same language", () => {
  const twoFactorUser = registeredUser({
    twoFactorEnabled: true,
    twoFactorSecret: TOTP_SECRET,
  });

  it("answers a wrong two-factor code with the same text as a wrong password", async () => {
    db.userFindUnique.mockResolvedValue(twoFactorUser);

    const wrongPassword = await loginAction(
      {},
      form({ email: "member@example.test", password: "not-it" }),
    );
    const wrongCode = await loginAction(
      {},
      form({
        email: "member@example.test",
        password: GOOD_PASSWORD,
        code: "000000",
      }),
    );

    expect(wrongCode.error).toBe(wrongPassword.error);
    expect(wrongCode.error).toBe("Incorrect email or password.");
    // The flag stays, so the code field remains on screen for another try.
    expect(wrongCode.requiresTwoFactor).toBe(true);
    expect(auth.createSession).not.toHaveBeenCalled();
  });

  it("asks for a code without naming a failure", async () => {
    db.userFindUnique.mockResolvedValue(twoFactorUser);

    const result = await loginAction(
      {},
      form({ email: "member@example.test", password: GOOD_PASSWORD }),
    );

    expect(result).toEqual({ requiresTwoFactor: true });
  });

  it("still signs a user in with the right code", async () => {
    db.userFindUnique.mockResolvedValue(twoFactorUser);

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

    expect(auth.createSession).toHaveBeenCalledWith("user-1");
  });
});
