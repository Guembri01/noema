import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * B58 — AI quick wins (R25.17): the composer's draft must survive a send that
 * fails *before* the server has taken the message, and the failed send must
 * leave no orphan optimistic bubble behind.
 *
 * Both failures are forced client-side so nothing is persisted and no provider
 * is involved:
 *  - transport death → `page.route` aborts `/api/chat/stream` (fetch rejects);
 *  - rejected send → the route answers 503 and the single-shot fallback rejects
 *    the oversized body deterministically ("That message is too long.").
 *
 * Red-first: against the unfixed `chat-panel.tsx` both tests fail at
 * `toHaveValue(...)` after their error toast has appeared.
 */

const CREDENTIALS = { email: "demo@noema.local", password: "password123" };
const prisma = new PrismaClient();

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(CREDENTIALS.email);
  await page.getByLabel("Password").fill(CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/w\//);
}

/** Dedicated discussion per test (structural convention: own row + cleanup). */
async function createThread() {
  const workspace = await prisma.workspace.findFirst({ select: { id: true, slug: true } });
  const user = await prisma.user.findUnique({
    where: { email: CREDENTIALS.email },
    select: { id: true },
  });
  const thread = await prisma.chatThread.create({
    data: {
      workspaceId: workspace!.id,
      createdById: user!.id,
      title: `B58 draft thread ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    },
  });
  return { slug: workspace!.slug, threadId: thread.id };
}

test.afterAll(async () => {
  await prisma.chatThread.deleteMany({ where: { title: { startsWith: "B58 draft thread" } } });
  await prisma.$disconnect();
});

test.describe("R25.17 — never eat the draft", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NOEMA_E2E?: boolean }).__NOEMA_E2E = true;
    });
  });

  test("a dead stream transport gives the draft back after the error toast", async ({ page }) => {
    const { slug, threadId } = await createThread();
    // Transport dies before any response — nothing can have been persisted.
    await page.route("**/api/chat/stream", (route) => route.abort());

    await signIn(page);
    await page.goto(`/w/${slug}?chat=${threadId}`);
    const panel = page.getByLabel("AI conversation");
    const composer = panel.getByLabel("Ask the AI");
    await expect(composer).toBeVisible({ timeout: 60_000 });

    const draft = "B58 draft that must survive a transport failure";
    await composer.fill(draft);
    await panel.getByRole("button", { name: "Send message" }).click();

    // The failure surfaces first…
    await expect(page.locator("[data-sonner-toast]").getByText(/reach the server/i).first()).toBeVisible({ timeout: 60_000 });
    // …then the exact text the user typed is back in the composer.
    await expect(composer).toHaveValue(draft, { timeout: 60_000 });
    // No orphan optimistic bubble: the failed send left no trace in the thread.
    await expect(panel.locator("li").filter({ hasText: draft })).toHaveCount(0, { timeout: 60_000 });
  });

  test("a rejected send (503) gives the draft back when the fallback fails too", async ({ page }) => {
    const { slug, threadId } = await createThread();
    await page.route("**/api/chat/stream", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "AI unavailable" }),
      }),
    );

    await signIn(page);
    await page.goto(`/w/${slug}?chat=${threadId}`);
    const panel = page.getByLabel("AI conversation");
    const composer = panel.getByLabel("Ask the AI");
    await expect(composer).toBeVisible({ timeout: 60_000 });

    // Over the action's 4000-char cap: the single-shot fallback rejects it
    // deterministically (no provider needed), so nothing is persisted.
    const draft = `B58 ${"x".repeat(4000)}`;
    await composer.fill(draft);
    await panel.getByRole("button", { name: "Send message" }).click();

    await expect(page.locator("[data-sonner-toast]").getByText(/too long/i).first()).toBeVisible({ timeout: 60_000 });
    await expect(composer).toHaveValue(draft, { timeout: 60_000 });
    await expect(panel.locator("li").filter({ hasText: draft })).toHaveCount(0, { timeout: 60_000 });
  });

  test("a successful send consumes the draft and lands in the thread", async ({ page }) => {
    const { slug, threadId } = await createThread();

    await signIn(page);
    await page.goto(`/w/${slug}?chat=${threadId}`);
    const panel = page.getByLabel("AI conversation");
    const composer = panel.getByLabel("Ask the AI");
    await expect(composer).toBeVisible({ timeout: 60_000 });

    const draft = "B58 happy path: does this land in the thread?";
    await composer.fill(draft);
    await panel.getByRole("button", { name: "Send message" }).click();

    // The question reaches the thread (optimistic bubble, then the persisted
    // row) …
    await expect(panel.locator("li").filter({ hasText: draft }).first()).toBeVisible({ timeout: 60_000 });
    // … and the draft is consumed for good — the restore must never misfire
    // on a successful send.
    await expect(composer).toHaveValue("", { timeout: 60_000 });
    await page.waitForTimeout(5_000);
    await expect(composer).toHaveValue("");
    await expect(panel.locator("li").filter({ hasText: draft }).first()).toBeVisible();
  });
});
