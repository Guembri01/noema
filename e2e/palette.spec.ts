import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * B43 — command palette + quick shortcuts parity:
 *  (a) Ctrl+K opens the command palette (`role="dialog"` with a `listbox`),
 *  (b) typing fuzzy-filters the list down to the seeded page,
 *  (c) Enter navigates to the highlighted page,
 *  (d) Ctrl+\ toggles the sidebar collapsed/expanded,
 *  (e) Ctrl+P also opens the palette (the quick-find row's key).
 *
 * Structural tests: every test builds its own dedicated page through prisma
 * and removes it in `finally` — never the shared first page.
 */

const CREDENTIALS = { email: "demo@noema.local", password: "password123" };
const SLUG = "demo-workspace";

const prisma = new PrismaClient();

// A cold dev server compiles routes on demand and other suites share it, so
// the per-test budget is deliberately generous (config default is 60s).
test.describe.configure({ timeout: 180_000 });

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: Page) {
  // The dev server is shared: it can be restarting under us (another suite's
  // Tier HEAVY build), so sign-in is retried instead of failing the test.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto("/login", { timeout: 60_000 });
      await page.getByLabel("Email").fill(CREDENTIALS.email);
      await page.getByLabel("Password").fill(CREDENTIALS.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/w\//, { timeout: 60_000 });
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(5_000);
    }
  }
  throw lastError;
}

/** Deterministic hydration signal (React has taken over the server HTML). */
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
      await page.reload({ timeout: 60_000 }).catch(() => {});
      await page.waitForTimeout(3_000);
    }
  }
  throw lastError;
}

async function workspaceAndOwner() {
  const workspace = await prisma.workspace.findFirst({
    where: { slug: SLUG },
    select: { id: true },
  });
  const owner = await prisma.user.findUnique({
    where: { email: CREDENTIALS.email },
    select: { id: true },
  });
  if (!workspace || !owner) throw new Error("demo workspace/user not seeded");
  return { workspace, owner };
}

/** A dedicated page owned by this spec; the caller deletes it in `finally`. */
async function createPage(title: string): Promise<string> {
  const { workspace, owner } = await workspaceAndOwner();
  const page = await prisma.page.create({
    data: {
      workspaceId: workspace.id,
      type: "PAGE",
      title,
      createdById: owner.id,
      position: 910_000,
    },
    select: { id: true },
  });
  return page.id;
}

async function removePages(ids: string[]) {
  // Cleanup must never be the reason a test fails: the shared DB engine can
  // hiccup under another suite's load, so one retry absorbs it.
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await prisma.page.deleteMany({ where: { id: { in: ids } } });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw lastError;
}

/** Sign in, then open a hydrated workspace page (the palette needs the shell). */
async function openWorkspacePage(page: Page, pageId: string) {
  await signIn(page);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(`/w/${SLUG}/${pageId}`, { timeout: 60_000 });
      await waitForHydration(page, "#main");
      await waitForHydration(page, '[data-testid="workspace-sidebar"] aside');
      return;
    } catch (error) {
      lastError = error;
      // The shared dev server can restart under a concurrent run's Tier HEAVY build;
      // swallow the teardown noise and retry on a fresh load.
      await page.waitForTimeout(3_000).catch(() => {});
    }
  }
  throw lastError;
}

test.describe("command palette + shortcuts parity", () => {
  test("Ctrl+K opens the palette, typing filters it, Enter navigates", async ({
    page,
  }) => {
    const targetId = await createPage(`B43 palette target ${Date.now()}`);
    // A unique title fragment the fuzzy matcher can isolate (the actions and
    // other pages won't contain it).
    const marker = `palette target ${targetId.slice(-8)}`;
    await prisma.page.update({
      where: { id: targetId },
      data: { title: `B43 ${marker}` },
    });
    try {
      await openWorkspacePage(page, targetId);

      await page.keyboard.press("Control+k");
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("listbox")).toBeVisible();
      const input = dialog.getByRole("combobox");
      await expect(input).toBeFocused();

      // Actions group is listed before any page on an empty query.
      await expect(dialog.getByRole("option").first()).toBeVisible();

      // Typing the unique fragment narrows to the seeded page alone.
      await input.fill(marker);
      await expect(dialog.getByRole("option")).toHaveCount(1);
      await expect(dialog.getByRole("option")).toContainText(marker);

      await page.keyboard.press("Enter");
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/w/${SLUG}/${targetId}`));
    } finally {
      await removePages([targetId]);
    }
  });

  test("Ctrl+P also opens the palette (quick-find row shortcut)", async ({
    page,
  }) => {
    const pageId = await createPage(`B43 ctrl-p ${Date.now()}`);
    try {
      await openWorkspacePage(page, pageId);

      await page.keyboard.press("Control+p");
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("listbox")).toBeVisible();

      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    } finally {
      await removePages([pageId]);
    }
  });

  test("Ctrl+\\ toggles the sidebar hidden and back", async ({ page }) => {
    const pageId = await createPage(`B43 toggle-sidebar ${Date.now()}`);
    try {
      await openWorkspacePage(page, pageId);

      const sidebar = page.getByTestId("workspace-sidebar");
      await expect(sidebar).toBeVisible();

      await page.keyboard.press("Control+\\");
      await expect(sidebar).toBeHidden();

      await page.keyboard.press("Control+\\");
      await expect(sidebar).toBeVisible();
    } finally {
      await removePages([pageId]);
    }
  });

  test("Ctrl+N creates a new page and navigates to it", async ({ page }) => {
    const hostId = await createPage(`B43 ctrl-n host ${Date.now()}`);
    const createdIds: string[] = [];
    try {
      await openWorkspacePage(page, hostId);
      const before = await page.url();

      await page.keyboard.press("Control+n");
      // The shell creates a root page and routes to it (new-page row).
      await page.waitForURL(new RegExp(`/w/${SLUG}/[a-z0-9]+$`), {
        timeout: 30_000,
      });
      const after = await page.url();
      expect(after).not.toBe(before);
      const createdId = after.split("?")[0].split("#")[0].split("/").pop()!;
      createdIds.push(createdId);
      expect(createdId).toMatch(/^[a-z0-9]+$/);
    } finally {
      await removePages([hostId, ...createdIds]);
    }
  });

  test("the palette's toggle-sidebar action collapses the sidebar", async ({
    page,
  }) => {
    const pageId = await createPage(`B43 palette-action ${Date.now()}`);
    try {
      await openWorkspacePage(page, pageId);

      const sidebar = page.getByTestId("workspace-sidebar");
      await expect(sidebar).toBeVisible();

      await page.keyboard.press("Control+k");
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("combobox").fill("toggle sidebar");
      await dialog.getByRole("option").first().click();

      await expect(dialog).toHaveCount(0);
      await expect(sidebar).toBeHidden();
    } finally {
      await removePages([pageId]);
    }
  });
});
