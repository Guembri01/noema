import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * B20 — media & embeds parity:
 *  (a) a YouTube URL embeds through the provider-specific path (canonical
 *      embed URL + start time + provider badge), not a generic iframe,
 *  (b) drag-drop/file upload surfaces a progress indicator,
 *  (c) the image resize handle drags wider and the align controls stick,
 *  (d) a bookmark card surfaces the og:image thumbnail from the fetch layer,
 *  (e) the read-only doc renderer carries image width/align and thumbnails.
 *
 * Every test builds its own page through prisma and removes it in a `finally`
 * block — never the shared first page (e2e discipline).
 */

const CREDENTIALS = { email: "demo@noema.local", password: "password123" };

const prisma = new PrismaClient();

// A cold dev server compiles routes on demand and other suites share it (it
// has been observed restarting under memory pressure), so the per-test budget
// is deliberately generous (the config is 60s).
test.describe.configure({ timeout: 300_000 });

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: Page) {
  // The dev server is shared: it can be restarting under us (another suite's
  // Tier HEAVY build), so sign-in is retried instead of failing the test.
  // `domcontentloaded` (not `load`): a busy dev server streams subresources
  // long after the form is interactive.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto("/login", { timeout: 60_000, waitUntil: "domcontentloaded" });
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
      await page.reload({ timeout: 60_000, waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(3_000);
    }
  }
  throw lastError;
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

/** A dedicated page owned by this spec; the caller deletes it in `finally`. */
async function createPage(title: string, content?: object): Promise<string> {
  const { workspace, owner } = await workspaceAndOwner();
  const page = await prisma.page.create({
    data: {
      workspaceId: workspace.id,
      type: "PAGE",
      title,
      createdById: owner.id,
      position: 900_000,
      ...(content ? { content } : {}),
    },
    select: { id: true },
  });
  return page.id;
}

async function removePages(ids: string[]) {
  await prisma.page.deleteMany({ where: { id: { in: ids } } });
}

async function openPage(page: Page, pageId: string) {
  await signIn(page);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(`/w/demo-workspace/${pageId}`, {
        timeout: 60_000,
        waitUntil: "domcontentloaded",
      });
      // `.ProseMirror` is created imperatively by TipTap, so it never carries
      // React keys — hydrate on the editor shell instead.
      await waitForHydration(page, ".noema-editor");
      await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 30_000 });
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(3_000);
    }
  }
  throw new Error(`openPage failed: ${(lastError as Error | undefined)?.message ?? String(lastError)}`);
}

/**
 * Reload and wait for the editor to be interactive again — concurrent suites
 * hot-reload the shared dev server, so asserting straight after `reload()`
 * races a half-hydrated page.
 */
async function reloadEditor(page: Page) {
  // The shared dev server gets restarted by other suites mid-test; retry the
  // reload instead of failing on a refused connection.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await waitForHydration(page, ".noema-editor");
      await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 30_000 });
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(5_000);
    }
  }
  throw new Error(
    `reloadEditor failed: ${(lastError as Error | undefined)?.message ?? String(lastError)}`,
  );
}

/** The stored document as the server holds it (for persistence assertions). */
async function storedContent(pageId: string): Promise<{ content?: { content?: unknown[] } }> {
  const record = await prisma.page.findUnique({ where: { id: pageId }, select: { content: true } });
  return (record?.content ?? {}) as { content?: { content?: unknown[] } };
}

