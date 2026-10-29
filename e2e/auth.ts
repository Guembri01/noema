import type { BrowserContext, Page } from "@playwright/test";

/**
 * Shared E2E sign-in with a per-worker session cache.
 *
 * The auth limiter is deliberately strict (10 attempts/minute/account) and the
 * suite signs in as the same seeded demo account in almost every test. Logging
 * in for real each time therefore spends the account's whole budget a few
 * seconds into a run, which looks like a product failure but is only test
 * traffic. Keep the production limiter intact and reuse the first session
 * cookie for later tests in the same worker instead.
 *
 * The cache is process-local and keyed by e-mail. A test still gets a fresh
 * browser context; only the session cookie is carried over. If the server
 * invalidated that session (or a test deliberately revoked it), the cached
 * path bounces to `/login`, and we fall back to one real login.
 */

type Credentials = { email: string; password: string };

type SignInOptions = {
  /** Navigation timeout for the login/cached landing page. */
  timeout?: number;
  /** Passed to `page.goto`; some busy dev servers never fire `load`. */
  waitUntil?: "load" | "domcontentloaded" | "commit";
};

type Cookie = Awaited<ReturnType<BrowserContext["cookies"]>>[number];

const cache = new Map<string, Cookie[]>();
const inFlight = new Map<string, Promise<Cookie[]>>();

async function login(
  page: Page,
  credentials: Credentials,
  options: Required<Pick<SignInOptions, "timeout" | "waitUntil">>,
) {
  await page.goto("/login", {
    timeout: options.timeout,
    waitUntil: options.waitUntil,
  });
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/w\//, { timeout: options.timeout });
  const cookies = await page.context().cookies();
  cache.set(credentials.email, cookies);
  return cookies;
}

export async function signInWithSession(
  page: Page,
  credentials: Credentials,
  options: SignInOptions = {},
) {
  const timeout = options.timeout ?? 60_000;
  const waitUntil = options.waitUntil ?? "domcontentloaded";

  const cached = cache.get(credentials.email);
  if (cached) {
    await page.context().addCookies(cached);
    try {
      await page.goto("/app", { timeout, waitUntil });
      await page.waitForURL(/\/w\//, { timeout });
      return;
    } catch {
      // The session was revoked server-side (or a test logged this account
      // out). Drop the stale cookie and do one real login.
      cache.delete(credentials.email);
      await page.context().clearCookies();
    }
  }

  const pending = inFlight.get(credentials.email);
  if (pending) {
    const cookies = await pending;
    await page.context().addCookies(cookies);
    await page.goto("/app", { timeout, waitUntil });
    await page.waitForURL(/\/w\//, { timeout });
    return;
  }

  // A short retry loop matches the older per-spec helpers: the server may be
  // restarting or saturated while the suite runs.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const attemptLogin = login(page, credentials, { timeout, waitUntil });
    inFlight.set(credentials.email, attemptLogin);
    try {
      await attemptLogin;
      return;
    } catch (error) {
      lastError = error;
      inFlight.delete(credentials.email);
      if (attempt < 2) await page.waitForTimeout(5_000);
    }
  }
  throw lastError;
}
