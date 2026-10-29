import { expect, test, type Page } from "@playwright/test";
import { signInWithSession } from "./auth";
import { PrismaClient } from "@prisma/client";

/**
 * B39 — workspace search + quick find:
 *  (a) full-text search finds a seeded page by its unique title,
 *  (b) a query nothing matches renders the empty state,
 *  (c) the search page with an empty query renders the form and no results list,
 *  (d) Ctrl+K opens quick find, filters down to a seeded page and navigates to it,
 *  (e) the sidebar "Quick find" button opens the palette, whose empty-query state
 *      lists only "Create a new page" (narrowing and clearing round-trip).
 *
 * Dedicated prisma-created pages with try/finally cleanup; never the shared
 * first page (see the e2e discipline). Assertions are
 * scoped to `#main`; the quick-find palette is a Radix portal on document.body,
 * so the palette itself is scoped to `role="dialog"` instead of `#main`.
 *
 * HONEST GAP — type/area ("section") filters are NOT covered: the search page
 * only reads `?q=` (`src/app/w/[slug]/search/page.tsx`), there is no filter
 * control anywhere in the search UI, and FEATURE_MATRIX rows "Search filters"
 * / "Search by type" are still 🧭 Planned. There is no filter to drive, so no
 * test is written for one (no skipped tests either) — reported instead.
 * `src/components/quick-find.tsx` is owned elsewhere: READ-ONLY
 * here; all palette behaviour below is asserted as-is.
 */

const CREDENTIALS = { email: "demo@noema.local", password: "password123" };
const SLUG = "demo-workspace";

const prisma = new PrismaClient();

test.afterAll(async () => {
  await prisma.page
    .deleteMany({ where: { title: { startsWith: "B39 search page" } } })
    .catch(() => {});
  await prisma.$disconnect();
});

async function signIn(page: Page) {
  await signInWithSession(page, CREDENTIALS);
}

/**
 * Navigation only, never assertions: with several suites running targeted e2e
 * against one `next dev`, a page load can come back `net::ERR_ABORTED` when a
 * a concurrent run's compile/restart interrupts it (dev-server artifact).
 * Retrying the goto keeps a real product failure red — it only skips the
 * connection-level abort that says nothing about the feature under test.
 */
async function gotoStable(page: Page, url: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      return;
    } catch (error) {
      lastError = error;
      if (!/ERR_ABORTED|ERR_CONNECTION|Timeout|net::/.test(String(error))) throw error;
      // Tolerate a concurrent suite restarting `next dev` (~10-30 s) or a
      // recompile stall; never more than the attempts below.
      await page.waitForTimeout(3_000);
    }
  }
  throw lastError;
}

/**
 * Deterministic hydration signal: React attaches `__reactFiber$`/`__reactProps$`
 * keys to host nodes when it takes over from the server HTML. Clicking a
 * server-rendered button before that point does nothing — the onClick handler
 * the click was meant to fire does not exist yet.
 */
async function waitForHydration(page: Page, selector: string) {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return !!el && Object.keys(el).some((key) => key.startsWith("__react"));
    },
    selector,
    { timeout: 30_000 },
  );
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

/**
 * Dedicated page with a unique title so locators can never collide.
 *
 * The shared dev database takes connection bursts from every live run, so a
 * fixture write can hit Prisma's 5 s connect timeout ("Can't reach database
 * server"). Retry that transient error only — a real database error still
 * throws, and a failed fixture must never turn into a vacuous green.
 */
async function withDbRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const message = String((error as Error)?.message ?? "");
      if (!/Can't reach database server|P1001|P1008|Timed out/.test(message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }
  throw lastError;
}

async function createSearchPage(label: string) {
  return withDbRetry(async () => {
    const { workspace, owner } = await workspaceAndOwner();
    const title = `B39 search page ${label} ${Date.now()}`;
    return prisma.page.create({
      data: {
        workspaceId: workspace.id,
        title,
        icon: "🔎",
        createdById: owner.id,
        content: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "B39 search coverage body" }] },
          ],
        },
        // Plain-text mirror the GIN full-text index reads (`src/lib/search.ts`).
        searchText: `${title} B39 search coverage body`,
      },
      select: { id: true, title: true },
    });
  });
}

async function deletePage(id: string) {
  await prisma.page.delete({ where: { id } }).catch(() => {});
}

const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const seededOption = (scope: ReturnType<Page["locator"]>, title: string) =>
  scope.getByRole("option", { name: new RegExp(escapeRe(title)) });

