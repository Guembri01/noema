import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * B12 — object descriptions:
 *  (a) ticket drawer description autosaves and survives a reload,
 *  (b) project description shows in the header and saves,
 *  (c) an empty ticket description renders no box.
 *
 * Dedicated prisma-created rows with try/finally cleanup; never the shared
 * first page (see scripts/LOOP_PLAYBOOK.md e2e discipline).
 */

const CREDENTIALS = { email: "demo@noema.local", password: "password123" };

const prisma = new PrismaClient();

test.afterAll(async () => {
  await prisma.ticket.deleteMany({ where: { key: { startsWith: "B12-" } } }).catch(() => {});
  await prisma.project.deleteMany({ where: { name: { startsWith: "B12 project" } } }).catch(() => {});
  await prisma.$disconnect();
});

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(CREDENTIALS.email);
  await page.getByLabel("Password").fill(CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/w\//);
}

/**
 * Deterministic hydration signal: React attaches `__reactFiber$`/`__reactProps$`
 * keys to host nodes when it takes over from the server HTML. Filling a form
 * before that point only writes to the DOM — React restores its own state on
 * hydration and the Save handler carries stale state (observed flake: run 1
 * passed, rerun reverted the value to the original).
 */
async function waitForHydration(page: Page, selector: string) {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return !!el && Object.keys(el).some((key) => key.startsWith("__react"));
    },
    selector,
    { timeout: 15_000 },
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

/** Dedicated ticket with a unique key so locators can never collide. */
async function createTicket(title: string) {
  const { workspace, owner } = await workspaceAndOwner();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const number = 1_000_000 + Math.floor(Math.random() * 900_000);
    try {
      return await prisma.ticket.create({
        data: {
          workspaceId: workspace.id,
          number,
          key: `B12-${number}`,
          title,
          reporterId: owner.id,
        },
        select: { id: true, key: true },
      });
    } catch {
      // unique([workspaceId, number]) collision — retry with another number.
    }
  }
  throw new Error("could not allocate a free ticket number");
}

async function openDrawer(page: Page, key: string) {
  await page.goto("/w/demo-workspace/tickets");
  // Row buttons are server-rendered; clicking before hydration does nothing.
  await waitForHydration(page, "#main button");
  await page.getByRole("button", { name: key }).first().click();
  const drawer = page.getByRole("dialog", { name: new RegExp(`Ticket ${key}`) });
  await expect(drawer).toBeVisible();
  return drawer;
}

test.describe("descriptions", () => {
  test("ticket drawer description autosaves and survives a reload", async ({ page }) => {
    await signIn(page);
    const created = await createTicket(`B12 drawer ${Date.now()}`);

    try {
      const drawer = await openDrawer(page, created.key);
      const field = drawer.getByLabel("Ticket description");
      await field.fill("B12 drawer description body");

      // Debounced autosave (800 ms) lands in the database without any click.
      await expect
        .poll(
          async () => {
            const row = await prisma.ticket.findUnique({
              where: { id: created.id },
              select: { description: true },
            });
            return JSON.stringify(row?.description ?? null);
          },
          { timeout: 15_000 },
        )
        .toContain("B12 drawer description body");

      await page.reload();
      const reopened = await openDrawer(page, created.key);
      // A contenteditable has no `value`: the saved text is the editor's text.
      await expect(reopened.getByLabel("Ticket description")).toHaveText(
        "B12 drawer description body",
        { timeout: 15_000 },
      );
      // Non-empty description renders the box.
      await expect(reopened.getByTestId("ticket-description-box")).toHaveCount(1);
      // The rich field keeps the page editor's document shape, so the stored
      // description is still one `{ type: "doc" }` with the typed text inside.
      await expect
        .poll(
          async () => {
            const row = await prisma.ticket.findUnique({
              where: { id: created.id },
              select: { description: true },
            });
            return JSON.stringify(row?.description ?? null);
          },
          { timeout: 15_000 },
        )
        .toContain("B12 drawer description body");
    } finally {
      await prisma.ticket.delete({ where: { id: created.id } }).catch(() => {});
    }
  });

  test("project description shows in the header and saves", async ({ page }) => {
    await signIn(page);
    const { workspace } = await workspaceAndOwner();
    const created = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: `B12 project ${Date.now()}`,
        description: "B12 project description",
      },
      select: { id: true },
    });

    try {
      await page.goto(`/w/demo-workspace/projects/${created.id}`);
      const field = page.getByLabel("Project description");
      // The header form is client-rendered: wait for hydration, or fill()
      // writes to a DOM node React then reconciles away on takeover.
      await waitForHydration(page, 'textarea[aria-label="Project description"]');
      await expect(field).toHaveValue("B12 project description", { timeout: 15_000 });

      // Edit path: saved with the project form, then reloaded from the DB.
      await field.fill("B12 project description edited");
      // The value must stick (React controls it now) before we hit Save.
      await expect(field).toHaveValue("B12 project description edited");
      await page.getByRole("button", { name: "Save" }).click();
      await expect
        .poll(
          async () => {
            const row = await prisma.project.findUnique({
              where: { id: created.id },
              select: { description: true },
            });
            return row?.description;
          },
          { timeout: 15_000 },
        )
        .toBe("B12 project description edited");

      await page.reload();
      await expect(page.getByLabel("Project description")).toHaveValue(
        "B12 project description edited",
        { timeout: 15_000 },
      );
    } finally {
      await prisma.project.delete({ where: { id: created.id } }).catch(() => {});
    }
  });

  test("an empty ticket description keeps only the affordance", async ({ page }) => {
    await signIn(page);
    const created = await createTicket(`B12 empty ${Date.now()}`);

    try {
      const drawer = await openDrawer(page, created.key);
      const field = drawer.getByLabel("Ticket description");
      // The affordance stays (so it can be filled in)…
      await expect(field).toBeVisible();
      // …with the placeholder on the empty first block (an attribute no longer:
      // a contenteditable draws its hint from CSS, not from `placeholder`).
      await expect(drawer.locator(".ProseMirror .is-editor-empty")).toHaveCount(1);
      // …and the box stays dashed until there is something in it.
      await expect(drawer.getByTestId("ticket-description-box")).toHaveClass(/border-dashed/);
      // Nothing was written to the database by merely opening the drawer.
      const row = await prisma.ticket.findUnique({
        where: { id: created.id },
        select: { description: true },
      });
      expect(row?.description ?? null).toBeNull();
    } finally {
      await prisma.ticket.delete({ where: { id: created.id } }).catch(() => {});
    }
  });
});
