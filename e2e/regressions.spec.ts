import { expect, test, type Page } from "@playwright/test";
import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const CREDENTIALS = { email: "demo@noema.local", password: "password123" };
const SLUG = "demo-workspace";
const TITLE_PREFIX = "E2E regression";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(CREDENTIALS.email);
  await page.locator("#password").fill(CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/w\//);
}

async function createPage(
  title: string,
  content: Prisma.InputJsonValue = {
    type: "doc",
    content: [{ type: "paragraph" }],
  },
) {
  const workspace = await prisma.workspace.findUnique({
    where: { slug: SLUG },
    select: { id: true },
  });
  const owner = await prisma.user.findUnique({
    where: { email: CREDENTIALS.email },
    select: { id: true },
  });
  return prisma.page.create({
    data: {
      workspaceId: workspace!.id,
      title,
      content,
      createdById: owner!.id,
    },
    select: { id: true },
  });
}

test.afterAll(async () => {
  await prisma.apiToken.deleteMany({
    where: { name: { startsWith: TITLE_PREFIX } },
  });
  await prisma.ticket.deleteMany({ where: { title: { startsWith: TITLE_PREFIX } } });
  await prisma.page.deleteMany({ where: { title: { startsWith: TITLE_PREFIX } } });
  await prisma.project.deleteMany({ where: { name: { startsWith: TITLE_PREFIX } } });
  await prisma.$disconnect();
});

