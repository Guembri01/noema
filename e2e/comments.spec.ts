import { expect, test, type Locator, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * B40 — page comments & threads:
 *  (a) create a comment thread from the composer and reply to it,
 *  (b) edit a comment in place (the path B14 root-fixed),
 *  (c) resolve a comment and reopen it,
 *  (d) delete a thread — its reply goes with it.
 *
 * Dedicated prisma-created pages with try/finally cleanup; never the shared
 * first page (see the e2e discipline). All assertions are
 * scoped to `#main`. The demo session is established once in `beforeAll` and
 * shared through `storageState`.
 *
 * Locator discipline (learned red-first, run1 — see report):
 *  - `getByText(body)` after filling the composer is a TRAP: React renders a
 *    controlled textarea's value as a child text node, so the composer keeps
 *    matching while the server action is still pending. Assert on the thread
 *    `listitem` row + the `Comments (n)` heading + the database instead.
 *  - A server action landing means DB row first, then DOM; the DOM waits use an
 *    explicit 30 s budget because `router.refresh()` is one extra round trip.
 */

const CREDENTIALS = { email: "demo@noema.local", password: "password123" };
const UI_TIMEOUT = 30_000;
/**
 * One demo login per file: `signIn()` costs a full /login round trip, and a
 * dev server busy recompiling (parallel runs) can take a minute on it. The
 * saved session keeps every test inside its own budget.
 */
const AUTH_STATE = join(tmpdir(), "noema-b40-auth.json");
// The `browser` fixture applies `storageState` to every context — including the
// one beforeAll logs in from — so start that one from an empty, valid state.
writeFileSync(AUTH_STATE, JSON.stringify({ cookies: [], origins: [] }));

const prisma = new PrismaClient();

test.afterAll(async () => {
  await prisma.page
    .deleteMany({ where: { title: { startsWith: "B40 comment page" } } })
    .catch(() => {});
  await prisma.$disconnect();
});

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(CREDENTIALS.email);
  await page.getByRole("textbox", { name: "Password" }).fill(CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/w\//);
}

/**
 * Deterministic hydration signal: React attaches `__reactFiber$`/`__reactProps$`
 * keys to host nodes when it takes over from the server HTML. Clicking or
 * filling before that point only writes to the DOM — the handler the click was
 * meant to fire does not exist yet.
 */
async function waitForHydration(page: Page, selector: string) {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return !!el && Object.keys(el).some((key) => key.startsWith("__react"));
    },
    selector,
    { timeout: UI_TIMEOUT },
  );
}

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

/** Dedicated page so locators can never collide with shared demo content. */
async function createCommentPage(label: string) {
  const { workspace, owner } = await workspaceAndOwner();
  return prisma.page.create({
    data: {
      workspaceId: workspace.id,
      title: `B40 comment page ${label} ${Date.now()}`,
      icon: "💬",
      createdById: owner.id,
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "B40" }] }],
      },
    },
    select: { id: true },
  });
}

/** Open the dedicated page and return the `#main` scope the panel lives in. */
async function openCommentPage(page: Page, pageId: string) {
  await page.goto(`/w/demo-workspace/${pageId}`);
  const main = page.locator("#main");
  await expect(main.getByRole("heading", { name: /Comments \(\d+\)/ })).toBeVisible({
    timeout: UI_TIMEOUT,
  });
  // The composer only exists once `canComment` is known and only becomes
  // interactive after hydration — wait for React before any fill()/click().
  await waitForHydration(page, "[data-comment-input]");
  return main;
}

/** The top-level thread row holding `text` (never the composer textarea). */
function commentRow(main: Locator, text: string): Locator {
  return main.getByRole("listitem").filter({ hasText: text }).first();
}

function headingCount(main: Locator, n: number): Locator {
  return main.getByRole("heading", { name: new RegExp(`Comments \\(${n}\\)`) });
}

