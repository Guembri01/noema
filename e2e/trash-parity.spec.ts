import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * B42 — trash parity:
 *  (a) restore from trash persists (row leaves the trash, `deletedAt` cleared),
 *  (b) permanent delete needs the inline hard confirmation and destroys the
 *      whole subtree permanently (children included),
 *  (c) "Empty trash" also asks before it destroys anything — cancelling keeps
 *      every trashed page.
 *
 * Every test builds its own trashed pages through prisma and removes them in a
 * `finally` block — never the shared seed data (e2e discipline).
 * Destructive flows only ever touch these dedicated fixtures.
 */

const CREDENTIALS = { email: "demo@noema.local", password: "password123" };

const prisma = new PrismaClient();

// A cold dev server compiles routes on demand and other suites share it, so
// the per-test budget is deliberately generous (the config is 60s): it has to
// absorb the sign-in retry loop when several suites compile at once.
test.describe.configure({ timeout: 300_000 });

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: Page) {
  // The dev server is shared: it can be restarting under us (another suite's
  // Tier HEAVY build) and concurrent source edits thrash the turbopack cache, so
  // sign-in is retried instead of failing the test. `domcontentloaded` not
  // `load`: under compile storms individual chunks stall for minutes while
  // the HTML (and the server-action form, which works without hydration)
  // arrives in seconds.
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await page.goto("/login", { timeout: 60_000, waitUntil: "domcontentloaded" });
      await page.getByLabel("Email").fill(CREDENTIALS.email);
      await page.getByRole("textbox", { name: "Password" }).fill(CREDENTIALS.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/w\//, { timeout: 60_000, waitUntil: "domcontentloaded" });
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(10_000);
    }
  }
  throw lastError;
}

async function gotoWithRetry(page: Page, url: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await page.goto(url, { timeout: 60_000, waitUntil: "domcontentloaded" });
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(10_000);
    }
  }
  throw lastError;
}

/**
 * Deterministic hydration signal: React attaches `__reactFiber$`/`__reactProps$`
 * keys to host nodes when it takes over from the server HTML. Clicking before
 * that point writes to the DOM and is thrown away on takeover.
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

/* ---------------------------------------------------------------------------
   Fixture builders
   --------------------------------------------------------------------------- */

async function demoWorkspace() {
  const workspace = await prisma.workspace.findFirst({
    where: { slug: "demo-workspace" },
    select: { id: true, slug: true },
  });
  const owner = await prisma.user.findUnique({
    where: { email: CREDENTIALS.email },
    select: { id: true },
  });
  if (!workspace || !owner) throw new Error("demo workspace/user not seeded");
  return { workspace, owner };
}

/** A dedicated trashed page (soft-deleted, listed on /w/<slug>/trash). */
async function createTrashedPage(title: string, parentId?: string) {
  const { workspace, owner } = await demoWorkspace();
  return prisma.page.create({
    data: {
      workspaceId: workspace.id,
      ...(parentId ? { parentId } : {}),
      title,
      createdById: owner.id,
      deletedAt: new Date(),
      isArchived: true,
    },
    select: { id: true },
  });
}

async function findPage(id: string) {
  return prisma.page.findUnique({ where: { id }, select: { id: true, deletedAt: true } });
}

async function openTrash(page: Page) {
  const { workspace } = await demoWorkspace();
  await signIn(page);
  await gotoWithRetry(page, `/w/${workspace.slug}/trash`);
  await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible({ timeout: 30_000 });
  // TrashList is a client component: its buttons only fire once React has
  // taken over the server HTML (every fixture creates a row, so the header
  // controls exist on the server-rendered page).
  await waitForHydration(page, ".mb-3 button");
}

/* ---------------------------------------------------------------------------
   (a) Restore persists
   --------------------------------------------------------------------------- */

