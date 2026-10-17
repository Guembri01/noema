import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B01 — the share-link unlock route must hand out a *verifiable* unlock state.
 *
 * The vulnerability: the unlock state used to be a cookie whose value was the
 * constant `"1"`, and the page only checked that the cookie was present. Any
 * client could therefore send `Cookie: share_<token>=1` and read a
 * password-protected page.
 *
 * This suite pins the write side of the contract:
 *  - a wrong password sets no cookie at all and redirects back with ?error=1;
 *  - a correct password sets a cookie whose value verifies for this share
 *    token (and only for this token) through `verifyShareUnlockToken`;
 *  - the old constant value is never handed out.
 *
 * Only the two edges are mocked — the password check and the cookie store.
 * The signing and verification run for real.
 */

const share = vi.hoisted(() => ({ verifySharePassword: vi.fn() }));
vi.mock("@/server/actions/share", () => ({ verifySharePassword: share.verifySharePassword }));

const cookieStore = vi.hoisted(() => ({ set: vi.fn(), get: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieStore) }));

import { createShareUnlockToken, shareUnlockCookieName, verifyShareUnlockToken } from "@/lib/secrets";
import { POST as unlock } from "./route";

const TOKEN = "share-token-abc";
const ORIGINAL_SECRET = process.env.AUTH_SECRET;

beforeEach(() => {
  process.env.AUTH_SECRET = "test-secret-for-share-unlock-tests";
  share.verifySharePassword.mockReset();
  cookieStore.set.mockReset();
  cookieStore.get.mockReset();
});

const call = (password: string) =>
  unlock(
    new Request(`http://localhost/s/${TOKEN}/unlock`, {
      method: "POST",
      body: new URLSearchParams({ password }),
    }),
    { params: Promise.resolve({ token: TOKEN }) },
  );

describe("the share unlock route (B01)", () => {
  it("sets no cookie when the password is wrong", async () => {
    share.verifySharePassword.mockResolvedValue(false);

    const response = await call("wrong-password");

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `http://localhost/s/${TOKEN}?error=1`,
    );
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("sets a cookie that verifies for this share token", async () => {
    share.verifySharePassword.mockResolvedValue(true);

    const response = await call("right-password");

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`http://localhost/s/${TOKEN}`);
    expect(cookieStore.set).toHaveBeenCalledTimes(1);

    const [name, value] = cookieStore.set.mock.calls[0] as [string, string];
    expect(name).toBe(shareUnlockCookieName(TOKEN));
    expect(value).not.toBe("1");
    expect(verifyShareUnlockToken(TOKEN, value)).toBe(true);
  });

  it("never hands out a value that unlocks a different share token", async () => {
    share.verifySharePassword.mockResolvedValue(true);

    await call("right-password");

    const [, value] = cookieStore.set.mock.calls[0] as [string, string];
    expect(verifyShareUnlockToken("a-different-token", value)).toBe(false);
  });

  it("never hands out the old constant value", async () => {
    share.verifySharePassword.mockResolvedValue(true);

    await call("right-password");

    const [, value] = cookieStore.set.mock.calls[0] as [string, string];
    expect(value).not.toBe("1");
    // The forged value the vulnerability relied on must not unlock anything.
    expect(verifyShareUnlockToken(TOKEN, "1")).toBe(false);
  });

  it("marks the cookie http-only, same-site and secure in production", async () => {
    share.verifySharePassword.mockResolvedValue(true);
    vi.stubEnv("NODE_ENV", "production");

    try {
      await call("right-password");
    } finally {
      vi.unstubAllEnvs();
    }

    const options = cookieStore.set.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.secure).toBe(true);
    expect(options.path).toBe("/");
  });

  it("fails closed when the server secret is missing", async () => {
    share.verifySharePassword.mockResolvedValue(true);
    delete process.env.AUTH_SECRET;

    // No usable secret means no cookie can be minted or verified, so the
    // unlock fails closed the same way a wrong password does — no server
    // error on a public route, and nothing handed out that nobody could check.
    const response = await call("right-password");

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `http://localhost/s/${TOKEN}?error=1`,
    );
    expect(cookieStore.set).not.toHaveBeenCalled();

    process.env.AUTH_SECRET = ORIGINAL_SECRET ?? "";
  });

  it("round-trips a value minted by the helper", async () => {
    const value = createShareUnlockToken(TOKEN);
    expect(verifyShareUnlockToken(TOKEN, value)).toBe(true);
  });
});
