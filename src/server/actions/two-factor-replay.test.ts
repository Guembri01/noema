import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B25 — a two-factor code may be spent only once.
 *
 * `verifyTotp` is a pure function and the accepted time step was never
 * persisted, so nothing recorded that a step had been spent: a code that had
 * been observed (a phishing screen, a screenshot, a shoulder surfer) stayed
 * valid for the whole ±1 step window — up to 90 seconds — and every use
 * opened a fresh session.
 *
 * These tests pin the guard:
 *
 *  - the sign-in spends the time step it accepted, and it spends it ATOMICALLY
 *    (the comparison happens inside the UPDATE, so two racing uses of one code
 *    cannot both win);
 *  - the second use of the same code opens no second session;
 *  - a code from a LATER step is still accepted — the guard is a replay guard,
 *    not a lockout;
 *  - a wrong code spends nothing;
 *  - the setup gates (enable / disable) spend the step as well.
 *
 * Only the database edge, the session helpers and `next/*` are mocked — the
 * sealing, the opening, the TOTP comparison and the guard itself run for real.
 */

const db = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  userUpdateMany: vi.fn(),
  userCreate: vi.fn(),
  workspaceFindFirst: vi.fn(),
  workspaceMemberFindFirst: vi.fn(),
  pageCreate: vi.fn(),
}));

