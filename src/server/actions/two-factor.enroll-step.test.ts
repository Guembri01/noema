import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P2-T09 — enrolling two-factor must not consume the current TOTP step.
 *
 * The enrolment used to spend its step (`twoFactorCounter = step`), and the
 * sign-in guard accepts only a strictly newer step. A user who enabled 2FA
 * and signed in again inside the same 30 s window with the same code was
 * therefore answered with the neutral "Incorrect email or password." — the
 * code was correct, but the guard mistook it for a replay.
 *
 * Fix: the enrolment writes `step - 1` instead (forward-only, never backwards),
 * so step N is still spendable exactly once at sign-in:
 *
 *  - enroll with step N → the row stores N - 1, enable succeeds;
 *  - immediate sign-in with step N → success, the row now holds N;
 *  - a further sign-in with step N → the replay guard refuses it.
 *
 * Only the database edge, the session helpers and `next/*` are mocked — the
 * sealing, the TOTP comparison and the guard itself run for real.
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
  getSessionId: vi.fn(async () => null),
  createSession: vi.fn(),
  destroySession: vi.fn(),
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
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
import { enableTwoFactorAction } from "./two-factor";

const SEED = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const PASSWORD = "Vivid-Quartz-91!Lantern";
const NOW = 1_700_000_000_000;
const STEP = Math.floor(NOW / 1000 / 30);

const USER = { id: "user-1", email: "ada@example.test", name: "Ada" };

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
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.AUTH_SECRET = "p2t09-enroll-step-test-secret-0123456789";
  // The row is at the pre-enable stage: a secret is stored, 2FA is off.
  user = {
    id: USER.id,
    email: USER.email,
    passwordHash: "$2b$12$DDATzCAs4idfq89J5AQgj.xDjyjiwPleCbBHhzWDH1HywDCLKgoYi",
    twoFactorEnabled: false,
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

describe("enableTwoFactorAction — the enrolment step survives for sign-in", () => {
  it("stores step - 1, not the step itself", async () => {
    const outcome = await enableTwoFactorAction(totp(SEED));

    expect(outcome).toEqual({ ok: true });
    const { where, data } = updateManyArgs();
    expect(where).toEqual({
      id: USER.id,
      OR: [
        { twoFactorCounter: null },
        { twoFactorCounter: { lt: STEP - 1 } },
      ],
    });
    expect(data).toEqual({ twoFactorCounter: STEP - 1 });
    expect(user.twoFactorCounter).toBe(STEP - 1);
  });

  it("lets the same code open the very next session, then refuses the replay", async () => {
    await enableTwoFactorAction(totp(SEED));
    // The account is on 2FA now — the sign-in reads the row as it is.
    user.twoFactorEnabled = true;

    const first = await signIn(totp(SEED));
    const second = await signIn(totp(SEED));

    // The repro of the defect: without the fix this sign-in was refused.
    expect(first.redirected).toBe(true);
    expect(auth.createSession).toHaveBeenCalledTimes(1);
    // The spent step is now N, so the same code no longer opens a session.
    expect(user.twoFactorCounter).toBe(STEP);
    expect(second.state).toEqual({
      error: "Incorrect email or password.",
      requiresTwoFactor: true,
    });
  });

  it("spends the guess budget twice on the replay of the enrolment code, never the lockout", async () => {
    await enableTwoFactorAction(totp(SEED));
    user.twoFactorEnabled = true;
    await signIn(totp(SEED));
    const third = await signIn(totp(SEED));

    // The replay is not a lockout: the answer stays the neutral one and the
    // account file is untouched (the 2FA budget is a separate counter).
    expect(third.state).toEqual({
      error: "Incorrect email or password.",
      requiresTwoFactor: true,
    });
    expect(user.failedLoginCount).toBe(0);
    expect(user.lockedUntil).toBeNull();
  });
});
