import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { createHmac } from "node:crypto";
import { envMode, loadEnvFiles } from "../src/lib/env-files";
import { decryptSecret } from "../src/lib/secrets";

/**
 * B95 — 2FA enrollment & hardened login flows (OWN file; no shared spec edits).
 *
 * Coverage:
 *  (0) the in-test TOTP implementation against the RFC 6238 fixed-secret vector,
 *  (1) enroll 2FA through the real settings flow (secret rendered by the
 *      TwoFactorManager, verified with a computed TOTP code),
 *  (2) logout → login with a fresh TOTP succeeds, a WRONG code is rejected at
 *      the gate, and the session lands back in the workspace.
 *
 * Fixture discipline: a DEDICATED prisma-created
 * user + workspace (`b95-2fa-user@example.test`), never `demo@noema.local` —
 * the demo account's 2FA columns are snapshotted in beforeAll and asserted
 * untouched at the end of the enrollment test. Cleanup is try/finally in
 * afterAll: the TOTP secret rows (`User.twoFactorSecret` / `twoFactorEnabled`
 * — this schema keeps the secret on the user row, there is no separate 2FA
 * table) are nulled first, then the user is deleted (cascades workspace +
 * membership), and `prisma.$disconnect()` runs in the finally block.
 *
 * TOTP lives IN THIS FILE (base32 + HOTP + TOTP, `node:crypto` only): the
 * suite never imports `@/lib/totp` (Playwright has no `@/` alias) and proves
 * the local implementation on the RFC 6238 secret
 * "12345678901234567890" = GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ, t=59s → 94287082.
 *
 * AUTH COMPONENTS ARE READ-ONLY here (B54 owns auth live —
 * `src/lib/auth.ts` is ` M` in git status). Reported gaps, not patched here:
 *  - BACKUP CODES DO NOT EXIST anywhere in the product (grep "backup" over
 *    src/: zero hits; no schema column, no server action, no UI in
 *    two-factor-manager.tsx, no i18n keys). The "backup codes shown once"
 *    half cannot be e2e-tested without shipping the feature —
 *    owned by B54/auth, reported instead of edited (no skipped test added:
 *    skipped/xfailed tests are not allowed).
 */

const USER = {
  email: "b95-2fa-user@example.test",
  password: "B95-2fa-passw0rd!",
  name: "B95 Two-Factor",
};
const WORKSPACE = { slug: "b95-2fa-ws", name: "B95 2FA Workspace" };
const DEMO_EMAIL = "demo@noema.local";
const SETTINGS_URL = `/w/${WORKSPACE.slug}/settings`;
const UI_TIMEOUT = 30_000;

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// TOTP (RFC 4648 base32 + RFC 6238), implemented here on purpose.
// ---------------------------------------------------------------------------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = B32.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number, digits = 6): string {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac("sha1", secret).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return (code % 10 ** digits).toString().padStart(digits, "0");
}

function totp(
  secretBase32: string,
  timeMs: number = Date.now(),
  stepSeconds = 30,
  digits = 6,
): string {
  const counter = Math.floor(timeMs / 1000 / stepSeconds);
  return hotp(base32Decode(secretBase32), counter, digits);
}

/** RFC 6238 test secret (ASCII "12345678901234567890"), pre-encoded. */
const RFC_SECRET_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

/**
 * Load the repo env files when the environment does not already provide them,
 * so `AUTH_SECRET` — the key the server derived the envelope with — is the
 * same value here.
 *
 * The files are loaded the way Next.js resolves them: `.env.<NODE_ENV>.local`
 * > `.env.local` > `.env.<NODE_ENV>` > `.env`, and the FIRST file that sets a
 * variable wins. `src/lib/env-files.ts` owns that order — the files are
 * loaded in DESCENDING priority, because a loader that never overrides an
 * already-set variable lets the first file it loads win. (The other way round
 * `.env`, the lowest-priority file, would win, and the fixture would seal
 * with a different key than the server.)
 *
 * The server this suite talks to runs in production mode
 * (`npm run build && npm start`), so the production files are the ones that
 * matter: the shared helper picks them unless `NODE_ENV` says `development`
 * (Playwright sets `NODE_ENV=test`, and the server it talks to is still the
 * production one).
 * A missing file is not an error (the environment may inject it).
 */