/** The comment body must exist in the database with the expected parent. */
async function commentInDb(pageId: string, body: string, parentId: string | null) {
  await expect
    .poll(
      async () => {
        const row = await prisma.comment.findFirst({
          where: { pageId, body },
          select: { parentId: true },
        });
        return row !== null && row.parentId === parentId;
      },
      { timeout: UI_TIMEOUT },
    )
    .toBe(true);
}

test.describe("comments", () => {
  test.use({ storageState: AUTH_STATE });

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page);
    await context.storageState({ path: AUTH_STATE });
    await context.close();
  });

  test.afterAll(async () => {
    rmSync(AUTH_STATE, { force: true });
  });

  test("creates a comment thread and posts a reply", async ({ page }) => {
    const created = await createCommentPage("thread");

    try {
      const main = await openCommentPage(page, created.id);
      await expect(headingCount(main, 0)).toBeVisible({ timeout: UI_TIMEOUT });

      // — create the thread —
      const body = `B40 thread ${Date.now()}`;
      await main.getByLabel("Add a comment").fill(body);
      await main.getByRole("button", { name: "Post comment" }).click();

      await commentInDb(created.id, body, null);
      // A top-level comment is one thread: row appears and the heading counts it.
      await expect(commentRow(main, body)).toBeVisible({ timeout: UI_TIMEOUT });
      await expect(headingCount(main, 1)).toBeVisible({ timeout: UI_TIMEOUT });

      const parent = await prisma.comment.findFirst({
        where: { pageId: created.id, body },
        select: { id: true },
      });
      if (!parent) throw new Error("thread comment not persisted");

      // — reply to it —
      await main.getByRole("button", { name: "Reply", exact: true }).click();
      const replyBody = `B40 reply ${Date.now()}`;
      await main.getByLabel("Write a reply").fill(replyBody);
      await main.getByRole("button", { name: "Post reply" }).click();

      await commentInDb(created.id, replyBody, parent.id);
      // A reply nests inside its thread — no second top-level thread appears.
      const replyRow = commentRow(main, body).getByRole("listitem").filter({ hasText: replyBody });
      await expect(replyRow.first()).toBeVisible({ timeout: UI_TIMEOUT });
      await expect(headingCount(main, 1)).toBeVisible({ timeout: UI_TIMEOUT });

      // — the whole thread survives a reload —
      await page.reload();
      await expect(commentRow(main, body)).toBeVisible({ timeout: UI_TIMEOUT });
      await expect(replyRow.first()).toBeVisible({ timeout: UI_TIMEOUT });
      await expect(headingCount(main, 1)).toBeVisible({ timeout: UI_TIMEOUT });
    } finally {
      await prisma.page.delete({ where: { id: created.id } }).catch(() => {});
    }
  });

  test("edits a comment in place", async ({ page }) => {
    const created = await createCommentPage("edit");
    const { owner } = await workspaceAndOwner();
    const original = `B40 original ${Date.now()}`;
    const comment = await prisma.comment.create({
      data: { pageId: created.id, authorId: owner.id, body: original },
      select: { id: true },
    });

    try {
      const main = await openCommentPage(page, created.id);
      const row = commentRow(main, original);
      await expect(row).toBeVisible({ timeout: UI_TIMEOUT });

      await row.getByRole("button", { name: "Edit", exact: true }).click();
      const fixed = `B40 fixed ${Date.now()}`;
      await row.getByLabel("Edit comment").fill(fixed);
      await row.getByRole("button", { name: "Save", exact: true }).click();

      await expect
        .poll(
          async () => {
            const after = await prisma.comment.findUnique({
              where: { id: comment.id },
              select: { body: true },
            });
            return after?.body;
          },
          { timeout: UI_TIMEOUT },
        )
        .toBe(fixed);

      // Edited in place: the row now holds the new body (row-scoped, so the
      // edit textarea's own value can never fake the match) and the edit form
      // is gone from it.
      const editedRow = commentRow(main, fixed);
      await expect(editedRow).toBeVisible({ timeout: UI_TIMEOUT });
      await expect(editedRow.getByLabel("Edit comment")).toHaveCount(0, { timeout: UI_TIMEOUT });

      // …and a reload proves the original body is gone for good.
      await page.reload();
      await expect(commentRow(main, fixed)).toBeVisible({ timeout: UI_TIMEOUT });
      await expect(main.getByRole("listitem").filter({ hasText: original })).toHaveCount(0, {
        timeout: UI_TIMEOUT,
      });
    } finally {
      await prisma.page.delete({ where: { id: created.id } }).catch(() => {});
    }
  });

  test("resolves a comment and reopens it", async ({ page }) => {
    const created = await createCommentPage("resolve");
    const { owner } = await workspaceAndOwner();
    const body = `B40 resolve ${Date.now()}`;
    const comment = await prisma.comment.create({
      data: { pageId: created.id, authorId: owner.id, body },
      select: { id: true },
    });

    try {
      const main = await openCommentPage(page, created.id);
      const row = commentRow(main, body);
      await expect(row).toBeVisible({ timeout: UI_TIMEOUT });
      await expect(row.getByText("Resolved")).toHaveCount(0);

      await row.getByRole("button", { name: "Resolve", exact: true }).click();
      await expect
        .poll(async () => (await prisma.comment.findUnique({ where: { id: comment.id }, select: { resolved: true } }))?.resolved, {
          timeout: UI_TIMEOUT,
        })
        .toBe(true);
      await expect(row.getByText("Resolved")).toBeVisible({ timeout: UI_TIMEOUT });

      // The same button flips to Reopen.
      await row.getByRole("button", { name: "Reopen", exact: true }).click();
      await expect
        .poll(async () => (await prisma.comment.findUnique({ where: { id: comment.id }, select: { resolved: true } }))?.resolved, {
          timeout: UI_TIMEOUT,
        })
        .toBe(false);
      await expect(row.getByText("Resolved")).toHaveCount(0, { timeout: UI_TIMEOUT });
    } finally {
      await prisma.page.delete({ where: { id: created.id } }).catch(() => {});
    }
  });

  test("deletes a thread together with its reply", async ({ page }) => {
    const created = await createCommentPage("delete");

    try {
      const main = await openCommentPage(page, created.id);

      const body = `B40 doomed ${Date.now()}`;
      await main.getByLabel("Add a comment").fill(body);
      await main.getByRole("button", { name: "Post comment" }).click();
      await commentInDb(created.id, body, null);
      const parent = await prisma.comment.findFirst({
        where: { pageId: created.id, body },
        select: { id: true },
      });
      if (!parent) throw new Error("thread comment not persisted");
      await expect(commentRow(main, body)).toBeVisible({ timeout: UI_TIMEOUT });

      await main.getByRole("button", { name: "Reply", exact: true }).click();
      const replyBody = `B40 doomed reply ${Date.now()}`;
      await main.getByLabel("Write a reply").fill(replyBody);
      await main.getByRole("button", { name: "Post reply" }).click();
      await commentInDb(created.id, replyBody, parent.id);

      await commentRow(main, body)
        .getByRole("listitem")
        .filter({ hasText: replyBody })
        .first()
        .waitFor({ state: "visible", timeout: UI_TIMEOUT });

      // Delete the thread: reply cascades with it.
      await commentRow(main, body).getByRole("button", { name: "Delete", exact: true }).click();

      await expect
        .poll(async () => prisma.comment.count({ where: { pageId: created.id } }), {
          timeout: UI_TIMEOUT,
        })
        .toBe(0);
      // Thread and reply both leave the UI, and the count drops back to zero.
      await expect(commentRow(main, body)).toHaveCount(0, { timeout: UI_TIMEOUT });
      await expect(
        main.getByRole("listitem").filter({ hasText: replyBody }),
      ).toHaveCount(0, { timeout: UI_TIMEOUT });
      await expect(headingCount(main, 0)).toBeVisible({ timeout: UI_TIMEOUT });
    } finally {
      await prisma.page.delete({ where: { id: created.id } }).catch(() => {});
    }
  });
});
