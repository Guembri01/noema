import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B39 — disabling 2FA ends the other sessions of the account.
 *
 * A session that was opened while 2FA was on must not survive the moment the
 * user turns 2FA off — otherwise the second factor protects nothing for the
 * sessions that were opened with it. Only the device that disables 2FA keeps
 * its own session.
 *
 * Only the database edge and the auth edge are mocked; the session registry
 * is real and lives in a per-test tmp file, so the revocation is the one the
 * request path reads.
 */

const db = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  // B25: the replay guard spends the time step of the code with a
  // conditional update — the mock has to offer it.
  userUpdateMany: vi.fn(async () => ({ count: 1 })),
}));

const auth = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getSessionId: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: db.userFindUnique,
      update: db.userUpdate,
      updateMany: db.userUpdateMany,
    },
  },
}));

vi.mock("@/lib/auth", () => auth);

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

import { totp } from "@/lib/totp";
import { encryptTwoFactorSecret } from "@/lib/secrets";
import { isSessionRevoked, listActiveSessions, registerSession } from "@/lib/session-store";
import { disableTwoFactorAction } from "./two-factor";

/** A base32 seed of the shape `generateTotpSecret()` produces. */
const SEED = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const USER = { id: "user-1", name: "Ada", email: "ada@example.test" };

let dir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  // The two-factor code space gets its own budget (B03), and that budget is
  // module state — reset it so the cases do not inherit each other's tries.
  const rateLimit = (await import("@/lib/rate-limit")) as {
    resetAuthLimits?: () => void;
  };
  rateLimit.resetAuthLimits?.();
  process.env.AUTH_SECRET = "b39-two-factor-test-secret-0123456789";
  dir = mkdtempSync(join(tmpdir(), "b39-2fa-sessions-"));
  process.env.SESSION_STORE_PATH = join(dir, "sessions.json");
  auth.requireUser.mockResolvedValue(USER);
  auth.getSessionId.mockResolvedValue(null);
  db.userUpdate.mockResolvedValue({ id: USER.id });
  db.userFindUnique.mockResolvedValue({
    twoFactorEnabled: true,
    twoFactorSecret: encryptTwoFactorSecret(SEED),
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SESSION_STORE_PATH;
  vi.restoreAllMocks();
});

describe("disableTwoFactorAction — the other sessions of the account die", () => {
  it("ends every session but the one that disabled 2FA", async () => {
    const current = registerSession({ userId: USER.id, device: "current" });
    const phone = registerSession({ userId: USER.id, device: "phone" });
    const stranger = registerSession({ userId: "user-2", device: "stranger" });
    auth.getSessionId.mockResolvedValue(current.sid);

    const result = await disableTwoFactorAction(totp(SEED));

    expect(result).toEqual({ ok: true });
    expect(listActiveSessions(USER.id).map((r) => r.sid)).toEqual([current.sid]);
    expect(isSessionRevoked(phone.sid)).toBe(true);
    // Another user's session is none of this action's business.
    expect(isSessionRevoked(stranger.sid)).toBe(false);
    expect(listActiveSessions("user-2")).toHaveLength(1);
  });

  it("ends every session when the caller has no registry session of its own", async () => {
    registerSession({ userId: USER.id, device: "phone" });
    auth.getSessionId.mockResolvedValue(null);

    const result = await disableTwoFactorAction(totp(SEED));

    expect(result).toEqual({ ok: true });
    expect(listActiveSessions(USER.id)).toHaveLength(0);
  });

  it("leaves the sessions alone when the code is wrong", async () => {
    const phone = registerSession({ userId: USER.id, device: "phone" });

    const result = await disableTwoFactorAction("000000");

    expect(result).toEqual({ error: "That code is not valid." });
    expect(isSessionRevoked(phone.sid)).toBe(false);
    expect(listActiveSessions(USER.id)).toHaveLength(1);
    expect(db.userUpdate).not.toHaveBeenCalled();
  });
});
