import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyShareUnlockToken } from "@/lib/secrets";

/**
 * B44 - the share-link unlock endpoint is unauthenticated, so it needs the
 * same treatment as every other non-public route:
 *
 *  - `POST /s/<token>/unlock` is rate limited per share link, like the other
 *    routes use `rateLimit()`;
 *  - failed password attempts are counted per share token, so a caller that
 *    rotates its forwarded ip still runs out of guesses;
 *  - a locked link compares no password at all (fail closed);
 *  - the pre-existing behaviour survives: a wrong password redirects back to
 *    the share page, a correct one sets the unlock cookie.
 *
 * Only the transport edges (db, bcrypt, cookies) are mocked - the limiter
 * and the attempt accounting run for real.
 *
 * (Its own file: the unlock-state suite of B01 mocks the share action
 * instead, and two `vi.mock` blocks for one module cannot live in one file.)
 */

const db = vi.hoisted(() => ({ shareLinkFindUnique: vi.fn() }));
const auth = vi.hoisted(() => ({ verifyPassword: vi.fn() }));
const cookieStore = vi.hoisted(() => ({ set: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { shareLink: { findUnique: db.shareLinkFindUnique } },
}));

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(),
  hashPassword: vi.fn(),
  verifyPassword: auth.verifyPassword,
}));

vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: vi.fn(),
  canPerformWorkspaceAction: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieStore) }));

type RouteModule = typeof import("./route");

const ORIGIN = "http://localhost";
const TOKEN = "tok_share_1";
const PASSWORD = "correct-horse-battery-staple";
/**
 * The rate limit is a fixed window and the lockout is measured in wall-clock
 * time, so the clock is frozen: a test run that happens to straddle a minute
 * (or a lock window) boundary must not flip a result.
 */
const FIXED_NOW = 1_700_000_000_000;

let route: RouteModule;

/** Fresh module per test: the limiter store and the attempt counter are module state. */
async function loadFreshRoute(): Promise<void> {
  vi.resetModules();
  const limiter = await import("@/lib/rate-limit");
  limiter.resetRateLimits();
  route = await import("./route");
}

function post(options: {
  password: string;
  token?: string;
  ip?: string;
}): Promise<Response> {
  const token = options.token ?? TOKEN;
  return route.POST(
    new Request(`${ORIGIN}/s/${token}/unlock`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": options.ip ?? "203.0.113.7",
      },
      body: new URLSearchParams({ password: options.password }).toString(),
    }),
    { params: Promise.resolve({ token }) },
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
  // The unlock cookie is signed (B01); without a secret the route fails
  // closed and hands out no cookie at all.
  process.env.AUTH_SECRET = "test-secret-for-share-unlock-tests";
  db.shareLinkFindUnique.mockResolvedValue({ passwordHash: "hash" });
  auth.verifyPassword.mockImplementation(
    async (password: string) => password === PASSWORD,
  );
  await loadFreshRoute();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AUTH_SECRET;
});

describe("POST /s/<token>/unlock - unlocking a share link", () => {
  it("redirects back to the share page when the password is wrong", async () => {
    const res = await post({ password: "nope" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/s/${TOKEN}?error=1`);
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("sets the unlock cookie and redirects when the password is right", async () => {
    const res = await post({ password: PASSWORD });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/s/${TOKEN}`);
    const [cookieName, cookieValue] = cookieStore.set.mock.calls[0] as [
      string,
      string,
    ];
    expect(cookieName).toBe(`share_${TOKEN}`);
    // The unlock state is a signed value, not the constant "1" (B01): it must
    // verify for this share token and for no other.
    expect(cookieValue).not.toBe("1");
    expect(verifyShareUnlockToken(TOKEN, cookieValue)).toBe(true);
    expect(verifyShareUnlockToken("a-different-token", cookieValue)).toBe(false);
    expect(cookieStore.set.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ httpOnly: true, path: "/" }),
    );
  });

  it("never unlocks a link without a password hash", async () => {
    db.shareLinkFindUnique.mockResolvedValue(null);
    const res = await post({ password: PASSWORD });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/s/${TOKEN}?error=1`);
    expect(cookieStore.set).not.toHaveBeenCalled();
  });
});

describe("POST /s/<token>/unlock - brute force is throttled", () => {
  it("rate limits repeated attempts from one client", async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await post({ password: `guess-${i}`, ip: "198.51.100.9" });
      expect(res.status).toBe(303);
    }
    const limited = await post({ password: "guess-5", ip: "198.51.100.9" });
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toEqual({
      error: "Rate limit exceeded",
    });
    expect(auth.verifyPassword).toHaveBeenCalledTimes(5);
  });

  it("locks a share link after too many failed attempts, even when the ip rotates", async () => {
    for (let i = 0; i < 10; i += 1) {
      const res = await post({ password: `guess-${i}`, ip: `10.0.0.${i}` });
      expect(res.status).toBe(303);
    }
    const locked = await post({ password: "guess-10", ip: "10.0.0.10" });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    // Fail closed: the lock compares no further password.
    expect(auth.verifyPassword).toHaveBeenCalledTimes(10);
  });

  it("keeps the budget of each share link separate", async () => {
    for (let i = 0; i < 10; i += 1) {
      await post({ password: `guess-${i}`, ip: `10.0.1.${i}` });
    }
    const locked = await post({ password: "guess", ip: "10.0.1.20" });
    expect(locked.status).toBe(429);

    const other = await post({
      password: "guess",
      token: "tok_other",
      ip: "10.0.1.21",
    });
    expect(other.status).toBe(303);
    expect(other.headers.get("location")).toBe(
      `${ORIGIN}/s/tok_other?error=1`,
    );
  });

  it("clears the failure count after a successful unlock", async () => {
    const wrong = await post({ password: "nope", ip: "10.0.2.1" });
    expect(wrong.status).toBe(303);

    const right = await post({ password: PASSWORD, ip: "10.0.2.2" });
    expect(right.status).toBe(303);
    expect(right.headers.get("location")).toBe(`${ORIGIN}/s/${TOKEN}`);

    // The budget is whole again: ten further failures lock the link.
    for (let i = 0; i < 10; i += 1) {
      const res = await post({ password: `guess-${i}`, ip: `10.0.3.${i}` });
      expect(res.status).toBe(303);
    }
    const locked = await post({ password: "guess", ip: "10.0.3.20" });
    expect(locked.status).toBe(429);
  });
});