function ensureEnv(): void {
  loadEnvFiles(process.cwd(), envMode(), (reason) => {
    console.error(`env file: ${reason}`);
  });
}
ensureEnv();

/**
 * Open the stored TOTP seed (B05).
 *
 * The column holds an AES-256-GCM envelope (`v1:<iv>:<tag>:<payload>`), not the
 * raw base32 seed — a database dump must not yield a usable 2FA seed. A row
 * written before the fix holds the raw seed; it is returned as-is so the
 * fixture can still be used during the transition window.
 *
 * Returns `null` when the envelope cannot be opened (wrong or missing
 * `AUTH_SECRET`, tampered ciphertext) — the caller must fail loudly rather
 * than compute a code from garbage.
 */
function openTotpSecret(stored: string | null): string | null {
  if (!stored) return null;
  if (!stored.startsWith("v1:")) return stored; // legacy plaintext row
  return decryptSecret(stored);
}

/**
 * A code that is guaranteed OUTSIDE the server's ±1 step verify window
 * (verifyTotp uses window = 1), so rejection is deterministic — never a
 * "maybe the window rolled" flake.
 */
function staleTotp(secretBase32: string): string {
  const now = Date.now();
  const inside = new Set(
    [-1, 0, 1].map((offset) => totp(secretBase32, now + offset * 30_000)),
  );
  for (const steps of [10, 12, 14, 16, 20]) {
    const code = totp(secretBase32, now + steps * 30_000);
    if (!inside.has(code)) return code;
  }
  throw new Error("could not derive a code outside the ±1 step window");
}

// ---------------------------------------------------------------------------
// Fixture: dedicated user + workspace, TOTP secret rows cleaned in afterAll.
// ---------------------------------------------------------------------------

async function dedicatedUser() {
  return prisma.user.findUnique({
    where: { email: USER.email },
    select: { id: true, twoFactorEnabled: true, twoFactorSecret: true },
  });
}

async function twoFactorEnabled(): Promise<boolean> {
  const row = await dedicatedUser();
  return row?.twoFactorEnabled ?? false;
}

async function demoTwoFactorSnapshot() {
  const row = await prisma.user.findUnique({
    where: { email: DEMO_EMAIL },
    select: { twoFactorEnabled: true, twoFactorSecret: true },
  });
  return row
    ? { twoFactorEnabled: row.twoFactorEnabled, twoFactorSecret: row.twoFactorSecret }
    : null;
}

let demoBefore: Awaited<ReturnType<typeof demoTwoFactorSnapshot>> = null;

test.beforeAll(async () => {
  // Idempotent: a crashed previous run must not leave the fixture behind.
  await prisma.workspace.deleteMany({ where: { slug: WORKSPACE.slug } });
  await prisma.user.deleteMany({ where: { email: USER.email } });
  const user = await prisma.user.create({
    data: {
      email: USER.email,
      name: USER.name,
      passwordHash: await bcrypt.hash(USER.password, 12),
      twoFactorEnabled: false,
      twoFactorSecret: null,
    },
  });
  await prisma.workspace.create({
    data: {
      name: WORKSPACE.name,
      slug: WORKSPACE.slug,
      ownerId: user.id,
      members: { create: { userId: user.id, role: "OWNER" } },
    },
  });
  demoBefore = await demoTwoFactorSnapshot();
});

test.afterAll(async () => {
  try {
    // Wipe the TOTP secret rows on OUR dedicated user only, then drop it
    // (owner cascade removes the workspace + membership row).
    await prisma.user.updateMany({
      where: { email: USER.email },
      data: { twoFactorSecret: null, twoFactorEnabled: false },
    });
  } finally {
    await prisma.workspace
      .deleteMany({ where: { slug: WORKSPACE.slug } })
      .catch(() => {});
    await prisma.user.deleteMany({ where: { email: USER.email } }).catch(() => {});
    await prisma.$disconnect();
  }
});

test.beforeEach(() => {
  // Settings on dev under concurrent load is a heavy RSC payload.
  test.setTimeout(120_000);
});

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