const auth = vi.hoisted(() => ({
  requireUser: vi.fn(),
  createSession: vi.fn(),
  destroySession: vi.fn(),
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
  // B39: `disableTwoFactorAction` reads the session of the caller to keep it
  // alive while it ends the other sessions of the account.
  getSessionId: vi.fn(async () => null),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: db.userFindUnique,
      update: db.userUpdate,
      updateMany: db.userUpdateMany,
      create: db.userCreate,
    },
    workspace: { create: vi.fn(), findFirst: db.workspaceFindFirst },
    workspaceMember: { findFirst: db.workspaceMemberFindFirst, create: vi.fn() },
    page: { create: db.pageCreate },
  },
}));
vi.mock("@/lib/auth", () => auth);
vi.mock("@/server/unique", () => ({
  uniqueWorkspaceSlug: vi.fn(async () => "acme"),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

import { encryptTwoFactorSecret } from "@/lib/secrets";
import { resetAuthLimits } from "@/lib/rate-limit";
import { totp } from "@/lib/totp";
import { loginAction, type AuthState } from "./auth";
import {
  disableTwoFactorAction,
  enableTwoFactorAction,
} from "./two-factor";

/** A base32 TOTP seed of the shape `generateTotpSecret()` produces. */
const SEED = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
/** A password the policy accepts (upper, lower, digit, long enough). */
const PASSWORD = "Vivid-Quartz-91!Lantern";
/** The clock every code in this file belongs to (faked, so the steps are fixed). */
const NOW = 1_700_000_000_000;
/** The time step `NOW` belongs to (30 s steps). */
const STEP = Math.floor(NOW / 1000 / 30);

const USER = { id: "user-1", email: "ada@example.test", name: "Ada" };

/** The user row the mocked database holds. */
let user: {
  id: string;
  email: string;
  passwordHash: string;
  twoFactorEnabled: boolean;
  twoFactorSecret: string | null;
  twoFactorCounter: number | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
};

/** The `data` payload of the nth `prisma.user.updateMany` call. */
function updateManyArgs(call = 0): { where: unknown; data: Record<string, unknown> } {
  const calls = db.userUpdateMany.mock.calls;
  expect(calls.length).toBeGreaterThan(call);
  return calls[call][0] as { where: unknown; data: Record<string, unknown> };
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

/**
 * One sign-in: the state it answered with, or the redirect it made.
 *
 * A successful sign-in redirects, so the redirect has to be caught — the
 * second use of an observed code is the case under test.
 */
async function signIn(
  code: string,
): Promise<{ state: AuthState | undefined; redirected: boolean }> {
  try {
    const state = await loginAction(
      {},
      form({ email: USER.email, password: PASSWORD, code }),
    );
    return { state, redirected: false };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("REDIRECT:")) {
      return { state: undefined, redirected: true };
    }
    throw error;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAuthLimits();
  // A fixed clock: the codes and the steps they belong to are then exact.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  // B05 seals the TOTP seed with AUTH_SECRET.
  process.env.AUTH_SECRET = "b25-two-factor-replay-test-secret-0123456789";
  user = {
    id: USER.id,
    email: USER.email,
    // A real bcrypt hash: the sign-in always runs a bcrypt comparison.
    passwordHash: "$2b$12$DDATzCAs4idfq89J5AQgj.xDjyjiwPleCbBHhzWDH1HywDCLKgoYi",
    twoFactorEnabled: true,
    twoFactorSecret: encryptTwoFactorSecret(SEED),
    twoFactorCounter: null,
    failedLoginCount: 0,
    lockedUntil: null,
  };
  db.userFindUnique.mockImplementation(async () => ({ ...user }));
  db.userUpdate.mockImplementation(async () => ({ ...user }));
  db.userUpdateMany.mockImplementation(
    async (args: { data: { twoFactorCounter: number } }) => {
      const step = args.data.twoFactorCounter;
      // The row is written only when the step it holds is lower than the one
      // being spent — the rule the database applies inside the UPDATE.
      if (user.twoFactorCounter !== null && user.twoFactorCounter >= step) {
        return { count: 0 };
      }
      user.twoFactorCounter = step;
      return { count: 1 };
    },
  );
  db.workspaceFindFirst.mockResolvedValue(null);
  db.workspaceMemberFindFirst.mockResolvedValue(null);
  db.pageCreate.mockResolvedValue({ id: "page-1" });
  auth.requireUser.mockResolvedValue(USER);
  auth.createSession.mockResolvedValue(undefined);
  auth.destroySession.mockResolvedValue(undefined);
  auth.hashPassword.mockResolvedValue("hashed");
  auth.verifyPassword.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("loginAction — a two-factor code is spent once", () => {
  it("refuses the second use of the same code", async () => {
    const code = totp(SEED);

    const first = await signIn(code);
    const second = await signIn(code);

    expect(first.redirected).toBe(true);
    // The same neutral text as a wrong password (B24): the reply must not
    // tell a replay apart from a wrong code.
    expect(second.state).toEqual({
      error: "Incorrect email or password.",
      requiresTwoFactor: true,
    });
    // One code, one session.
    expect(auth.createSession).toHaveBeenCalledTimes(1);
  });

  it("spends the step atomically, inside the UPDATE", async () => {
    await signIn(totp(SEED));

    expect(db.userUpdateMany).toHaveBeenCalledTimes(1);
    const { where, data } = updateManyArgs();
    // The comparison happens in the database, not in the application: the row
    // is only written when the step it holds is lower than the one spent.
    expect(where).toEqual({
      id: USER.id,
      OR: [{ twoFactorCounter: null }, { twoFactorCounter: { lt: STEP } }],
    });
    expect(data).toEqual({ twoFactorCounter: STEP });
  });

  it("still accepts a code from a later step", async () => {
    const first = await signIn(totp(SEED));
    const second = await signIn(totp(SEED, NOW + 30_000));

    // The guard is a replay guard, not a lockout: the next step is a new code.
    expect(first.redirected).toBe(true);
    expect(second.redirected).toBe(true);
    expect(auth.createSession).toHaveBeenCalledTimes(2);
    expect(user.twoFactorCounter).toBe(STEP + 1);
  });

  it("spends nothing for a wrong code", async () => {
    const outcome = await signIn("000000");

    expect(outcome.state).toEqual({
      error: "Incorrect email or password.",
      requiresTwoFactor: true,
    });
    expect(db.userUpdateMany).not.toHaveBeenCalled();
    expect(auth.createSession).not.toHaveBeenCalled();
  });
});

describe("enableTwoFactorAction — the enrolment code is spent once", () => {
  it("refuses the second use of the same code", async () => {
    const first = await enableTwoFactorAction(totp(SEED));
    const second = await enableTwoFactorAction(totp(SEED));

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({
      error: "That code is not valid. Check your authenticator app.",
    });
  });
});

describe("disableTwoFactorAction — the disabling code is spent once", () => {
  it("refuses the second use of the same code", async () => {
    const first = await disableTwoFactorAction(totp(SEED));
    const second = await disableTwoFactorAction(totp(SEED));

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ error: "That code is not valid." });
  });
});