test.describe("media & embeds parity", () => {
  test("a YouTube URL embeds through the provider path with its start time", async ({ page }) => {
    const pageId = await createPage(`B20 embed ${Date.now()}`);
    try {
      await openPage(page, pageId);
      const editor = page.locator(".ProseMirror").first();
      await editor.click();
      await page.keyboard.type("/embed");
      await page.getByRole("button", { name: /^Embed/ }).click();

      await page.keyboard.type("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s");
      await page.keyboard.press("Enter");

      const frame = page.locator(".ProseMirror .noema-embed-frame").first();
      await expect(frame).toHaveAttribute("data-provider", "youtube", { timeout: 15_000 });
      await expect(frame.locator("iframe")).toHaveAttribute(
        "src",
        "https://www.youtube.com/embed/dQw4w9WgXcQ?start=90",
      );
      await expect(frame.locator(".noema-embed-provider")).toHaveText("YouTube");

      // The provider survives a save/reload round trip. Poll the stored
      // document; nudging the editor (a trailing paragraph) re-fires the save
      // when the dev server hot-reloaded mid-test and dropped the indicator.
      await expect
        .poll(
          async () => {
            if (JSON.stringify(await storedContent(pageId)).includes("dQw4w9WgXcQ")) return true;
            await editor.click();
            await page.keyboard.press("Control+End");
            await page.keyboard.press("Enter");
            return false;
          },
          { timeout: 60_000, intervals: [3_000] },
        )
        .toBe(true);
      await reloadEditor(page);
      const reloaded = page.locator(".ProseMirror .noema-embed-frame").first();
      await expect(reloaded).toHaveAttribute("data-provider", "youtube", { timeout: 30_000 });
      await expect(reloaded.locator("iframe")).toHaveAttribute(
        "src",
        "https://www.youtube.com/embed/dQw4w9WgXcQ?start=90",
      );
    } finally {
      await removePages([pageId]);
    }
  });

  test("uploading a dropped file shows a progress indicator", async ({ page }) => {
    const pageId = await createPage(`B20 upload ${Date.now()}`);
    // Hold the upload open so the in-flight indicator is observable, then let
    // the real request through (the asset must actually land).
    await page.route("**/api/upload", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await route.continue();
    });
    try {
      await openPage(page, pageId);
      const editor = page.locator(".ProseMirror").first();
      await editor.click();
      await page.keyboard.press("Control+End");
      await page.keyboard.press("Enter");
      await page.locator('.noema-editor input[type="file"]').setInputFiles("e2e/fixtures/pixel.png");

      const indicator = page.getByText(/Uploading pixel\.png/);
      await expect(indicator).toBeVisible({ timeout: 30_000 });
      // It reports a percent while the request is in flight…
      await expect(indicator).toContainText("%");
      // …and leaves once the upload settles; the image is in the document.
      await expect(indicator).toHaveCount(0, { timeout: 90_000 });
      await expect(page.locator(".ProseMirror .noema-image").first()).toBeVisible({
        timeout: 60_000,
      });
    } finally {
      await page.unroute("**/api/upload").catch(() => {});
      await removePages([pageId]);
    }
  });

  test("the image resize handle drags wider and alignment sticks across a reload", async ({
    page,
  }) => {
    const pageId = await createPage(`B20 resize ${Date.now()}`);
    try {
      await openPage(page, pageId);
      const editor = page.locator(".ProseMirror").first();
      await editor.click();
      await page.keyboard.press("Control+End");
      await page.keyboard.press("Enter");
      await page.locator('.noema-editor input[type="file"]').setInputFiles("e2e/fixtures/pixel.png");

      const block = page.locator(".ProseMirror .noema-image-block").first();
      await expect(block).toBeVisible({ timeout: 30_000 });
      await expect(block).toHaveAttribute("data-width", "");
      await expect(block).toHaveAttribute("data-align", "left");

      const figure = page.locator(".ProseMirror .noema-image-figure").first();
      // Raw mouse moves (no actionability hit-test): the handle overlaps the
      // 1px picture by design, sitting on its right edge.
      const figureBox = await figure.boundingBox();
      if (!figureBox) throw new Error("image figure not measurable");
      await page.mouse.move(figureBox.x + figureBox.width / 2, figureBox.y + figureBox.height / 2);
      const handle = page.getByTestId("image-resize-handle").first();
      await expect(handle).toBeVisible();

      const handleBox = await handle.boundingBox();
      if (!handleBox) throw new Error("resize handle not measurable");
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + 240, handleBox.y + handleBox.height / 2, { steps: 10 });
      await page.mouse.up();

      await expect(block).toHaveAttribute("data-width", /^\d+%$/, { timeout: 15_000 });
      const width = Number((await block.getAttribute("data-width"))?.replace("%", ""));
      expect(width).toBeGreaterThan(15);
      expect(width).toBeLessThanOrEqual(100);

      await page.getByTestId("image-align-center").click();
      await expect(block).toHaveAttribute("data-align", "center");

      // Both settings must land on the server. The dev server is shared with
      // concurrent suites, so the poll re-triggers the (idempotent) save the way
      // database-parity's pollConfig does: left→center is always a real doc
      // change, and one save carries width + align together.
      await expect
        .poll(
          async () => {
            const json = JSON.stringify(await storedContent(pageId));
            if (json.includes(`"align":"center"`) && /"width":\d+/.test(json)) return true;
            await page.getByTestId("image-align-left").click();
            await page.getByTestId("image-align-center").click();
            return false;
          },
          { timeout: 60_000, intervals: [2_000] },
        )
        .toBe(true);
      await reloadEditor(page);
      await expect(page.locator(".ProseMirror .noema-image-block").first()).toHaveAttribute(
        "data-align",
        "center",
        { timeout: 30_000 },
      );
      await expect(page.locator(".ProseMirror .noema-image-block").first()).toHaveAttribute(
        "data-width",
        /^\d+%$/,
      );
    } finally {
      await removePages([pageId]);
    }
  });

  test("a bookmark card surfaces the og:image thumbnail", async ({ page }) => {
    const pageId = await createPage(`B20 bookmark ${Date.now()}`);
    // The fetch layer is mocked at the API boundary: the card must surface
    // whatever metadata the link-preview route hands back.
    await page.route("**/api/link-preview*", (route) =>
      route.fulfill({
        json: {
          url: "https://example.com/article",
          host: "example.com",
          title: "B20 article",
          description: "Thumbnail metadata",
          image: "https://cdn.example.com/thumb.png",
          icon: "https://example.com/favicon.ico",
        },
      }),
    );
    try {
      await openPage(page, pageId);
      const editor = page.locator(".ProseMirror").first();
      await editor.click();
      await page.keyboard.type("/bookmark");
      await page.getByRole("button", { name: /^Bookmark/ }).click();

      // Drive the block's own input rather than trusting autofocus: the editor
      // can reclaim focus right after the node is inserted.
      const field = page.locator(".noema-bookmark-field");
      await expect(field).toBeVisible({ timeout: 30_000 });
      await field.fill("https://example.com/article");
      await field.press("Enter");

      const card = page.locator(".ProseMirror .noema-bookmark-card").first();
      await expect(card).toBeVisible({ timeout: 15_000 });
      const thumb = card.locator(".noema-bookmark-image");
      await expect(thumb).toBeVisible();
      await expect(thumb).toHaveAttribute("src", "https://cdn.example.com/thumb.png");
      await expect(card.locator(".noema-bookmark-title")).toHaveText("B20 article");

      // The metadata must reach the server. Poll the stored document and, if
      // the save has not landed yet, re-submit the card (same mocked
      // metadata, changed URL) — the dev server hot-reloads while other
      // suites edit files, which resets the save indicator mid-test.
      await expect
        .poll(
          async () => {
            if (JSON.stringify(await storedContent(pageId)).includes("B20 article")) return true;
            const edit = page.getByRole("button", { name: "Edit link" });
            if ((await edit.count()) > 0) {
              await edit.click();
              const field = page.locator(".noema-bookmark-field");
              await field.fill(`https://example.com/article?rev=${Date.now()}`);
              await field.press("Enter");
              await page.locator(".ProseMirror .noema-bookmark-card").first().waitFor({
                state: "visible",
                timeout: 15_000,
              });
            }
            return false;
          },
          { timeout: 90_000, intervals: [3_000] },
        )
        .toBe(true);
      await reloadEditor(page);
      const reloaded = page.locator(".ProseMirror .noema-bookmark-card").first();
      await expect(reloaded).toBeVisible({ timeout: 30_000 });
      await expect(reloaded.locator(".noema-bookmark-image")).toBeVisible();
    } finally {
      await page.unroute("**/api/link-preview*").catch(() => {});
      await removePages([pageId]);
    }
  });

  test("the read-only renderer carries image width/align and bookmark thumbnails", async ({
    page,
  }) => {
    const stamp = Date.now();
    const sourceId = await createPage(`B20 source ${stamp}`, {
      type: "doc",
      content: [
        {
          type: "image",
          attrs: {
            src: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
            alt: "a pixel",
            caption: "One pixel",
            width: 60,
            align: "center",
          },
        },
        {
          type: "bookmark",
          attrs: {
            url: "https://example.com/a",
            host: "example.com",
            title: "Source card",
            image: "https://cdn.example.com/thumb.png",
          },
        },
      ],
    });
    const hostId = await createPage(`B20 host ${stamp}`, {
      type: "doc",
      content: [{ type: "pageEmbed", attrs: { pageId: sourceId, title: "Source" } }],
    });
    try {
      await openPage(page, hostId);
      const body = page.locator("[data-page-embed] .noema-page-embed-body").first();
      await expect(body).toBeVisible({ timeout: 60_000 });

      const figure = body.locator(".noema-image-block").first();
      await expect(figure).toHaveAttribute("data-width", "60%", { timeout: 60_000 });
      await expect(figure).toHaveAttribute("data-align", "center");
      await expect(figure).toHaveAttribute("style", /width:\s*60%/);
      await expect(body.locator(".noema-image-caption-view")).toHaveText("One pixel");

      const thumb = body.locator(".noema-bookmark-image").first();
      await expect(thumb).toBeVisible();
      await expect(thumb).toHaveAttribute("src", "https://cdn.example.com/thumb.png");
      await expect(body.locator(".noema-bookmark-title").first()).toHaveText("Source card");
    } finally {
      await removePages([sourceId, hostId]);
    }
  });
});