/** Deterministic hydration signal (React attached its handlers). */
async function waitForTwoFactorHydration(page: Page) {
  await page.waitForFunction(
    () => {
      const heading = [...document.querySelectorAll("h2")].find((el) =>
        (el.textContent ?? "").includes("Two-factor authentication"),
      );
      const section = heading?.closest("section");
      const button = section?.querySelector("button");
      return Boolean(
        button && Object.keys(button).some((key) => key.startsWith("__reactFiber$")),
      );
    },
    undefined,
    { timeout: UI_TIMEOUT },
  );
}

function twoFactorSection(page: Page) {
  return page
    .locator("section")
    .filter({
      has: page.getByRole("heading", {
        name: "Two-factor authentication",
        level: 2,
      }),
    });
}

async function gotoSettings(page: Page) {
  await page.goto(SETTINGS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await expect(
    twoFactorSection(page).getByRole("heading", {
      name: "Two-factor authentication",
      level: 2,
    }),
  ).toBeVisible({ timeout: UI_TIMEOUT });
}

async function signInPlain(page: Page) {
  await page.goto("/login", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByLabel("Email").fill(USER.email);
  await page.getByLabel("Password").fill(USER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/w\//, { timeout: UI_TIMEOUT });
}

/**
 * Click through the real enrollment UI (Enable two-factor → read rendered
 * secret + otpauth URI → Verify & enable), asserting the persisted outcome.
 * Returns the generated base32 secret.
 */
async function enrollThroughSettings(page: Page): Promise<string> {
  await gotoSettings(page);
  const tf = twoFactorSection(page);
  const enableButton = tf.getByRole("button", { name: "Enable two-factor" });
  await expect(enableButton).toBeVisible({ timeout: UI_TIMEOUT });
  await waitForTwoFactorHydration(page);
  await enableButton.click();

  const secretElement = tf.locator("code");
  await expect(secretElement).toBeVisible({ timeout: UI_TIMEOUT });
  // Narrow to the leaf <p>: a section-scoped text match could also hit the
  // container (strict-mode violation), so filter by tag first.
  await expect(
    tf.locator("p").filter({ hasText: "otpauth://totp/" }),
  ).toBeVisible();
  const secret = (await secretElement.innerText()).trim();
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);

  await tf.getByLabel("Authentication code").fill(totp(secret));
  await tf.getByRole("button", { name: "Verify & enable" }).click();

  await expect(page.getByText("Two-factor enabled").first()).toBeVisible({
    timeout: UI_TIMEOUT,
  });
  await expect(tf.getByRole("button", { name: "Disable" })).toBeVisible({
    timeout: UI_TIMEOUT,
  });
  await expect
    .poll(twoFactorEnabled, { timeout: UI_TIMEOUT })
    .toBe(true);
  return secret;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("B95 — 2FA enrollment & hardened login", () => {
  test("in-test TOTP matches the RFC 6238 fixed-secret vector", async () => {
    test.setTimeout(120_000);
    // Fixed secret + fixed time: proves the algorithm in THIS file is correct
    // before any UI assertion leans on it (red-first anchor for the helper).
    expect(totp(RFC_SECRET_B32, 59_000, 30, 8)).toBe("94287082");
    expect(totp(RFC_SECRET_B32, 1_111_111_109_000, 30, 8)).toBe("07081804");
    expect(totp(RFC_SECRET_B32, 1_234_567_890_000, 30, 8)).toBe("89005924");
    // Six digits by default, deterministic per 30 s step.
    expect(totp(RFC_SECRET_B32, 59_000)).toHaveLength(6);
    expect(totp(RFC_SECRET_B32, 59_000)).toBe(totp(RFC_SECRET_B32, 59_000));
  });

  test("enrolls two-factor authentication through the settings flow", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await signInPlain(page);
    const secret = await enrollThroughSettings(page);

    // Enabled panel replaces the enable button; the secret the user must add
    // to their authenticator was rendered exactly once by the setup panel.
    const tf = twoFactorSection(page);
    await expect(
      tf.locator("p").filter({ hasText: "Two-factor authentication is" }),
    ).toBeVisible({ timeout: UI_TIMEOUT });
    await expect(tf.getByRole("button", { name: "Enable two-factor" })).toHaveCount(0);

    // The DB record the login gate will consult: secret + enabled flag.
    // B05: the stored seed is an envelope, not the raw base32 seed.
    const row = await dedicatedUser();
    expect(row?.twoFactorEnabled).toBe(true);
    expect(row?.twoFactorSecret).not.toBe(secret);
    expect(row?.twoFactorSecret).toMatch(/^v1:/);
    expect(openTotpSecret(row?.twoFactorSecret ?? null)).toBe(secret);

    // Red-first probe: B95_RED_PROBE=1 inverts the persisted-state assertion —
    // it MUST fail here, proving this test really observes the enable action.
    if (process.env.B95_RED_PROBE === "1") {
      expect(await twoFactorEnabled()).toBe(false);
    }

    // Never-touch-demo guard: the demo account's 2FA state is byte-identical
    // to the beforeAll snapshot after our enrollment.
    expect(await demoTwoFactorSnapshot()).toEqual(demoBefore);
  });

  test("logs out, rejects a wrong code, then signs in with a fresh TOTP", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    // Fresh context per test ⇒ logged out on entry. Get a session: with TOTP
    // if the fixture is already enrolled (test 2 ran first / standalone
    // -g runs), plain otherwise (then enroll through the UI right here).
    const boot = await dedicatedUser();
    if (boot?.twoFactorEnabled && boot.twoFactorSecret) {
      await page.goto("/login", { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByLabel("Email").fill(USER.email);
      await page.getByLabel("Password").fill(USER.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      const gateInput = page.getByLabel("Two-factor code");
      await expect(gateInput).toBeVisible({ timeout: UI_TIMEOUT });
      // B05: the column holds the sealed envelope — open it before computing
      // a code, otherwise the TOTP would be derived from the ciphertext.
      const bootSecret = openTotpSecret(boot.twoFactorSecret);
      if (!bootSecret) {
        throw new Error(
          "fixture: the stored 2FA seed could not be opened (missing AUTH_SECRET?)",
        );
      }
      await gateInput.fill(totp(bootSecret));
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/w\//, { timeout: UI_TIMEOUT });
    } else {
      await signInPlain(page);
      await enrollThroughSettings(page);
    }

    const enrolled = await dedicatedUser();
    expect(enrolled?.twoFactorEnabled).toBe(true);
    // B05: the column holds the sealed envelope — the seed has to be opened
    // before a code can be computed from it.
    const secret = openTotpSecret(enrolled?.twoFactorSecret ?? null);
    expect(secret).toBeTruthy();
    if (!secret) {
      throw new Error(
        "fixture: 2FA secret missing or unreadable (missing AUTH_SECRET?)",
      );
    }

    // Logout through the real sidebar control.
    await gotoSettings(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(/\/login/, { timeout: UI_TIMEOUT });
    await expect(page.getByLabel("Email")).toBeVisible();

    // Wrong code → rejected at the gate, session NOT issued.
    await page.getByLabel("Email").fill(USER.email);
    await page.getByLabel("Password").fill(USER.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    const codeInput = page.getByLabel("Two-factor code");
    await expect(codeInput).toBeVisible({ timeout: UI_TIMEOUT });
    await expect(
      page.locator("p").filter({ hasText: "Enter the 6-digit code" }).first(),
    ).toBeVisible({ timeout: UI_TIMEOUT });
    await codeInput.fill(staleTotp(secret));
    await page.getByRole("button", { name: "Sign in" }).click();
    // One text for every failed sign-in (B24): a wrong code answers with the
    // same text as a wrong password, so the reply never confirms that the
    // password was right.
    await expect(page.getByRole("alert").first()).toHaveText(
      "Incorrect email or password.",
      { timeout: UI_TIMEOUT },
    );
    await expect(codeInput).toBeVisible(); // still standing at the gate
    expect(page.url()).toContain("/login");
    await expect(page).toHaveURL(/\/login/, { timeout: UI_TIMEOUT });

    // Fresh code → accepted, lands back in THIS user's workspace.
    await codeInput.fill(totp(secret));
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(new RegExp(`/w/${WORKSPACE.slug}`), {
      timeout: UI_TIMEOUT,
    });
  });
});