test("restores a trashed page and the restore persists", async ({ page }) => {
  // Explicit per-test budget: describe-level timeout did not reliably apply.
  test.setTimeout(400_000);
  const title = `B42 restore ${Date.now()}`;
  const created = await createTrashedPage(title);
  try {
    await openTrash(page);

    const row = page.getByRole("listitem").filter({ hasText: title }).first();
    await expect(row).toBeVisible();
    // exact: the row's trash icon is aria-labelled "Delete <title> forever" and
    // the fixture title itself contains "restore" — a substring match hits both.
    await row.getByRole("button", { name: "Restore", exact: true }).click();
    // Generous: the dev server compiles the changed action module on first use.
    await expect(page.getByText("Page restored")).toBeVisible({ timeout: 60_000 });

    // Persists in the database…
    await expect
      .poll(async () => (await findPage(created.id))?.deletedAt ?? false, { timeout: 30_000 })
      .toBeNull();

    // …and stays restored after a reload: the row is gone from the trash.
    await page.reload({ timeout: 60_000, waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: title })).toHaveCount(0);
  } finally {
    await prisma.page.deleteMany({ where: { id: created.id } });
  }
});

/* ---------------------------------------------------------------------------
   (b) Permanent delete: hard confirmation + subtree destroyed permanently
   --------------------------------------------------------------------------- */

test("permanently deletes a trashed page only after confirmation, children included", async ({
  page,
}) => {
  // Explicit per-test budget: describe-level timeout did not reliably apply.
  test.setTimeout(400_000);
  const stamp = Date.now();
  const parentTitle = `B42 purge parent ${stamp}`;
  const childTitle = `B42 purge child ${stamp}`;
  const parent = await createTrashedPage(parentTitle);
  const child = await createTrashedPage(childTitle, parent.id);
  try {
    await openTrash(page);

    const parentRow = page.getByRole("listitem").filter({ hasText: parentTitle }).first();
    const childRow = page.getByRole("listitem").filter({ hasText: childTitle }).first();
    await expect(parentRow).toBeVisible();
    await expect(childRow).toBeVisible();

    // Opening the confirmation deletes nothing.
    await parentRow.getByRole("button", { name: `Delete ${parentTitle} forever` }).click();
    const confirm = parentRow.getByRole("button", { name: "Delete forever" });
    await expect(confirm).toBeVisible();
    expect(await findPage(parent.id)).not.toBeNull();
    expect(await findPage(child.id)).not.toBeNull();

    // Cancelling keeps everything.
    await parentRow.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    expect(await findPage(parent.id)).not.toBeNull();

    // Confirming destroys the page — and its subtree — permanently.
    await parentRow.getByRole("button", { name: `Delete ${parentTitle} forever` }).click();
    await parentRow.getByRole("button", { name: "Delete forever" }).click();
    // Generous: the dev server compiles the changed action module on first use
    // and may be restarting under the shared dev server's load.
    await expect(page.getByText("Deleted forever")).toBeVisible({ timeout: 60_000 });

    await expect
      .poll(async () => (await findPage(parent.id)) ?? "gone", { timeout: 30_000 })
      .toBe("gone");
    await expect
      .poll(async () => (await findPage(child.id)) ?? "gone", { timeout: 30_000 })
      .toBe("gone");

    // Permanently gone from the list as well, after a reload.
    await page.reload({ timeout: 60_000, waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: parentTitle })).toHaveCount(0);
    await expect(page.getByRole("listitem").filter({ hasText: childTitle })).toHaveCount(0);
  } finally {
    await prisma.page.deleteMany({ where: { id: { in: [parent.id, child.id] } } });
  }
});

/* ---------------------------------------------------------------------------
   (c) Empty trash: hard confirmation, cancelling destroys nothing
   --------------------------------------------------------------------------- */

test("empty trash asks for confirmation and cancel keeps every trashed page", async ({ page }) => {
  // Explicit per-test budget: describe-level timeout did not reliably apply.
  test.setTimeout(400_000);
  const title = `B42 empty ${Date.now()}`;
  const created = await createTrashedPage(title);
  try {
    await openTrash(page);
    const row = page.getByRole("listitem").filter({ hasText: title }).first();
    await expect(row).toBeVisible();

    // The destructive step is gated behind an explicit confirmation.
    await page.getByRole("button", { name: "Empty trash" }).click();
    const confirm = page.getByRole("button", { name: "Delete forever" });
    await expect(confirm).toBeVisible();
    await expect(page.getByRole("button", { name: "Empty trash" })).toHaveCount(0);
    expect(await findPage(created.id)).not.toBeNull();

    // Cancelling leaves the trash untouched.
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: "Empty trash" })).toBeVisible();
    expect(await findPage(created.id)).not.toBeNull();
  } finally {
    await prisma.page.deleteMany({ where: { id: created.id } });
  }
});
