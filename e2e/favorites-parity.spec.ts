import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * B44 — favorites sidebar parity:
 *  (a) starring a page surfaces it in the sidebar Favorites section,
 *  (b) the sidebar unfavorite hover action removes it,
 *  (c) the open-in-new-tab hover action targets the page in a new tab,
 *  (d) the favorites order persists across a reload.
 *
 * Dedicated prisma-created pages with try/finally cleanup; never the shared
 * first page (see the e2e discipline). Per-test sign-in
 * like every other spec: sharing a storage state across the team's concurrent
 * playwright runs proved less robust than paying the login cost directly.
 */

const CREDENTIALS = { email: "demo@noema.local", password: "password123" };

const prisma = new PrismaClient();

// Generous budgets: dev :3201 recompiles on demand and sign-in costs 30–90 s
// when concurrent suites are building against the same server.
const NAV_TIMEOUT = { timeout: 60_000 };

test.setTimeout(180_000);
// Note: several suites may run playwright concurrently in this working dir;
// the shared test-results/.playwright-artifacts-* dirs then collide mid-trace
// ("trace recording fixture timeout during setup"). Opt this spec out of
// tracing and give it its own output dir (see the run command).
test.use({ trace: "off" });

async function signIn(page: Page) {
  await page.goto("/login", NAV_TIMEOUT);
  await page.getByLabel("Email").fill(CREDENTIALS.email);
  await page.getByLabel("Password").fill(CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/w\//, NAV_TIMEOUT);
}

test.afterAll(async () => {
  await prisma.favorite
    .deleteMany({ where: { page: { title: { startsWith: "B44 fav" } } } })
    .catch(() => {});
  await prisma.page.deleteMany({ where: { title: { startsWith: "B44 fav" } } }).catch(() => {});
  await prisma.$disconnect();
});

async function workspaceAndOwner() {
  const workspace = await prisma.workspace.findFirst({
    where: { slug: "demo-workspace" },
    select: { id: true },
  });
  const owner = await prisma.user.findUnique({
    where: { email: CREDENTIALS.email },
    select: { id: true },
  });
  if (!workspace || !owner) throw new Error("demo workspace/user not seeded");
  return { workspace, owner };
}

/** Dedicated page so locators can never collide with seeded content. */
async function createPage(title: string) {
  const { workspace, owner } = await workspaceAndOwner();
  return prisma.page.create({
    data: { workspaceId: workspace.id, createdById: owner.id, title },
    select: { id: true, title: true },
  });
}

/** Favorite directly (seed helper); the starring UI is covered by test (a). */
async function favoriteDirectly(pageId: string) {
  const { owner } = await workspaceAndOwner();
  await prisma.favorite.create({ data: { userId: owner.id, pageId } });
}

const favoritesSection = (page: Page) => page.getByTestId("favorites-section");

/**
 * Deterministic hydration signal (see e2e/descriptions.spec.ts): clicking a
 * server-rendered button before React attaches only writes to the DOM.
 */
async function waitForHydration(page: Page, selector: string) {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return !!el && Object.keys(el).some((key) => key.startsWith("__react"));
    },
    selector,
    // 30 s: the editor page hydrates tiptap + collab on top of the star; under
    // concurrent load that stack occasionally needs more than 15 s.
    { timeout: 30_000 },
  );
}

/** Sidebar favorite rows as page-id order. */
async function favoriteOrder(page: Page): Promise<string[]> {
  return page
    .getByTestId("favorite-item")
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-page-id")).filter((id): id is string => !!id),
    );
}

test.describe("favorites sidebar parity", () => {
  test("starring a page surfaces it in the sidebar and unfavorite removes it", async ({
    page,
  }) => {
    const created = await createPage(`B44 fav appear ${Date.now()}`);
    await signIn(page);

    try {
      await page.goto(`/w/demo-workspace/${created.id}`, NAV_TIMEOUT);
      await waitForHydration(page, 'button[aria-label="Add to favorites"]');
      await page.getByRole("button", { name: "Add to favorites" }).click();
      // The star flips its label optimistically once the action lands. Assert
      // the flip via the ABSENCE of "Add to favorites" — the new sidebar
      // action shares the "Remove from favorites" label with the flipped star,
      // so a positive name match would be ambiguous (strict mode).
      await expect(page.locator('button[aria-label="Add to favorites"]')).toHaveCount(0);

      // The sidebar section lists the page, with a count badge on the header.
      // Generous timeout: the row lands via the RSC refresh after the action,
      // which costs 5–15 s on the dev server under concurrent load.
      const row = favoritesSection(page).locator(
        `[data-testid="favorite-item"][data-page-id="${created.id}"]`,
      );
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("favorites-count")).toBeVisible();

      // Hover reveals the row actions; unfavorite removes the row (again via
      // the RSC refresh).
      await row.hover();
      await row.getByTestId("favorite-remove").click();
      await expect(row).toHaveCount(0, { timeout: 30_000 });

      // The favorite row is gone from the database too.
      await expect
        .poll(async () => prisma.favorite.count({ where: { pageId: created.id } }), {
          timeout: 15_000,
        })
        .toBe(0);
    } finally {
      await prisma.favorite.deleteMany({ where: { pageId: created.id } }).catch(() => {});
      await prisma.page.delete({ where: { id: created.id } }).catch(() => {});
    }
  });

  test("the open-in-new-tab hover action targets the page in a new tab", async ({ page }) => {
    const created = await createPage(`B44 fav newtab ${Date.now()}`);
    await signIn(page);

    try {
      await favoriteDirectly(created.id);
      await page.goto(`/w/demo-workspace/${created.id}`, NAV_TIMEOUT);
      const row = favoritesSection(page).locator(
        `[data-testid="favorite-item"][data-page-id="${created.id}"]`,
      );
      await expect(row).toBeVisible();

      const openNew = row.getByTestId("favorite-open-new-tab");
      await expect(openNew).toHaveAttribute("target", "_blank");
      await expect(openNew).toHaveAttribute("href", `/w/demo-workspace/${created.id}`);
    } finally {
      await prisma.favorite.deleteMany({ where: { pageId: created.id } }).catch(() => {});
      await prisma.page.delete({ where: { id: created.id } }).catch(() => {});
    }
  });

  test("favorites order persists across a reload", async ({ page }) => {
    const stamp = Date.now();
    const first = await createPage(`B44 fav order-a ${stamp}`);
    const second = await createPage(`B44 fav order-b ${stamp}`);
    await signIn(page);

    try {
      // Favorite in sequence: A then B (Favorite.id asc is insertion order).
      await favoriteDirectly(first.id);
      await favoriteDirectly(second.id);

      await page.goto(`/w/demo-workspace/${first.id}`, NAV_TIMEOUT);
      await expect
        .poll(
          async () => {
            const ids = await favoriteOrder(page);
            return ids.includes(first.id) && ids.includes(second.id)
              ? ids.indexOf(first.id) < ids.indexOf(second.id)
              : false;
          },
          { timeout: 15_000 },
        )
        .toBe(true);

      const mine = (ids: string[]) =>
        JSON.stringify(ids.filter((id) => id === first.id || id === second.id));
      const before = mine(await favoriteOrder(page));

      await page.reload(NAV_TIMEOUT);
      await expect
        .poll(async () => mine(await favoriteOrder(page)), { timeout: 15_000 })
        .toBe(before);
    } finally {
      await prisma.favorite
        .deleteMany({ where: { pageId: { in: [first.id, second.id] } } })
        .catch(() => {});
      await prisma.page
        .deleteMany({ where: { id: { in: [first.id, second.id] } } })
        .catch(() => {});
    }
  });
});
