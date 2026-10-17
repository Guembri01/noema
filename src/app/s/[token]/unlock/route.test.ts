import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B44 - the share-link unlock endpoint is unauthenticated, so it needs the
 * same treatment as every other non-public route:
 *
 *  - `POST /s/<token]/unlock` is rate limited with a scope that names the
 *    share link, like the other routes use `rateLimit()`;
 *  - failed password attempts are counted per share token, so a caller that
 *    rotates its forwarded ip still runs out of guesses;
 *  - a locked link compares no password at all (fail closed);
 *  - the pre-existing behaviour survives: a wrong password redirects back to
 *    the share page, a correct one sets the unlock cookie.
 *
 * Only the transport edges (db, bcrypt, cookies) are mocked - the limiter
 * and the attempt accounting run for real.
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

/**
 * Move the frozen clock forward. The lock window and the quiet window are
 * published numbers (15 minutes, one hour), so they need a test that pins
 * them: without it, shortening `UNLOCK_LOCK_MS` to a minute would leave the
 * suite green.
 */
function at(ms: number): void {
  vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW + ms);
}

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
  db.shareLinkFindUnique.mockResolvedValue({ passwordHash: "hash" });
  auth.verifyPassword.mockImplementation(
    async (password: string) => password === PASSWORD,
  );
  await loadFreshRoute();
});

afterEach(() => {
  vi.restoreAllMocks();
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
    expect(cookieStore.set).toHaveBeenCalledWith(
      `share_${TOKEN}`,
      "1",
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

  it("holds the lock for 15 minutes and then lets a new attempt through", async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await post({ password: `guess-${i}`, ip: `10.0.4.${i}` })).status).toBe(303);
    }
    const locked = await post({ password: "guess", ip: "10.0.4.20" });
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("900");

    // One second before the window is over, the link is still locked — and
    // still no password is compared.
    at(15 * 60_000 - 1_000);
    const stillLocked = await post({ password: "guess", ip: "10.0.4.21" });
    expect(stillLocked.status).toBe(429);
    expect(auth.verifyPassword).toHaveBeenCalledTimes(10);

    // At the end of the window the link is open again.
    at(15 * 60_000);
    expect((await post({ password: "guess", ip: "10.0.4.22" })).status).toBe(303);
  });

  it("keeps counting failures that are less than an hour apart", async () => {
    for (let i = 0; i < 9; i += 1) {
      await post({ password: `guess-${i}`, ip: `10.0.5.${i}` });
    }
    // A minute before the hour is up, the budget is still not restored: the
    // tenth failure still locks the link. (Pinning the window from below as
    // well keeps a shorter quiet window from passing unnoticed.)
    at(59 * 60_000);
    expect((await post({ password: "guess", ip: "10.0.5.20" })).status).toBe(303);
    expect((await post({ password: "guess", ip: "10.0.5.21" })).status).toBe(429);
  });

  it("restores the budget after an hour of silence", async () => {
    for (let i = 0; i < 9; i += 1) {
      await post({ password: `guess-${i}`, ip: `10.0.6.${i}` });
    }
    // After an hour of silence the nine failures are forgotten: nine more
    // failures lock the link, the tenth does not.
    at(61 * 60_000);
    for (let i = 0; i < 9; i += 1) {
      await post({ password: `guess-${i}`, ip: `10.0.7.${i}` });
    }
    expect((await post({ password: "guess", ip: "10.0.7.20" })).status).toBe(303);
    const locked = await post({ password: "guess", ip: "10.0.7.21" });
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("900");
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
