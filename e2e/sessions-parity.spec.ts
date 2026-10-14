import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { revokeAllSessionsForUser } from "../src/lib/session-store";

/**
 * B54 — session management parity (FEATURE_MATRIX §17):
 *  (a) the security settings list shows every signed-in device (this one
 *      included),
 *  (b) revoking the OTHER session from this device kills it — that context is
 *      bounced to /login on its very next request (reload),
 *  (c) "sign out of all sessions" ends every device, this one included.
 *
 * Dedicated prisma-created users/workspaces with try/finally cleanup (never
 * the shared demo account), two browser contexts = two devices.
 */

const prisma = new PrismaClient();

type Fixture = {
  userId: string;
  slug: string;
  email: string;
  password: string;
};

async function createFixture(prefix: string): Promise<Fixture> {
  const unique = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  const email = `b54-${unique}@example.test`;
  const password = "B54-parole-123!";
  const user = await prisma.user.create({
    data: { name: `B54 ${unique}`, email, passwordHash: await bcrypt.hash(password, 12) },
    select: { id: true },
  });
  const slug = `b54-${unique}`;
  await prisma.workspace.create({
    data: {
      name: `B54 ${unique}`,
      slug,
      ownerId: user.id,
      members: { create: { userId: user.id, role: "OWNER" } },
    },
  });
  return { userId: user.id, slug, email, password };
}

async function signIn(page: Page, fixture: Fixture) {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email").fill(fixture.email);
  await page.getByLabel("Password").fill(fixture.password);
  await page.getByRole("button", { name: "Sign in" }).click({ noWaitAfter: true });
  await page.waitForURL(/\/w\//, { waitUntil: "domcontentloaded" });
}

/**
 * Deterministic hydration signal (see e2e/favorites-parity.spec.ts): clicking a
 * server-rendered button before React attaches only writes to the DOM.
 */
async function waitForHydration(page: Page, selector: string) {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return !!el && Object.keys(el).some((key) => key.startsWith("__react"));
    },
    selector,
    { timeout: 120_000 },
  );
}

const sessionRows = (page: Page) => page.getByTestId("session-row");
const otherSessionRow = (page: Page) =>
  page.locator('[data-testid="session-row"][data-current="false"]');

async function cleanup(fixture: Fixture, contexts: BrowserContext[]) {
  for (const context of contexts) await context.close().catch(() => {});
  revokeAllSessionsForUser(fixture.userId);
  await prisma.workspace.deleteMany({ where: { slug: fixture.slug } }).catch(() => {});
  await prisma.user.deleteMany({ where: { email: fixture.email } }).catch(() => {});
}

test.describe.configure({ timeout: 300_000 });
// The dev server is shared with sibling batches; give navigations room.
test.use({ navigationTimeout: 120_000, actionTimeout: 60_000 });

test.describe("session management parity", () => {
  test("lists both devices; revoking the other session kills it on reload", async ({
    browser,
  }) => {
    const fixture = await createFixture("list-revoke");
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      // Two devices sign in to the same fresh account.
      await signIn(pageA, fixture);
      await signIn(pageB, fixture);

      // The settings list shows both sessions; exactly one is "this device".
      await pageA.goto(`/w/${fixture.slug}/settings`, { waitUntil: "domcontentloaded" });
      await expect(sessionRows(pageA)).toHaveCount(2, { timeout: 60_000 });
      await expect(pageA.getByTestId("session-current-badge")).toHaveCount(1);
      await expect(otherSessionRow(pageA)).toHaveCount(1);

      // Revoke the OTHER session from here.
      await waitForHydration(pageA, 'button[data-testid="session-revoke"]');
      await otherSessionRow(pageA).getByTestId("session-revoke").click();
      await expect(sessionRows(pageA)).toHaveCount(1, { timeout: 15_000 });
      // The surviving row is this device.
      await expect(
        pageA.locator('[data-testid="session-row"][data-current="true"]'),
      ).toHaveCount(1);

      // The revoked device dies on its next request: reload bounces to /login.
      await pageB.reload({ waitUntil: "domcontentloaded" });
      await expect(pageB).toHaveURL(/\/login/, { timeout: 30_000 });
      await expect(pageB.getByRole("button", { name: "Sign in" })).toBeVisible();

      // This device is still signed in after the reload.
      await pageA.reload({ waitUntil: "domcontentloaded" });
      await expect(sessionRows(pageA)).toHaveCount(1, { timeout: 45_000 });
    } finally {
      await cleanup(fixture, [contextA, contextB]);
    }
  });

  test("sign out of all sessions ends every device", async ({ browser }) => {
    const fixture = await createFixture("revoke-all");
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      await signIn(pageA, fixture);
      await signIn(pageB, fixture);

      await pageA.goto(`/w/${fixture.slug}/settings`, { waitUntil: "domcontentloaded" });
      await expect(sessionRows(pageA)).toHaveCount(2, { timeout: 60_000 });

      // Sign out everywhere: this device lands on /login…
      await waitForHydration(pageA, '[data-testid="revoke-all-sessions"]');
      await pageA.getByTestId("revoke-all-sessions").click();
      await expect(pageA).toHaveURL(/\/login/, { timeout: 30_000 });

      // …and the sibling device is dead on its next request too.
      await pageB.reload({ waitUntil: "domcontentloaded" });
      await expect(pageB).toHaveURL(/\/login/, { timeout: 30_000 });
    } finally {
      await cleanup(fixture, [contextA, contextB]);
    }
  });
});