test.describe("search", () => {
  // Targeted e2e runs share this one `next dev`: a sign-in can take 40-90 s
  // while a route recompiles or another suite restarts the dev server. The 60 s
  // config default is sized for a quiet machine, so this file opts into a larger
  // budget; every expect() still asserts with the config's 15 s, so a real
  // product failure fails fast.
  test.beforeEach(() => {
    test.setTimeout(150_000);
  });
  test("full-text search finds a seeded page by its unique title", async ({ page }) => {
    await signIn(page);
    const seeded = await createSearchPage(`alpha ${Date.now()}`);

    try {
      await gotoStable(page, `/w/${SLUG}/search`);
      const main = page.locator("#main");
      // The form is a plain GET form: pressing Enter navigates for real.
      const input = main.getByPlaceholder("Search titles and page content…");
      await input.fill(seeded.title);
      await input.press("Enter");
      await expect(page).toHaveURL(/[?&]q=/);

      // The timestamp token cannot match anything else in the shared workspace,
      // so the ranked window holds exactly the seeded page.
      await expect(main.getByText(/1 result for/)).toBeVisible();
      await expect(main.locator(`a[href="/w/${SLUG}/${seeded.id}"]`)).toBeVisible();
      await expect(main.getByText(new RegExp(escapeRe(seeded.title))).first()).toBeVisible();
    } finally {
      await deletePage(seeded.id);
    }
  });

  test("a query nothing matches shows the empty state", async ({ page }) => {
    await signIn(page);
    const miss = `zb39nothingmatches${Date.now()}`;

    await gotoStable(page, `/w/${SLUG}/search?q=${miss}`);
    const main = page.locator("#main");
    await expect(main.getByText(/0 results for/)).toBeVisible();
    await expect(main.getByText("No results")).toBeVisible();
    await expect(main.locator("ul a")).toHaveCount(0);
  });

  test("an empty query renders the search form and no results list", async ({ page }) => {
    await signIn(page);

    await page.goto(`/w/${SLUG}/search`);
    const main = page.locator("#main");
    await expect(main.getByRole("heading", { name: "Search" })).toBeVisible();
    await expect(main.getByPlaceholder("Search titles and page content…")).toHaveValue("");
    // No "N results for …" summary and no result links before a query is typed.
    await expect(main.getByText(/results? for/)).toHaveCount(0);
    await expect(main.locator("ul a")).toHaveCount(0);
  });

  test("Ctrl+K opens quick find, filters to a seeded page and navigates to it", async ({ page }) => {
    await signIn(page);
    const seeded = await createSearchPage(`quick ${Date.now()}`);

    try {
      await gotoStable(page, `/w/${SLUG}/search`);
      // The Ctrl+K listener is attached by WorkspaceShell's effect: wait for the
      // shell to hydrate, then let the passive effect flush before pressing.
      await waitForHydration(page, "#main");
      await page.waitForTimeout(250);

      await page.keyboard.press("Control+k");
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      const input = dialog.getByRole("combobox");
      await expect(input).toBeVisible();

      // Empty query: the palette offers the always-on actions (and recents).
      await expect(dialog.getByRole("option", { name: "Create a new page" })).toBeVisible();

      // Typing narrows to the seeded page (180 ms debounce + server action).
      await input.fill(seeded.title);
      const seededItem = seededOption(dialog, seeded.title);
      await expect(seededItem).toBeVisible();

      // A query nothing matches filters it back out…
      await input.fill(`qqz${Date.now()}`);
      await expect(seededItem).toHaveCount(0);

      // …and re-typing brings it back.
      await input.fill(seeded.title);
      await expect(seededItem).toBeVisible();

      // Selecting the result closes the palette and routes to the page.
      await seededItem.click();
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/w/${SLUG}/${seeded.id}`));
      await expect(page.locator("#main").getByLabel("Page title")).toHaveValue(seeded.title);
    } finally {
      await deletePage(seeded.id);
    }
  });

  test("the sidebar Quick find button opens the palette with an empty-query state", async ({
    page,
  }) => {
    await signIn(page);
    const seeded = await createSearchPage(`sidebar ${Date.now()}`);

    try {
      await gotoStable(page, `/w/${SLUG}/search`);
      await waitForHydration(page, "#main");
      await waitForHydration(page, "aside button");

      const sidebar = page.getByRole("complementary");
      await sidebar.getByRole("button", { name: /Quick find/ }).click();

      const dialog = page.getByRole("dialog");
      const input = dialog.getByRole("combobox");
      await expect(input).toBeVisible();

      // Empty query: the palette shows its actions (recents are allowed too).
      await expect(dialog.getByRole("option", { name: "Create a new page" })).toBeVisible();

      // Typing narrows the list to the seeded page…
      await input.fill(seeded.title);
      await expect(seededOption(dialog, seeded.title)).toBeVisible();

      // …and clearing the query returns to the empty-query state.
      await input.fill("");
      await expect(seededOption(dialog, seeded.title)).toHaveCount(0);
      await expect(dialog.getByRole("option")).toHaveCount(1);

      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    } finally {
      await deletePage(seeded.id);
    }
  });
});