test.describe("editor regressions", () => {
  test("Enter in the title moves the caret into the body", async ({ page }) => {
    await signIn(page);
    const created = await createPage(`${TITLE_PREFIX} title-enter`);
    await page.goto(`/w/${SLUG}/${created.id}`);

    const title = page.getByLabel("Page title");
    await title.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");

    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeFocused();
    await page.keyboard.type("body-after-title");
    await expect(editor).toContainText("body-after-title");
  });

  test("autocorrect is off by default and corrects only when switched on", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NOEMA_E2E?: boolean }).__NOEMA_E2E = true;
    });
    await signIn(page);
    const created = await createPage(`${TITLE_PREFIX} autocorrect`);
    await page.goto(`/w/${SLUG}/${created.id}`);
    await page.waitForFunction(() => Boolean((window as unknown as { __noemaEditor?: unknown }).__noemaEditor));

    const toggle = page.getByRole("button", { name: "Turn autocorrect on" });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(
      page.getByRole("button", { name: "Turn autocorrect off" }),
    ).toHaveAttribute("aria-pressed", "true");

    const editor = page.locator(".ProseMirror").first();
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("recieve ");
    await expect(editor).toContainText("receive ");

    await page.getByRole("button", { name: "Turn autocorrect off" }).click();
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("wierd ");
    await expect(editor).toContainText("wierd ");
  });

  test("#### creates a real subsection heading", async ({ page }) => {
    await signIn(page);
    const created = await createPage(`${TITLE_PREFIX} heading`);
    await page.goto(`/w/${SLUG}/${created.id}`);

    const editor = page.locator(".ProseMirror").first();
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("#### Subsection ");
    await expect(editor.locator("> h4").last()).toHaveText("Subsection ");
  });

  test("the slash menu scrolls its active row into view", async ({ page }) => {
    await signIn(page);
    const created = await createPage(`${TITLE_PREFIX} slash-scroll`);
    await page.goto(`/w/${SLUG}/${created.id}`);

    const editor = page.locator(".ProseMirror").first();
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    const menu = page.getByTestId("slash-menu");
    await expect(menu).toBeVisible();
    for (let index = 0; index < 12; index += 1) {
      await page.keyboard.press("ArrowDown");
    }
    const active = menu.locator('[data-active="true"]');
    await expect(active).toBeVisible();
    const menuBox = (await menu.boundingBox())!;
    const activeBox = (await active.boundingBox())!;
    expect(activeBox.y).toBeGreaterThanOrEqual(menuBox.y);
    expect(activeBox.y + activeBox.height).toBeLessThanOrEqual(
      menuBox.y + menuBox.height + 1,
    );
  });

  test("/calendar inserts an inline calendar block", async ({ page }) => {
    await signIn(page);
    const created = await createPage(`${TITLE_PREFIX} calendar`);
    await page.goto(`/w/${SLUG}/${created.id}`);

    const editor = page.locator(".ProseMirror").first();
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/calendar");
    await expect(page.getByTestId("slash-menu")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-calendar-block]")).toBeVisible();
    await expect(page.locator("[data-calendar-block]")).toContainText("Today");
  });

  test("Tab adds repeated indentation outside lists", async ({ page }) => {
    await signIn(page);
    const created = await createPage(`${TITLE_PREFIX} tab`);
    await page.goto(`/w/${SLUG}/${created.id}`);

    const editor = page.locator(".ProseMirror").first();
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("indent");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(editor.locator("> p").last()).toHaveText(/indent\u00a0{8}/);
  });

  test("body edits appear in the global undo history", async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NOEMA_E2E?: boolean }).__NOEMA_E2E = true;
    });
    await signIn(page);
    const created = await createPage(`${TITLE_PREFIX} history`);
    await page.goto(`/w/${SLUG}/${created.id}`);
    await page.waitForFunction(() => Boolean((window as unknown as { __noemaEditor?: unknown }).__noemaEditor));

    const editor = page.locator(".ProseMirror").first();
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("history-body");
    // The bridge coalesces a typing burst before recording one entry.
    await page.waitForTimeout(900);

    await page.getByTestId("undo-history-trigger").click();
    await expect(page.getByTestId("undo-history-list")).toContainText("Edit page body");
    await page.getByTestId(/undo-history-undo-/).click();
    await expect(editor).not.toContainText("history-body");
  });

  test("pasted-image caption keeps focus while typing", async ({ page }) => {
    await signIn(page);
    const created = await createPage(`${TITLE_PREFIX} caption`);
    await page.goto(`/w/${SLUG}/${created.id}`);

    await page
      .locator('.noema-editor input[type="file"]')
      .setInputFiles("e2e/fixtures/pixel.png");
    const caption = page.locator(".noema-image-caption").first();
    await expect(caption).toBeVisible({ timeout: 30_000 });
    await caption.click();
    await page.keyboard.type("A caption typed in one go");
    await expect(caption).toHaveValue("A caption typed in one go");
    await expect(caption).toBeFocused();
  });

  test("image captions and alt text persist across reloads", async ({ page }) => {
    await signIn(page);
    const created = await createPage(`${TITLE_PREFIX} image`, {
      type: "doc",
      content: [
        {
          type: "image",
          attrs: {
            src: "data:image/png;base64,iVBORw0KGgo=",
            alt: "initial",
            caption: "",
          },
        },
      ],
    });
    await page.goto(`/w/${SLUG}/${created.id}`);

    const caption = page.getByLabel("Image caption").last();
    await caption.click();
    await page.keyboard.type("A single pixel");
    await caption.evaluate((element) => (element as HTMLInputElement).blur());
    await page.locator(".noema-image-alt").last().fill("one pixel of colour");
    await expect
      .poll(
        async () =>
          JSON.stringify(
            (
              await prisma.page.findUnique({
                where: { id: created.id },
                select: { content: true },
              })
            )?.content,
          ),
        { timeout: 15_000 },
      )
      .toContain("one pixel of colour");
    await page.reload();

    await expect(page.locator(".noema-image").last()).toHaveAttribute(
      "alt",
      "one pixel of colour",
    );
    await expect(page.getByLabel("Image caption").last()).toHaveValue(
      "A single pixel",
    );
  });

  test("an external link opens in a new tab", async ({ page }) => {
    await signIn(page);
    const created = await createPage(`${TITLE_PREFIX} external link`, {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Example",
              marks: [
                {
                  type: "link",
                  attrs: { href: "https://example.com", target: "_blank" },
                },
              ],
            },
          ],
        },
      ],
    });
    await page.goto(`/w/${SLUG}/${created.id}`);
    const popupPromise = page.waitForEvent("popup");
    await page.getByText("Example", { exact: true }).click();
    const popup = await popupPromise;
    expect(popup.url()).toContain("example.com");
    await popup.close();
  });

  test("an uploaded PDF renders in the inline viewer", async ({ page }) => {
    await signIn(page);
    const created = await createPage(`${TITLE_PREFIX} pdf`);
    await page.goto(`/w/${SLUG}/${created.id}`);

    await page.locator('.noema-editor input[type="file"]').setInputFiles({
      name: "regression.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n"),
    });
    const preview = page.locator("[data-pdf-preview]").first();
    await expect(preview).toBeVisible({ timeout: 30_000 });
    await expect(preview.locator("iframe")).toHaveAttribute(
      "src",
      /\/api\/files\/.+\/.+\.pdf$/,
    );
    await expect(preview.locator("iframe")).toHaveAttribute(
      "title",
      "regression.pdf",
    );
  });

  test("an internal mention navigates to its page", async ({ page }) => {
    await signIn(page);
    const target = await createPage(`${TITLE_PREFIX} mention target`);
    const source = await createPage(`${TITLE_PREFIX} mention source`, {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "mention",
              attrs: {
                id: target.id,
                label: "Mention target",
                type: "page",
              },
            },
          ],
        },
      ],
    });
    await page.goto(`/w/${SLUG}/${source.id}`);
    await page.locator("[data-mention]").click();
    await expect(page).toHaveURL(new RegExp(`/w/${SLUG}/${target.id}`));
  });

  test("the source panel serialises and applies Markdown", async ({ page }) => {
    await signIn(page);
    const created = await createPage(`${TITLE_PREFIX} source`);
    await page.goto(`/w/${SLUG}/${created.id}`);

    const editor = page.locator(".ProseMirror").first();
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("source body");
    await page.locator("[data-shadow-levels], [aria-label='View page source']").last().click();
    const input = page.getByTestId("page-source-input");
    await expect(input).toBeVisible();
    await expect(input).toHaveValue(/source body/);
    await page.getByTestId("page-source-apply").click();
    await expect(page.getByTestId("page-source-input")).toHaveCount(0);
  });
});

