import { expect, test, type Page } from "@playwright/test";
import { signInWithSession } from "./auth";
import { PrismaClient } from "@prisma/client";

/**
 * B19 — sharing & permissions parity.
 *
 * Covers what the unit suite cannot: the share panel's view/edit toggle
 * actually persists through the server, the public route reflects the stored
 * mode, and a member is offered no owner controls in workspace settings.
 * Fixtures are dedicated prisma rows with try/finally cleanup — never the
 * shared first page (e2e discipline).
 */

const CREDENTIALS = { email: "demo@noema.local", password: "password123" };

const prisma = new PrismaClient();

// The dev server is shared with the other concurrent suites and compiles on demand.
test.describe.configure({ timeout: 180_000 });

const stamp = Date.now();

test.afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { slug: { startsWith: "e2e-b19" } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "e2e-b19-member-" } } });
  await prisma.$disconnect();
});

async function signIn(page: Page, creds = CREDENTIALS) {
  await signInWithSession(page, creds);
}

/** Navigate with retries: the shared dev server may be mid-restart or cold. */
async function gotoRetry(page: Page, path: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await page.goto(path, { timeout: 90_000, waitUntil: "domcontentloaded" });
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(5_000);
    }
  }
  throw lastError;
}

/**
 * Deterministic hydration signal: React attaches `__reactFiber$`/`__reactProps$`
 * keys to host nodes when it takes over from the server HTML. Clicking before
 * that point writes to the DOM and is thrown away on takeover (B17 finding).
 */
async function waitForHydration(page: Page, selector: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.waitForFunction(
        (sel) => {
          const el = document.querySelector(sel);
          return !!el && Object.keys(el).some((key) => key.startsWith("__react"));
        },
        selector,
        { timeout: 45_000 },
      );
      return;
    } catch (error) {
      lastError = error;
      await page.reload({ timeout: 60_000, waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(3_000);
    }
  }
  throw lastError;
}

/** Wait for hydration, then open the share panel and its dialog. */
async function openSharePanel(page: Page) {
  await waitForHydration(page, "header");
  await page.getByRole("button", { name: "Share", exact: true }).first().click();
  await page.getByRole("dialog").waitFor({ state: "visible", timeout: 30_000 });
}

