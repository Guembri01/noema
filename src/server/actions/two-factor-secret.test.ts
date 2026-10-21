import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * B05 — the 2FA seed is sealed at rest.
 *
 * The write path (`startTwoFactorAction`) must store an envelope, never the
 * raw base32 seed, and every read path (enable / disable / the login gate)
 * must open that envelope before a code is checked. A row written before the
 * fix holds a raw seed: it must keep working (no lockout) and be re-sealed on
 * the next successful write. A value that cannot be opened must fail closed.
 *
 * Only the database edge, the session helpers and `next/*` are mocked — the
 * sealing, the opening and the TOTP comparison all run for real.
 */

const db = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  // B25: the setup gates spend the two-factor time step they accepted.
  userUpdateMany: vi.fn(),
  workspaceMemberFindFirst: vi.fn(),
  workspaceFindFirst: vi.fn(),
}));

const auth = vi.hoisted(() => ({
  requireUser: vi.fn(),
  verifyPassword: vi.fn(),
  createSession: vi.fn(),
  destroySession: vi.fn(),
  hashPassword: vi.fn(),
  // B39: disabling 2FA ends the other sessions of the account, so the action
  // asks for the sid of the calling device.
  getSessionId: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: db.userFindUnique, update: db.userUpdate, updateMany: db.userUpdateMany },
    workspaceMember: { findFirst: db.workspaceMemberFindFirst },
    workspace: { findFirst: db.workspaceFindFirst },
  },
}));

vi.mock("@/lib/auth", () => auth);

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

import { hashSync } from "bcryptjs";
import { totp } from "@/lib/totp";
import { encryptTwoFactorSecret, openTwoFactorSecret } from "@/lib/secrets";
import { loginAction } from "./auth";
import {
  disableTwoFactorAction,
  enableTwoFactorAction,
  startTwoFactorAction,
} from "./two-factor";

/** A base32 seed of the shape `generateTotpSecret()` produces. */
const SEED = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
/** A usable bcrypt hash for the fixture (cost 4 keeps the test fast). */
const STORED_HASH = hashSync("hunter2!", 4);

const USER = { id: "user-1", name: "Ada", email: "ada@example.test" };

/** The tmp store the session registry writes to (see the beforeEach below). */
let dir: string;

function loginForm(email: string, password: string, code?: string): FormData {
  const form = new FormData();
  form.set("email", email);
  form.set("password", password);
  if (code !== undefined) form.set("code", code);
  return form;
}

/** The `data` payload of the nth `prisma.user.update` call. */
function updatedData(call = 0): Record<string, unknown> {
  const calls = db.userUpdate.mock.calls;
  expect(calls.length).toBeGreaterThan(call);
  return calls[call][0].data as Record<string, unknown>;
}

/** Silence the legacy-plaintext warning of `openTwoFactorSecret`. */
function silenceLegacyWarning(): () => void {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return () => warn.mockRestore();
}

beforeEach(async () => {
  vi.clearAllMocks();
  // The two-factor code space gets its own budget (B03), and that budget is
  // module state. The reset is written so that it works with and without that
  // change: the helper only exists once the budget does.
  const rateLimit = (await import("@/lib/rate-limit")) as {
    resetAuthLimits?: () => void;
  };
  rateLimit.resetAuthLimits?.();
  process.env.AUTH_SECRET = "b05-two-factor-test-secret-0123456789";
  // B39: disabling 2FA revokes the other sessions of the account, so the
  // action writes to the session registry — point it at a tmp file, never at
  // the app's `.data/sessions.json`.
  dir = mkdtempSync(join(tmpdir(), "b05-two-factor-"));
  process.env.SESSION_STORE_PATH = join(dir, "sessions.json");
  auth.requireUser.mockResolvedValue(USER);
  auth.verifyPassword.mockResolvedValue(true);
  auth.getSessionId.mockResolvedValue(null);
  db.userUpdate.mockResolvedValue({ id: USER.id });
  // B25: the two-factor step a code spends is free in every test.
  db.userUpdateMany.mockResolvedValue({ count: 1 });
  db.workspaceMemberFindFirst.mockResolvedValue(null);
  db.workspaceFindFirst.mockResolvedValue(null);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SESSION_STORE_PATH;
  vi.restoreAllMocks();
});

