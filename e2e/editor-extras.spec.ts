import { expect, test, type Page } from "@playwright/test";
import { signInWithSession } from "./auth";
import { PrismaClient } from "@prisma/client";

/**
 * B18 — editor micro-slice: markdown shortcuts, mention scoping, emoji.
 *
 *  (a) markdown shortcut long tail expands in the editor:
 *      `1)` ordered list, `[] ` checkbox, `## ` heading and a
 *      `| Name | Qty |` + Enter table (the genuinely new input rules),
 *  (b) the @-mention picker is scoped to the current workspace
 *      (a page in another workspace never appears),
 *  (c) emoji shortcodes expand as you type (`:tada:` → 🎉) while unknown
 *      shortcodes stay literal.
 *
 * Every test builds its own prisma page(s) and removes them in a `finally`
 * block — never the shared first page (e2e discipline).
 */

const CREDENTIALS = { email: "demo@noema.local", password: "password123" };

const prisma = new PrismaClient();

// A cold dev server compiles routes on demand and other suites share it, so
// the per-test budget is deliberately generous (the config is 60s).
test.describe.configure({ timeout: 180_000 });

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: Page) {
  await signInWithSession(page, CREDENTIALS);
}

async function gotoWithRetry(page: Page, url: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(url, { timeout: 60_000 });
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(5_000);
    }
  }
  throw lastError;
}

async function workspaceAndOwner() {
  const workspace = await prisma.workspace.findFirst({
    where: { slug: "demo-workspace" },
    select: { id: true, slug: true },
  });
  const owner = await prisma.user.findFirst({
    where: { email: CREDENTIALS.email },
    select: { id: true },
  });
  if (!workspace || !owner) throw new Error("demo workspace/user not seeded");
  return { workspace, owner };
}

/** A dedicated, empty editor page; `cleanup` removes it. */
async function buildEditorPage(title: string) {
  const { workspace, owner } = await workspaceAndOwner();
  const created = await prisma.page.create({
    data: {
      workspaceId: workspace.id,
      type: "PAGE",
      title,
      createdById: owner.id,
      position: 920_000,
      content: { type: "doc", content: [{ type: "paragraph" }] },
    },
    select: { id: true },
  });
  return {
    pageId: created.id,
    workspaceId: workspace.id,
    cleanup: async () => {
      await prisma.page.delete({ where: { id: created.id } }).catch(() => {});
    },
  };
}

async function openEditor(page: Page, pageId: string) {
  const { workspace } = await workspaceAndOwner();
  await signIn(page);
  await gotoWithRetry(page, `/w/${workspace.slug}/${pageId}`);
  const editor = page.locator(".ProseMirror");
  await expect(editor).toBeVisible({ timeout: 45_000 });
  await editor.click();
  return editor;
}

test.describe("B18 editor extras", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NOEMA_E2E?: boolean }).__NOEMA_E2E = true;
    });
  });

  test("markdown shortcuts expand: 1) list, [] checkbox, ## heading, pipe table", async ({
    page,
  }) => {
    const fixture = await buildEditorPage(`B18 shortcuts ${Date.now()}`);
    try {
      const editor = await openEditor(page, fixture.pageId);

      // `1)` — the stock ordered-list rule only knows `1.`
      await page.keyboard.type("1) first item");
      await expect(editor.locator("ol li").first()).toHaveText("first item");

      // Leave the list: Enter on the empty item lifts back to a paragraph.
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");

      // `[] ` — checkbox (task list; the item renders as `li[data-checked]`).
      await page.keyboard.type("[ ] todo item");
      await expect(editor.locator("ul[data-type='taskList'] li")).toHaveCount(1);
      await expect(editor.locator("ul[data-type='taskList'] li").first()).toContainText("todo item");

      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");

      // `## ` — heading level 2.
      await page.keyboard.type("## Heading two");
      await expect(editor.locator("h2")).toHaveText("Heading two");

      await page.keyboard.press("Enter");

      // `| Name | Qty |` + Enter — a table that keeps the typed header row.
      await page.keyboard.type("| Name | Qty |");
      await page.keyboard.press("Enter");
      await expect(editor.locator("table")).toBeVisible();
      await expect(editor.locator("table th").first()).toHaveText("Name");
      await expect(editor.locator("table th").nth(1)).toHaveText("Qty");
    } finally {
      await fixture.cleanup();
    }
  });

  test("mention picker scopes pages to the current workspace", async ({ page }) => {
    const stamp = Date.now();
    const hostTitle = `B18 host ${stamp}`;
    const localTitle = `B18 local mention ${stamp}`;
    const foreignTitle = `B18 foreign mention ${stamp}`;
    const fixture = await buildEditorPage(hostTitle);
    let localPageId = "";
    let foreignWorkspaceId = "";
    try {
      const { workspace, owner } = await workspaceAndOwner();
      // The picker deliberately excludes the page being edited, so the
      // in-workspace target must be a *different* page from the host.
      const localPage = await prisma.page.create({
        data: {
          workspaceId: workspace.id,
          type: "PAGE",
          title: localTitle,
          createdById: owner.id,
          position: 1,
        },
        select: { id: true },
      });
      localPageId = localPage.id;
      const foreignWorkspace = await prisma.workspace.create({
        data: {
          name: `B18 foreign ${stamp}`,
          slug: `b18-foreign-${stamp}`,
          ownerId: owner.id,
        },
        select: { id: true },
      });
      foreignWorkspaceId = foreignWorkspace.id;
      await prisma.page.create({
        data: {
          workspaceId: foreignWorkspace.id,
          type: "PAGE",
          title: foreignTitle,
          createdById: owner.id,
          position: 1,
        },
      });

      await openEditor(page, fixture.pageId);
      await page.keyboard.type("@");
      const menu = page.locator("div.fixed.z-50", { hasText: "Mention" }).first();
      await expect(menu).toBeVisible({ timeout: 15_000 });
      await page.keyboard.type("B18", { delay: 40 });

      // In-workspace page is offered…
      await expect(menu.getByText(localTitle)).toBeVisible({ timeout: 15_000 });
      // …and the page from the other workspace never leaks into the menu.
      await expect(menu.getByText(foreignTitle)).toHaveCount(0);
    } finally {
      await fixture.cleanup();
      if (localPageId) {
        await prisma.page.delete({ where: { id: localPageId } }).catch(() => {});
      }
      if (foreignWorkspaceId) {
        await prisma.page
          .deleteMany({ where: { workspaceId: foreignWorkspaceId } })
          .catch(() => {});
        await prisma.workspace
          .delete({ where: { id: foreignWorkspaceId } })
          .catch(() => {});
      }
    }
  });

  test("emoji shortcodes expand while unknown ones stay literal", async ({ page }) => {
    const fixture = await buildEditorPage(`B18 emoji ${Date.now()}`);
    try {
      const editor = await openEditor(page, fixture.pageId);

      await page.keyboard.type("party :tada: time");
      await expect(editor).toContainText("party 🎉 time", { timeout: 15_000 });
      await expect(editor).not.toContainText(":tada:");

      await page.keyboard.press("Enter");
      await page.keyboard.type("keep :nope: literal");
      await expect(editor).toContainText("keep :nope: literal", { timeout: 15_000 });
    } finally {
      await fixture.cleanup();
    }
  });
});
