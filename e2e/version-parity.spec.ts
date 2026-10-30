import { expect, test, type Page } from "@playwright/test";
import { signInWithSession } from "./auth";
import { PrismaClient } from "@prisma/client";

/**
 * B67 - targeted e2e for version-history M1 correctness
 * (docs/specs/version-history-v2.md, R30.1 + R30.6):
 *
 *  - R30.6: the panel renders the LIVE page state as a distinct "· current"
 *    header row, and the NEWEST snapshot row is restorable - previously row 0
 *    stored the pre-latest-edit state yet was labelled "current" with its
 *    Restore control suppressed, making "undo the last edit from history"
 *    impossible.
 *  - R30.1: restore rewrites `Page.searchText` with the save-path mirror, so
 *    the restored text is FTS-findable immediately (D8 regression guard,
 *    docs/specs/realtime-collab.md:93-96). Before the fix the restored text
 *    stayed invisible to search until the next edit.
 *
 * Dedicated prisma-created page + version with try/finally cleanup; never the
 * shared first page (e2e discipline). Assertions are
 * scoped to `#main` so the sidebar tree cannot satisfy them.
 */

const CREDENTIALS = { email: "demo@noema.local", password: "password123" };
const SLUG = "demo-workspace";
const TITLE = "B67 version history page";
/** Lives ONLY inside the seeded snapshot - never in the live page or its mirror. */
const MARKER = "zqxjbvquokka";

const prisma = new PrismaClient();

function doc(text: string) {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

const LIVE_BODY = doc("Live body of the B67 page without the marker text.");
const SNAPSHOT = doc(`Snapshot body holding the ${MARKER} marker before restore.`);

test.afterAll(async () => {
  await prisma.page
    .deleteMany({ where: { title: { startsWith: "B67 version" } } })
    .catch(() => {});
  await prisma.$disconnect();
});

async function signIn(page: Page) {
  await signInWithSession(page, CREDENTIALS);
}

/**
 * Navigation only, never assertions: with several suites running targeted
 * e2e against one `next dev`, a page load can come back `net::ERR_ABORTED`
 * when a concurrent run's compile interrupts it
 * (dev-server artifact). Copied from e2e/search.spec.ts (B39).
 */
async function gotoStable(page: Page, url: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await page.goto(url, { timeout: 45_000 });
      return;
    } catch (error) {
      lastError = error;
      console.log(`goto ${url} attempt ${attempt} failed:`, String(error).split("\n")[0]);
      if (!/ERR_ABORTED|Timeout|net::/.test(String(error))) throw error;
      await page.waitForTimeout(2_000);
    }
  }
  throw lastError;
}

test("R30.6 + R30.1: current header row, newest snapshot restorable, restore re-indexes text", async ({
  page,
}) => {
  test.setTimeout(600_000);
  const workspace = await prisma.workspace.findUnique({ where: { slug: SLUG } });
  const user = await prisma.user.findUnique({ where: { email: CREDENTIALS.email } });
  if (!workspace || !user) throw new Error("demo workspace/user missing - run npm run db:seed");

  try {
    const created = await prisma.page.create({
      data: {
        workspaceId: workspace.id,
        title: TITLE,
        content: LIVE_BODY,
        // Mirror of the LIVE body only - the marker must be FTS-invisible
        // until a restore rewrites the mirror (this is the R30.1 precondition).
        searchText: `${TITLE} Live body of the B67 page without the marker text.`,
        createdById: user.id,
        position: 970_000,
      },
    });
    await prisma.pageVersion.create({
      data: {
        pageId: created.id,
        title: TITLE,
        content: SNAPSHOT,
        createdById: user.id,
        summary: "Edited content",
        charDelta: 0,
        createdAt: new Date(Date.now() - 86_400_000),
      },
    });

    await signIn(page);

    // BEFORE the restore: the marker exists only in the version row, which is
    // never FTS-indexed -> search must come back empty.
    await gotoStable(page, `/w/${SLUG}/search?q=${MARKER}`);
    await expect(page.locator("#main").getByText(/0 results for/)).toBeVisible();

    // Panel: live state as a distinct header row; every snapshot restorable.
    await gotoStable(page, `/w/${SLUG}/${created.id}`);
    await page
      .getByRole("button", { name: /^Version history/ })
      .last()
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("version-current-row")).toBeVisible();
    await expect(dialog.getByTestId("version-current-row")).toContainText(TITLE);
    await expect(dialog.getByTestId("version-current-row")).toContainText("current");
    // The newest snapshot (row 0) keeps its Restore control (R30.6).
    await dialog.getByRole("button", { name: /restore/i }).click();
    await expect(page.getByText("Restored this version")).toBeVisible({ timeout: 90_000 });

    // AFTER the restore: Page.searchText was rewritten with the snapshot's
    // text, so the marker is FTS-findable immediately (R30.1).
    await gotoStable(page, `/w/${SLUG}/search?q=${MARKER}`);
    await expect(page.locator("#main").getByText(/1 result for/)).toBeVisible({ timeout: 45_000 });
    await expect(page.locator("#main").getByRole("link", { name: TITLE })).toBeVisible({ timeout: 45_000 });
  } finally {
    await prisma.page
      .deleteMany({ where: { title: { startsWith: "B67 version" } } })
      .catch(() => {});
  }
});