test.describe("workspace regressions", () => {
  test("Customize sidebar opens its own dialog instead of settings", async ({ page }) => {
    await signIn(page);
    await page.goto(`/w/${SLUG}`);
    await page.getByRole("button", { name: "Customize sidebar" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Home shortcuts");
    await expect(dialog).toContainText("Pages and imports");
    expect(page.url()).not.toContain("/settings");
  });

  test("Search all pages updates the URL without pressing Enter", async ({ page }) => {
    await signIn(page);
    await page.goto(`/w/${SLUG}/search`);
    const input = page.getByTestId("workspace-search-input");
    await input.fill("Noema");
    await page.waitForURL(/[?&]q=Noema/, { timeout: 10_000 });
  });

  test("tokens expose expiry presets and select-all", async ({ page }) => {
    await signIn(page);
    await page.goto(`/w/${SLUG}/settings/tokens`);

    await page.getByLabel("Token expiration").click();
    await page.getByRole("option", { name: "7 days" }).click();
    const selectAll = page.getByRole("button", { name: "Select all" });
    await selectAll.click();
    await expect(selectAll).toBeDisabled();
    await expect(
      page.getByTestId("token-scope-picker").getByRole("button", { name: "Clear" }),
    ).toBeEnabled();

    await page.locator("#api-token-name").fill(`${TITLE_PREFIX} token`);
    await page.getByRole("button", { name: "Create token" }).click();
    await expect(page.getByText(/Copy this token now/i)).toBeVisible();
  });

  test("ticket cards show their status and move between columns immediately", async ({
    page,
  }) => {
    await signIn(page);
    const workspace = await prisma.workspace.findUnique({
      where: { slug: SLUG },
      select: { id: true },
    });
    const owner = await prisma.user.findUnique({
      where: { email: CREDENTIALS.email },
      select: { id: true },
    });
    const last = await prisma.ticket.findFirst({
      where: { workspaceId: workspace!.id },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const number = (last?.number ?? 0) + 1;
    const ticket = await prisma.ticket.create({
      data: {
        workspaceId: workspace!.id,
        number,
        key: `E2E-${number}`,
        title: `${TITLE_PREFIX} ticket`,
        status: "todo",
        reporterId: owner!.id,
      },
      select: { id: true, key: true },
    });

    await page.goto(`/w/${SLUG}/tickets`);
    const source = page.locator(`[data-ticket-id="${ticket.id}"]`);
    await expect(source).toBeVisible({ timeout: 20_000 });
    await expect(source.locator('[data-testid="ticket-board-card"]')).toHaveAttribute(
      "data-status",
      "todo",
    );

    const target = page.locator('[data-drop-status="done"]');
    // Native HTML5 DnD is not reliably synthesized by `dragTo` in headless
    // Chrome; dispatch the same event sequence the browser produces.
    await page.evaluate(
      ({ id, status }) => {
        const source = document.querySelector<HTMLElement>(
          `[data-ticket-id="${id}"]`,
        );
        const target = document.querySelector<HTMLElement>(
          `[data-drop-status="${status}"]`,
        );
        if (!source || !target) throw new Error("ticket drag targets missing");
        const dataTransfer = new DataTransfer();
        source.dispatchEvent(
          new DragEvent("dragstart", { bubbles: true, dataTransfer }),
        );
        target.dispatchEvent(
          new DragEvent("dragenter", { bubbles: true, dataTransfer }),
        );
        target.dispatchEvent(
          new DragEvent("dragover", {
            bubbles: true,
            cancelable: true,
            dataTransfer,
          }),
        );
        target.dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer,
          }),
        );
        source.dispatchEvent(
          new DragEvent("dragend", { bubbles: true, dataTransfer }),
        );
      },
      { id: ticket.id, status: "done" },
    );
    await expect(
      target.locator(`[data-ticket-id="${ticket.id}"]`),
    ).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(
        async () =>
          (
            await prisma.ticket.findUnique({
              where: { id: ticket.id },
              select: { status: true },
            })
          )?.status,
        { timeout: 10_000 },
      )
      .toBe("done");
  });

  test("the sidebar Add button creates a page promptly", async ({ page }) => {
    await signIn(page);
    await page.goto(`/w/${SLUG}`);
    const started = Date.now();
    await page
      .getByTestId("sidebar")
      .getByRole("button", { name: "Add", exact: true })
      .click();
    await page.waitForURL(new RegExp(`/w/${SLUG}/[a-z0-9]+$`), {
      timeout: 10_000,
    });
    await expect(page.locator(".ProseMirror")).toBeVisible();
    expect(Date.now() - started).toBeLessThan(10_000);
    const id = page.url().split("/").pop()!;
    await prisma.page.delete({ where: { id } }).catch(() => {});
  });

  test("an existing page can be attached from the project page", async ({ page }) => {
    await signIn(page);
    const workspace = await prisma.workspace.findUnique({
      where: { slug: SLUG },
      select: { id: true },
    });
    const project = await prisma.project.create({
      data: { workspaceId: workspace!.id, name: `${TITLE_PREFIX} project` },
      select: { id: true },
    });
    const pageRow = await createPage(`${TITLE_PREFIX} project note`);
    await page.goto(`/w/${SLUG}/projects/${project.id}`);
    await page.waitForTimeout(1200);

    await page.getByRole("button", { name: "Attach existing page" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole("checkbox", {
        name: `Attach ${TITLE_PREFIX} project note`,
      })
      .check();
    await dialog.getByRole("button", { name: /^Attach/ }).click();

    await expect(page.getByRole("link", { name: new RegExp(`${TITLE_PREFIX} project note`) })).toBeVisible();
    const attached = await prisma.page.findUnique({
      where: { id: pageRow.id },
      select: { projectId: true },
    });
    expect(attached?.projectId).toBe(project.id);
  });

  test("deleting the open page redirects away instead of showing 404", async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NOEMA_E2E?: boolean }).__NOEMA_E2E = true;
    });
    await signIn(page);
    const created = await createPage(`${TITLE_PREFIX} delete`);
    await page.goto(`/w/${SLUG}/${created.id}`);
    await page.waitForFunction(() => Boolean((window as unknown as { __noemaEditor?: unknown }).__noemaEditor));

    await page.getByRole("button", { name: "Actions", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Page actions" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("menuitem", { name: /Move to Trash/ }).click();

    await page.waitForURL(new RegExp(`/w/${SLUG}/?$`), { timeout: 15_000 });
    await expect(page.getByText(/This page does not exist/i)).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (
            await prisma.page.findUnique({
              where: { id: created.id },
              select: { deletedAt: true },
            })
          )?.deletedAt,
        { timeout: 15_000 },
      )
      .not.toBeNull();
  });
});