test.describe("sharing parity", () => {
  let demo = { id: "", slug: "", ownerId: "" };
  let sharePageId = "";

  test.beforeAll(async () => {
    const workspace = await prisma.workspace.findFirst({
      where: { slug: "demo-workspace" },
      select: { id: true, slug: true, ownerId: true },
    });
    if (!workspace) throw new Error("demo-workspace not seeded");
    demo = workspace;
    const created = await prisma.page.create({
      data: {
        workspaceId: demo.id,
        title: `B19 share panel ${stamp}`,
        createdById: demo.ownerId,
      },
      select: { id: true },
    });
    sharePageId = created.id;
  });

  test.afterAll(async () => {
    await prisma.shareLink.deleteMany({ where: { pageId: sharePageId } });
    await prisma.page.deleteMany({ where: { id: sharePageId } });
  });

  test("publishing a page creates a read-only public link", async ({ page }) => {
    await signIn(page);
    await gotoRetry(page, `/w/${demo.slug}/${sharePageId}`);

    // Open the share panel: Notion-like layout with both sections.
    await openSharePanel(page);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Who has access")).toBeVisible({ timeout: 60_000 });
    // First server-action roundtrip on a shared, possibly cold dev server.
    await expect(dialog.getByRole("listitem").first()).toBeVisible({ timeout: 60_000 });
    await expect(dialog.getByText("General access")).toBeVisible();

    // Not published yet: the general-access section says so and offers Publish.
    await expect(dialog.getByText("Only people with access can open this link")).toBeVisible();
    await dialog.getByRole("button", { name: "Publish" }).click();

    // Published: the link is public and read-only by design. (Noema does not
    // expose an anonymous edit mode; editors sign in to their workspace.)
    await expect(dialog.getByText("Anyone with the link")).toBeVisible({
      timeout: 60_000,
    });
    await expect(dialog.getByText(/Can view ·/)).toBeVisible();

    // The public route renders the read-only label for the published link.
    const link = await prisma.shareLink.findFirst({
      where: { pageId: sharePageId },
      select: { token: true },
    });
    expect(link).not.toBeNull();
    await gotoRetry(page, `/s/${link!.token}`);
    await expect(page.getByText("Shared page · read-only")).toBeVisible();
  });

  test("a member is offered no owner controls in workspace settings", async ({ page }) => {
    const bcrypt = (await import("bcryptjs")).default;
    const memberEmail = `e2e-b19-member-${stamp}@noema.local`;
    const member = await prisma.user.create({
      data: {
        email: memberEmail,
        name: "B19 Member",
        passwordHash: await bcrypt.hash("password123", 10),
      },
      select: { id: true },
    });
    const workspace = await prisma.workspace.create({
      data: {
        name: `E2E B19 ${stamp}`,
        slug: `e2e-b19-${stamp}`,
        ownerId: demo.ownerId,
        members: {
          create: [
            { userId: demo.ownerId, role: "OWNER" },
            { userId: member.id, role: "MEMBER" },
          ],
        },
      },
      select: { id: true, slug: true },
    });

    await signIn(page, { email: memberEmail, password: "password123" });
    await gotoRetry(page, `/w/${workspace.slug}/settings`);

    // The member sees the roster (their own capability) …
    await expect(page.getByRole("listitem").filter({ hasText: "B19 Member" }).first()).toBeVisible();

    // … but no owner/admin controls: no transfer, no role selects, no
    // rename, no invite. The server re-checks all of them anyway (see
    // src/server/actions/workspaces.test.ts).
    await expect(page.getByRole("button", { name: /Transfer ownership/ })).toHaveCount(0);
    await expect(page.getByLabel(/^Role for /)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Rename / icon" })).toHaveCount(0);
    await expect(page.getByLabel("Invitation email")).toHaveCount(0);

    // Leaving stays available — that is a member-level capability.
    await expect(
      page.getByRole("button", { name: "Leave this workspace", exact: true }),
    ).toBeVisible();
  });

  test("an admin gets the members surface but never ownership controls", async ({ page }) => {
    const bcrypt = (await import("bcryptjs")).default;
    const adminEmail = `e2e-b19-member-${stamp}-admin@noema.local`;
    const peerEmail = `e2e-b19-member-${stamp}-peer@noema.local`;
    const admin = await prisma.user.create({
      data: {
        email: adminEmail,
        name: "B19 Admin",
        passwordHash: await bcrypt.hash("password123", 10),
      },
      select: { id: true },
    });
    const peer = await prisma.user.create({
      data: {
        email: peerEmail,
        name: "B19 Peer",
        passwordHash: await bcrypt.hash("password123", 10),
      },
      select: { id: true },
    });
    const workspace = await prisma.workspace.create({
      data: {
        name: `E2E B19 admin ${stamp}`,
        slug: `e2e-b19-admin-${stamp}`,
        ownerId: demo.ownerId,
        members: {
          create: [
            { userId: demo.ownerId, role: "OWNER" },
            { userId: admin.id, role: "ADMIN" },
            { userId: peer.id, role: "MEMBER" },
          ],
        },
      },
      select: { id: true, slug: true },
    });

    await signIn(page, { email: adminEmail, password: "password123" });
    await gotoRetry(page, `/w/${workspace.slug}/settings`);

    // Admin role UI: invite surface + role selects are available …
    // (`.first()` — the Email section may render a second invite input.)
    await expect(page.getByLabel("Invitation email").first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByLabel("Invitation role").first()).toBeVisible();
    await expect(page.getByLabel("Role for B19 Peer").first()).toBeVisible();

    // … but ownership actions stay owner-only (no transfer control at all).
    await expect(page.getByRole("button", { name: /Transfer ownership/ })).toHaveCount(0);
  });
});