describe("startTwoFactorAction — the seed is sealed before it is stored", () => {
  it("stores an envelope, never the raw seed", async () => {
    const result = await startTwoFactorAction();
    expect("secret" in result).toBe(true);
    if (!("secret" in result)) return;

    const stored = updatedData().twoFactorSecret as string;
    expect(stored).not.toBe(result.secret);
    expect(stored).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(openTwoFactorSecret(stored)).toEqual({
      kind: "sealed",
      secret: result.secret,
    });
  });

  it("still shows the raw seed to the user who is enrolling", async () => {
    const result = await startTwoFactorAction();
    expect("secret" in result).toBe(true);
    if (!("secret" in result)) return;
    expect(result.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(result.otpauth).toContain(encodeURIComponent(result.secret));
  });
});

describe("enableTwoFactorAction — the code is checked against the opened seed", () => {
  it("enables two-factor for a code that matches the sealed seed", async () => {
    db.userFindUnique.mockResolvedValue({
      twoFactorSecret: encryptTwoFactorSecret(SEED),
    });

    const result = await enableTwoFactorAction(totp(SEED));
    expect(result).toEqual({ ok: true });
  });

  it("stores the sealed seed, never the raw one", async () => {
    db.userFindUnique.mockResolvedValue({
      twoFactorSecret: encryptTwoFactorSecret(SEED),
    });

    await enableTwoFactorAction(totp(SEED));

    const stored = updatedData().twoFactorSecret as string;
    expect(stored).not.toBe(SEED);
    expect(openTwoFactorSecret(stored)).toEqual({
      kind: "sealed",
      secret: SEED,
    });
    expect(updatedData().twoFactorEnabled).toBe(true);
  });

  it("accepts a pre-B05 cleartext row and re-seals it", async () => {
    db.userFindUnique.mockResolvedValue({ twoFactorSecret: SEED });
    const restore = silenceLegacyWarning();

    const result = await enableTwoFactorAction(totp(SEED));
    restore();

    expect(result).toEqual({ ok: true });
    const stored = updatedData().twoFactorSecret as string;
    expect(stored).not.toBe(SEED);
    expect(openTwoFactorSecret(stored)).toEqual({
      kind: "sealed",
      secret: SEED,
    });
  });

  it("fails closed when the stored envelope cannot be opened", async () => {
    db.userFindUnique.mockResolvedValue({
      twoFactorSecret: "v1:aaaa:bbbb:cccc",
    });

    const result = await enableTwoFactorAction("123456");
    expect(result).toEqual({
      error: "The two-factor secret could not be read. Start the setup again.",
    });
    expect(db.userUpdate).not.toHaveBeenCalled();
  });

  it("rejects a wrong code for a sealed seed", async () => {
    db.userFindUnique.mockResolvedValue({
      twoFactorSecret: encryptTwoFactorSecret(SEED),
    });

    const result = await enableTwoFactorAction("000000");
    expect("error" in result).toBe(true);
    expect(db.userUpdate).not.toHaveBeenCalled();
  });
});

describe("disableTwoFactorAction — the code is checked against the opened seed", () => {
  it("disables two-factor and clears the stored seed", async () => {
    db.userFindUnique.mockResolvedValue({
      twoFactorEnabled: true,
      twoFactorSecret: encryptTwoFactorSecret(SEED),
    });

    const result = await disableTwoFactorAction(totp(SEED));
    expect(result).toEqual({ ok: true });
    expect(db.userUpdate).toHaveBeenCalledWith({
      where: { id: USER.id },
      data: { twoFactorEnabled: false, twoFactorSecret: null },
    });
  });
});

describe("loginAction — the 2FA gate opens the sealed seed", () => {
  const user = (twoFactorSecret: string | null) => ({
    id: USER.id,
    email: USER.email,
    // A real bcrypt hash: the sign-in always runs a bcrypt comparison, and a
    // stored value that is not a bcrypt hash is refused before the code is
    // even looked at.
    passwordHash: STORED_HASH,
    twoFactorEnabled: true,
    twoFactorSecret,
  });

  it("accepts the code for a sealed seed and issues the session", async () => {
    db.userFindUnique.mockResolvedValue(
      user(encryptTwoFactorSecret(SEED)),
    );

    await expect(
      loginAction({}, loginForm(USER.email, "hunter2!", totp(SEED))),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(auth.createSession).toHaveBeenCalledWith(USER.id);
  });

  it("re-seals a pre-B05 cleartext seed after the code matched", async () => {
    db.userFindUnique.mockResolvedValue(user(SEED));
    const restore = silenceLegacyWarning();

    await expect(
      loginAction({}, loginForm(USER.email, "hunter2!", totp(SEED))),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    restore();

    expect(db.userUpdate).toHaveBeenCalledWith({
      where: { id: USER.id },
      data: { twoFactorSecret: expect.stringMatching(/^v1:/) },
    });
  });

  it("fails closed when the stored envelope cannot be opened", async () => {
    db.userFindUnique.mockResolvedValue(user("v1:aaaa:bbbb:cccc"));

    const state = await loginAction(
      {},
      loginForm(USER.email, "hunter2!", "123456"),
    );
    // One text for every failed sign-in (B24): the reply must not tell a
    // wrong code apart from an unreadable seed.
    expect(state).toEqual({
      error: "Incorrect email or password.",
      requiresTwoFactor: true,
    });
    expect(auth.createSession).not.toHaveBeenCalled();
  });

  it("rejects a wrong code for a sealed seed", async () => {
    db.userFindUnique.mockResolvedValue(
      user(encryptTwoFactorSecret(SEED)),
    );

    const state = await loginAction(
      {},
      loginForm(USER.email, "hunter2!", "000000"),
    );
    expect(state).toEqual({
      error: "Incorrect email or password.",
      requiresTwoFactor: true,
    });
    expect(auth.createSession).not.toHaveBeenCalled();
  });
});

/**
 * The envelope key comes from `AUTH_SECRET`. Without it nothing can be sealed
 * and nothing can be opened — the whole 2FA flow has to fail closed: no
 * setup, no enrolment, no session.
 */
describe("without AUTH_SECRET — the 2FA flow fails closed", () => {
  const user = (twoFactorSecret: string | null) => ({
    id: USER.id,
    email: USER.email,
    // A real bcrypt hash: the sign-in always runs a bcrypt comparison, and a
    // stored value that is not a bcrypt hash is refused before the code is
    // even looked at.
    passwordHash: STORED_HASH,
    twoFactorEnabled: true,
    twoFactorSecret,
  });

  /** The sealed seed, produced while AUTH_SECRET was still set. */
  let sealed: string;

  beforeEach(() => {
    sealed = encryptTwoFactorSecret(SEED);
    delete process.env.AUTH_SECRET;
    // The sealing failure is logged by the actions — keep the test output clean.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("does not start a setup (nothing is written, no seed is handed out)", async () => {
    const result = await startTwoFactorAction();
    expect(result).toEqual({ error: "Two-factor setup is unavailable right now." });
    expect(db.userUpdate).not.toHaveBeenCalled();
  });

  it("does not enable two-factor", async () => {
    db.userFindUnique.mockResolvedValue({ twoFactorSecret: sealed });

    const result = await enableTwoFactorAction(totp(SEED));
    expect(result).toEqual({
      error: "The two-factor secret could not be read. Start the setup again.",
    });
    expect(db.userUpdate).not.toHaveBeenCalled();
  });

  it("does not issue a session for a sealed seed", async () => {
    db.userFindUnique.mockResolvedValue(user(sealed));

    const state = await loginAction(
      {},
      loginForm(USER.email, "hunter2!", totp(SEED)),
    );
    expect(state).toEqual({
      error: "Incorrect email or password.",
      requiresTwoFactor: true,
    });
    expect(auth.createSession).not.toHaveBeenCalled();
  });

  it("does not issue a session for a cleartext seed it cannot re-seal", async () => {
    db.userFindUnique.mockResolvedValue(user(SEED));
    const restore = silenceLegacyWarning();

    const state = await loginAction(
      {},
      loginForm(USER.email, "hunter2!", totp(SEED)),
    );
    restore();

    // The seed could not be sealed (no AUTH_SECRET) — the sign-in does not go
    // through, and the reply is the same neutral one as a wrong code (B24).
    expect(state).toEqual({
      error: "Incorrect email or password.",
      requiresTwoFactor: true,
    });
    expect(auth.createSession).not.toHaveBeenCalled();
    expect(db.userUpdate).not.toHaveBeenCalled();
  });
});
