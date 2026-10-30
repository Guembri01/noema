import { expect, test, type Page } from "@playwright/test";
import { signInWithSession } from "./auth";
import { Prisma, PrismaClient } from "@prisma/client";

const CREDENTIALS = { email: "demo@noema.local", password: "password123" };

const prisma = new PrismaClient();
test.afterAll(async () => {
  // Remove what this suite creates so runs stay deterministic.
  await prisma.teamspace.deleteMany({ where: { name: { startsWith: "E2E team" } } });
  await prisma.project.deleteMany({ where: { name: { startsWith: "E2E project" } } });
  await prisma.project.deleteMany({ where: { name: { startsWith: "E2E timeline" } } });
  await prisma.cycle.deleteMany({ where: { name: { startsWith: "E2E cycle" } } });
  await prisma.chatThread.deleteMany({
    where: {
      OR: [
        { title: { startsWith: "/ask" } },
        { title: { startsWith: "List my projects" } },
        { title: "i18n check" },
        { title: "E2E answer actions" },
      ],
    },
  });
  await prisma.page.deleteMany({
    where: {
      OR: [
        { title: { startsWith: "E2E slash " } },
        { title: { startsWith: "paginated" } },
      ],
    },
  });
  await prisma.ticket.deleteMany({
    where: {
      OR: [
        { title: { startsWith: "paged ticket " } },
        { title: { startsWith: "cycle target " } },
      ],
    },
  });
  await prisma.$disconnect();
});

async function signIn(page: Page) {
  await signInWithSession(page, CREDENTIALS);
}

async function firstPage(page: Page) {
  const workspace = await prisma.workspace.findFirst({ select: { id: true, slug: true } });
  const target = await prisma.page.findFirst({
    where: { workspaceId: workspace!.id, type: "PAGE", deletedAt: null },
    select: { id: true },
  });
  await page.goto(`/w/${workspace!.slug}/${target!.id}`);
  await expect(page.locator(".ProseMirror")).toBeVisible();
  return target!.id;
}

test.describe("workspace", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __NOEMA_E2E?: boolean }).__NOEMA_E2E = true;
    });
  });

  test("signs in and shows the home template gallery", async ({ page }) => {
    await signIn(page);
    await expect(page.getByText(/Good (morning|afternoon|evening)/)).toBeVisible();
    for (const label of ["Empty page", "Empty database", "Task tracking", "Projects", "Meeting notes"]) {
      await expect(page.getByRole("button", { name: label })).toBeVisible();
    }
  });

  test("saves an edit and reloads it from the database", async ({ page }) => {
    await signIn(page);
    const pageId = await firstPage(page);

    const editor = page.locator(".ProseMirror").first();
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(` saved-by-e2e-${Date.now()}`);
    await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Save failed")).toHaveCount(0);

    await page.reload();
    await expect(page.locator(".ProseMirror")).toContainText("saved-by-e2e-");
    const stored = await prisma.page.findUnique({ where: { id: pageId }, select: { content: true } });
    expect(JSON.stringify(stored?.content)).toContain("saved-by-e2e-");
  });

  test("selection toolbar opens the AI panel next to the toolbar (not the corner)", async ({ page }) => {
    await signIn(page);
    await firstPage(page);

    const editor = page.locator(".ProseMirror").first();
    await editor.click();
    await page.keyboard.press("Control+A");

    const toolbar = page.locator("[data-bubble-toolbar]");
    await expect(toolbar).toBeVisible();

    const aiTrigger = toolbar.getByRole("button", { name: "Ask the AI" });
    const triggerBox = (await aiTrigger.boundingBox())!;
    await aiTrigger.click();
    // The AI menu is a portalled Radix popover now (not the old inline bubble
    // panel); locate its content by the skill list it renders.
    const panel = page
      .locator("[data-radix-popper-content-wrapper]")
      .filter({ hasText: "Improve writing" })
      .first();
    await expect(panel).toBeVisible();

    const panelBox = (await panel.boundingBox())!;
    // `align="center"` anchors the panel under the AI trigger, not under the
    // toolbar's left edge. Compare centres so the panel still proves it is
    // attached to the toolbar instead of parked in the viewport corner.
    const panelCenter = panelBox.x + panelBox.width / 2;
    const triggerCenter = triggerBox.x + triggerBox.width / 2;
    expect(panelBox.x).toBeGreaterThan(20); // never the viewport origin
    expect(Math.abs(panelCenter - triggerCenter)).toBeLessThan(160);
    // A tall skill menu can be collision-shifted when it cannot fit entirely
    // above or below the trigger. The stable contract is that it is attached
    // horizontally and rendered inside the viewport, not parked at the origin.
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    expect(panelBox.y).toBeGreaterThan(0);
    expect(panelBox.y).toBeLessThan(viewport!.height);

    for (const skill of ["Improve writing", "Proofread", "Explain"]) {
      await expect(panel.getByRole("button", { name: new RegExp(skill) })).toBeVisible();
    }
    // Translate is a section with a locale button per target, not one
    // "Translate" button. It sits at the bottom of the scrollable menu.
    const translateHeading = panel.getByText("Translate", { exact: true });
    await translateHeading.scrollIntoViewIfNeeded();
    await expect(translateHeading).toBeVisible();
    await expect(panel.getByRole("button", { name: /Français/ })).toBeVisible();
  });

  test("right-click block menu turns a paragraph into a heading", async ({ page }) => {
    await signIn(page);
    await firstPage(page);

    const paragraph = page.locator(".ProseMirror p").first();
    await paragraph.click({ button: "right" });

    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await page.getByRole("menuitem", { name: "Turn into" }).hover();
    await page.getByRole("menuitem", { name: "Heading 1" }).click();
    await expect(page.locator(".ProseMirror h1").first()).toBeVisible();
  });

  test("Comment anchors the selection and posts it", async ({ page }) => {
    await signIn(page);
    await firstPage(page);

    // Type a known word and select it: Ctrl+A can land on an empty leading
    // paragraph, which correctly produces an empty quote.
    const editor = page.locator(".ProseMirror").first();
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("anchorword");
    await page.keyboard.press("Control+Shift+ArrowLeft");

    // Scope to the selection toolbar: "Comment" is also the composer's button.
    const bubble = page.locator("[data-bubble-toolbar]");
    await expect(bubble).toBeVisible();
    await bubble.getByRole("button", { name: "Comment" }).click();

    const composer = page.locator("[data-comment-input]");
    await expect(composer).toBeFocused();
    // A quote chip is anchored to the selection and the placeholder reflects it.
    const quoteRow = page.getByLabel("Remove quoted text").locator("..");
    await expect(quoteRow).toBeVisible();
    await expect(quoteRow).toContainText(/\w+/);
    await expect(composer).toHaveAttribute("placeholder", /Comment on the selected text/);

    const body = `e2e comment ${Date.now()}`;
    await composer.fill(body);
    await page.getByRole("button", { name: "Post comment" }).click();
    await expect(page.getByText(body)).toBeVisible();
  });

  test("Move up reorders the selected block", async ({ page }) => {
    await signIn(page);
    const workspace = await prisma.workspace.findFirst({ select: { id: true, slug: true } });
    const owner = await prisma.user.findUnique({ where: { email: "demo@noema.local" } });
    // A dedicated page with known content keeps this deterministic.
    const created = await prisma.page.create({
      data: {
        workspaceId: workspace!.id,
        title: "E2E move",
        icon: "🧪",
        createdById: owner!.id,
        content: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "FIRST-BLOCK" }] },
            { type: "paragraph", content: [{ type: "text", text: "SECOND-BLOCK" }] },
          ],
        },
      },
      select: { id: true },
    });

    await page.goto(`/w/${workspace!.slug}/${created.id}`);
    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toContainText("SECOND-BLOCK");

    await page.locator(".ProseMirror p").filter({ hasText: "SECOND-BLOCK" }).first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move up", exact: true }).click();
    await page.waitForTimeout(800);

    const text = await editor.innerText();
    expect(text.indexOf("SECOND-BLOCK")).toBeLessThan(text.indexOf("FIRST-BLOCK"));

    await prisma.page.deleteMany({ where: { id: created.id } });
  });
  test("the equation dialog inserts LaTeX inline and block math", async ({ page }) => {
    await signIn(page);
    await firstPage(page);

    const editor = page.locator(".ProseMirror").first();
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/equation");
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog", { name: "Equation" });
    await expect(dialog).toBeVisible();
    await page.getByLabel("LaTeX source").fill("E = mc^2");
    await expect(dialog.locator(".katex").first()).toBeVisible();
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.locator(".ProseMirror .katex").first()).toBeVisible();

    // The newly inserted block is the last equation on the page. Use a real
    // pointer click: ProseMirror selects/re-renders the node on mousedown, so
    // the node view opens it from pointerdown before that replacement.
    await page.locator(".ProseMirror [data-equation-kind]").last().click();
    await expect(page.getByRole("dialog", { name: "Equation" })).toBeVisible();
    await expect(page.getByLabel("LaTeX source")).toHaveValue("E = mc^2");
    await page.keyboard.press("Escape");
  });

  test("right-clicking a sidebar page opens its action menu", async ({ page }) => {
    await signIn(page);
    await firstPage(page);

    const row = page.locator("[data-page-row]").first();
    await row.click({ button: "right" });
    for (const label of ["Open", "Discuss in chat", "Rename", "Toggle favorite", "Copy link", "Move to trash"]) {
      // The item's accessible name carries the icon's surrounding whitespace.
      await expect(
        page.getByRole("menuitem", {
          name: new RegExp(`^\\s*${label}\\s*$`),
        }),
      ).toBeVisible();
    }
  });

  test("projects track milestones", async ({ page }) => {
    await signIn(page);
    const workspace = await prisma.workspace.findFirst({ select: { id: true, slug: true } });
    await page.goto(`/w/${workspace!.slug}/projects`);

    const name = `E2E project ${Date.now()}`;
    await page.getByLabel("Project name").fill(name);
    await page.getByRole("button", { name: "Create" }).first().click();
    await expect(page.getByRole("heading", { name })).toBeVisible();

    await page.getByLabel("Milestone name").fill("Ship the beta");
    await page.getByRole("button", { name: "Add milestone" }).click();
    const milestones = page.locator("section", { hasText: "Milestones" }).last();
    await expect(milestones.getByText("Ship the beta").first()).toBeVisible();

    await page.getByRole("button", { name: "Advance Ship the beta" }).click();
    await expect(milestones.getByText("In progress", { exact: true }).first()).toBeVisible();
  });

  test("chat opens a docked panel and answers from the workspace", async ({ page }) => {
    const workspace = await prisma.workspace.findFirst({
      where: { slug: "demo-workspace" },
      select: { id: true, slug: true },
    });
    const stamp = Date.now();
    const question = `List my projects with their milestone progress ${stamp}.`;
    let threadId = "";

    try {
      await signIn(page);
      await firstPage(page);

      await page.getByRole("tab", { name: "Chat" }).click();
      await page.getByRole("button", { name: "New discussion" }).first().click();

      // The conversation lives in the main area, not the sidebar.
      const panel = page.getByRole("complementary", { name: "AI conversation" });
      await expect(panel).toBeVisible();
      await expect(panel.getByText("How can I help today?")).toBeVisible();

      // Wait for the composer to hydrate before filling it: a fill that lands
      // before React attaches leaves the controlled draft empty and the send
      // button disabled, which looks like a hung answer.
      await page.waitForFunction(() => {
        const el = document.querySelector('[aria-label="Ask the AI"]');
        return !!el && Object.keys(el).some((key) => key.startsWith("__react"));
      });
      const composer = panel.getByLabel("Ask the AI");
      await composer.fill(question);
      const send = panel.getByRole("button", { name: "Send message" });
      await expect(send).toBeEnabled();
      await send.click();

      // The server answers with a grounded assistant turn. Its meta carries
      // the tool activity the docked panel renders. Re-open the persisted
      // discussion for the assertions, so a slow client refresh cannot leave
      // the panel on its skeleton forever.
      await expect
        .poll(
          async () => {
            const thread = await prisma.chatThread.findFirst({
              where: {
                workspaceId: workspace!.id,
                title: { contains: String(stamp) },
              },
              orderBy: { createdAt: "desc" },
              select: {
                id: true,
                messages: { where: { role: "assistant" }, select: { id: true } },
              },
            });
            if (!thread || thread.messages.length === 0) return false;
            threadId = thread.id;
            return true;
          },
          { timeout: 60_000, intervals: [1_000] },
        )
        .toBe(true);

      await page.goto(`/w/${workspace!.slug}?chat=${threadId}`);
      const rendered = page.getByRole("complementary", { name: "AI conversation" });
      await expect(rendered.getByText(/Reviewed projects|Searched notes/).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        rendered.locator("li").filter({ hasText: /project|milestone|note/i }).first(),
      ).toBeVisible();
    } finally {
      if (threadId) {
        await prisma.chatThread.delete({ where: { id: threadId } }).catch(() => {});
      }
    }
  });

  test("typing LaTeX becomes an editable equation", async ({ page }) => {
    await signIn(page);
    await firstPage(page);

    const editor = page.locator(".ProseMirror").first();
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("$a^2 + b^2 = c^2$");

    await expect(page.locator(".ProseMirror .katex").last()).toBeVisible();
    await expect(page.locator(".ProseMirror [data-type='inline-math']").last()).toHaveAttribute(
      "data-latex",
      "a^2 + b^2 = c^2",
    );
  });

  test("projects have a timeline and can invite a client", async ({ page }) => {
    await signIn(page);
    const workspace = await prisma.workspace.findFirst({ select: { id: true, slug: true } });
    await page.goto(`/w/${workspace!.slug}/projects`);

    const name = `E2E timeline ${Date.now()}`;
    await page.getByLabel("Project name").fill(name);
    await page.getByRole("button", { name: "Create" }).first().click();
    await expect(page.getByRole("heading", { name })).toBeVisible();

    await expect(page.getByText("Timeline", { exact: true }).first()).toBeVisible();

    const email = `client-${Date.now()}@example.test`;
    await page.getByRole("button", { name: "Invite a client" }).click();
    await page.getByLabel("Client email").fill(email);
    await page.getByRole("button", { name: "Send invitation" }).click();
    await expect(page.getByText(/\/invite\/[A-Za-z0-9_-]{20,}/)).toBeVisible();

    await prisma.project.deleteMany({ where: { name } });
    await prisma.invite.deleteMany({ where: { email } });
  });
  test("AI answers render as rich text, not raw markdown", async ({ page }) => {
    await signIn(page);
    const workspace = await prisma.workspace.findFirst({ select: { id: true, slug: true } });
    const user = await prisma.user.findUnique({
      where: { email: "demo@noema.local" },
      select: { id: true },
    });
    const thread = await prisma.chatThread.create({
      data: {
        workspaceId: workspace!.id,
        createdById: user!.id,
        title: "E2E markdown thread",
      },
    });
    await prisma.chatMessage.createMany({
      data: [
        { threadId: thread.id, userId: user!.id, role: "user", body: "Summarise the data model" },
        {
          threadId: thread.id,
          userId: null,
          role: "assistant",
          body: [
            "## Synthesis",
            "",
            "The **data model** is ready.",
            "",
            "- notes",
            "- tasks",
            "",
            "| Area | State |",
            "| --- | --- |",
            "| Editor | done |",
            "",
            "Next: read [[page:abc123|Roadmap]].",
          ].join("\n"),
          meta: { activity: ["Reviewed notes"], model: "deepseek-flash" },
        },
      ],
    });

    await page.goto(`/w/${workspace!.slug}?chat=${thread.id}`);
    const panel = page.getByLabel("AI conversation");
    await expect(panel.getByRole("heading", { name: "Synthesis" })).toBeVisible();
    await expect(panel.locator("strong", { hasText: "data model" })).toBeVisible();
    await expect(panel.getByRole("table")).toBeVisible();
    await expect(panel.getByRole("listitem").filter({ hasText: "notes" }).first()).toBeVisible();
    await expect(panel.getByText("Roadmap")).toBeVisible();
    // Raw markdown must never reach the screen.
    await expect(panel.getByText("**data model**")).toHaveCount(0);
    await expect(panel.getByText("## Synthesis")).toHaveCount(0);

    await prisma.chatThread.delete({ where: { id: thread.id } });
  });
  test("tickets: create with estimate and dates, then read the timeline", async ({ page }) => {
    await signIn(page);
    const workspace = await prisma.workspace.findFirst({ select: { slug: true } });
    await page.goto(`/w/${workspace!.slug}/tickets`);

    const title = `E2E ticket ${Date.now()}`;
    const due = new Date().toISOString().slice(0, 10);
    await page.getByRole("button", { name: "New ticket" }).click();
    await page.getByLabel("Ticket title").fill(title);
    await page.getByRole("spinbutton", { name: "Ticket estimate" }).fill("3");
    await page.getByLabel("Ticket due date").click();
    await page
      .getByTestId("calendar-grid")
      .locator(`[data-day="${due}"]`)
      .click();
    await page
      .getByTestId("ticket-composer")
      .getByRole("button", { name: "Create ticket" })
      .click();

    // On the board…
    await expect(page.getByText(title)).toBeVisible();
    await expect(page.getByText("3 points").first()).toBeVisible();

    // …and on the Gantt timeline as a dated bar.
    await page.getByRole("radio", { name: "Timeline" }).click();
    await expect(page.getByText(title)).toBeVisible();
    const saved = await prisma.ticket.findFirst({
      where: { title },
      select: { dueDate: true },
    });
    expect(saved?.dueDate?.toISOString().slice(0, 10)).toBe(due);

    await prisma.ticket.deleteMany({ where: { title } });
  });
  test("mentions/notifications workspace settings expose teamspace invites and AI providers", async ({ page }) => {
    await signIn(page);
    const workspace = await prisma.workspace.findFirst({ select: { slug: true } });
    await page.goto(`/w/${workspace!.slug}/settings`);

    // Teamspace by email
    const teamspaces = page.locator("section", { hasText: "Teamspaces" }).last();
    const teamspaceName = `E2E team ${Date.now()}`;
    await teamspaces.getByLabel("Teamspace name").fill(teamspaceName);
    await teamspaces.getByRole("button", { name: "Create" }).click();
    await expect(teamspaces.getByText(teamspaceName)).toBeVisible();

    const row = teamspaces.locator("li", { hasText: teamspaceName }).first();
    const email = `e2e-${Date.now()}@example.com`;
    await row.getByLabel(`Invite by email to ${teamspaceName}`).fill(email);
    await row.getByRole("button", { name: "Invite" }).click();
    await row.getByText(`${email} · member · pending`).waitFor();

    // AI provider settings
    const ai = page.locator("section", { hasText: "AI provider" }).last();
    const provider = ai.getByLabel("AI provider");
    await expect(provider).toBeVisible();
    // The provider picker is the shared combobox, not a native <select>:
    // its options live in a portal and only exist while the menu is open.
    await provider.click();
    const providerOptions = page.getByRole("listbox").last().getByRole("option");
    for (const label of [
      "OpenAI",
      "DeepSeek",
      "Google Gemini",
      "Custom (OpenAI-compatible)",
    ]) {
      // Row text is `label` followed by its endpoint description; anchor the
      // match so "Any OpenAI-compatible endpoint" does not match OpenAI.
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      await expect(
        providerOptions.filter({ hasText: new RegExp(`^${escaped}`) }),
      ).toHaveCount(1);
    }
    await page.keyboard.press("Escape");
    // The editable fields live in the separate "Models" section under the
    // provider cards, not inside the provider section itself.
    const models = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Models", exact: true }) })
      .last();
    await expect(models.getByLabel("AI model")).toBeVisible();
    await expect(models.getByLabel("AI API key")).toBeVisible();
    await expect(page.getByRole("button", { name: "Test connection" }).first()).toBeVisible();
    await expect(models.getByRole("button", { name: "Fetch models" })).toBeVisible();
  });
});

/**
 * Coherence: every control that exists must do something, and every action the
 * app exposes must be reachable from the interface.
 */
test.describe("coherence", () => {
  test("chat answer offers actions on right-click and saves as a note", async ({ page }) => {
    await signIn(page);
    const workspace = await prisma.workspace.findFirst({ select: { id: true, slug: true } });
    const user = await prisma.user.findUnique({
      where: { email: "demo@noema.local" },
      select: { id: true },
    });
    const thread = await prisma.chatThread.create({
      data: { workspaceId: workspace!.id, createdById: user!.id, title: "E2E answer actions" },
    });
    const title = `saved answer ${Date.now()}`;
    await prisma.chatMessage.createMany({
      data: [
        { threadId: thread.id, userId: user!.id, role: "user", body: "Summarise the plan" },
        {
          threadId: thread.id,
          userId: null,
          role: "assistant",
          body: `### ${title}\n\nThe **plan** is ready.\n\n- one\n- two`,
          meta: { model: "deepseek-flash" },
        },
      ],
    });

    await page.goto(`/w/${workspace!.slug}?chat=${thread.id}`);
    const panel = page.getByLabel("AI conversation");
    const answer = panel.locator("div.notion-markdown").first();
    await expect(answer).toBeVisible();

    // The answer menu is the visible "Answer actions" control; hover reveals
    // it, then the menu carries the same copy / save / open commands.
    const openAnswerMenu = async () => {
      await answer.hover();
      await panel.getByRole("button", { name: "Answer actions" }).first().click();
    };
    await openAnswerMenu();
    const menu = page.getByRole("menu");
    await expect(menu.getByText("Copy answer")).toBeVisible();
    await expect(menu.getByText("Copy as plain text")).toBeVisible();
    await menu.getByText("Save as new note").click();

    await expect(page.getByText(`Saved to “${title}”`)).toBeVisible({ timeout: 15000 });
    const saved = await prisma.page.findFirst({
      where: { workspaceId: workspace!.id, title },
      select: { id: true },
    });
    expect(saved).not.toBeNull();

    // Reload so the menu reflects the persisted state (no local-only optimism).
    await page.reload();
    await expect(panel.locator("div.notion-markdown").first()).toBeVisible();
    await openAnswerMenu();
    await expect(page.getByRole("menu").getByText(/Open [“"]/)).toBeVisible();

    // …and the link is persisted, so the same answer is never saved twice.
    const savedMessage = await prisma.chatMessage.findFirst({
      where: { threadId: thread.id, role: "assistant" },
      select: { meta: true },
    });
    expect((savedMessage?.meta as { savedPageId?: string } | null)?.savedPageId).toBe(saved!.id);

    await prisma.page.deleteMany({ where: { id: saved!.id } });
    await prisma.chatThread.delete({ where: { id: thread.id } });
  });

  test("trash lists deleted pages and restores them", async ({ page }) => {
    await signIn(page);
    const workspace = await prisma.workspace.findFirst({ select: { id: true, slug: true } });
    const user = await prisma.user.findUnique({
      where: { email: "demo@noema.local" },
      select: { id: true },
    });
    const title = `trashed page ${Date.now()}`;
    const page_ = await prisma.page.create({
      data: {
        workspaceId: workspace!.id,
        title,
        createdById: user!.id,
        deletedAt: new Date(),
        isArchived: true,
      },
      select: { id: true },
    });

    await page.goto(`/w/${workspace!.slug}/trash`);
    await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible();
    const row = page.getByRole("listitem").filter({ hasText: title }).first();
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByText("Page restored")).toBeVisible({ timeout: 15000 });

    const restored = await prisma.page.findUnique({
      where: { id: page_.id },
      select: { deletedAt: true },
    });
    expect(restored?.deletedAt).toBeNull();

    await prisma.page.deleteMany({ where: { id: page_.id } });
  });

  test("inbox marks a single notification read", async ({ page }) => {
    await signIn(page);
    const workspace = await prisma.workspace.findFirst({ select: { id: true, slug: true } });
    const user = await prisma.user.findUnique({
      where: { email: "demo@noema.local" },
      select: { id: true },
    });
    const notification = await prisma.notification.create({
      data: {
        userId: user!.id,
        type: "page.mention",
        payload: {},
        read: false,
      },
      select: { id: true },
    });

    await page.goto(`/w/${workspace!.slug}/inbox`);
    const row = page.locator("#main").getByRole("listitem").first();
    await expect(row).toContainText("mentioned");
    await row.getByRole("button", { name: "Mark read" }).click();
    await expect
      .poll(async () => {
        const after = await prisma.notification.findUnique({
          where: { id: notification.id },
          select: { read: true },
        });
        return after?.read;
      }, { timeout: 15000 })
      .toBe(true);

    await prisma.notification.delete({ where: { id: notification.id } });
  });

  test("switching language translates the chrome and the chat panel", async ({ page }) => {
    const workspace = await prisma.workspace.findFirst({ select: { id: true, slug: true } });
    const user = await prisma.user.findUnique({
      where: { email: "demo@noema.local" },
      select: { id: true },
    });
    // A crashed earlier run can leave the shared demo account in French.
    await prisma.user.update({
      where: { id: user!.id },
      data: { locale: "en" },
    });
    await signIn(page);
    const thread = await prisma.chatThread.create({
      data: { workspaceId: workspace!.id, createdById: user!.id, title: "i18n check" },
    });

    await page.goto(`/w/${workspace!.slug}?chat=${thread.id}`);
    await expect(page.getByLabel("AI conversation")).toBeVisible();

    await page.getByLabel("Language").selectOption("fr");
    // The locale is persisted by a server action; wait for the row before
    // reloading, otherwise the refresh can race the write and stay English.
    await expect
      .poll(async () => {
        const refreshed = await prisma.user.findUnique({
          where: { id: user!.id },
          select: { locale: true },
        });
        return refreshed?.locale ?? "en";
      })
      .toBe("fr");
    await page.reload();
    // The docked panel is translated, not just the sidebar.
    await expect(page.getByLabel("Conversation IA")).toBeVisible();
    await expect(
      page.getByPlaceholder("Interrogez vos pages, projets, membres ou tâches…"),
    ).toBeVisible();

    // Leave the demo (and the other tests) in English.
    await page.getByLabel("Langue").selectOption("en");
    await expect
      .poll(async () => {
        const refreshed = await prisma.user.findUnique({
          where: { id: user!.id },
          select: { locale: true },
        });
        return refreshed?.locale ?? "en";
      })
      .toBe("en");

    await prisma.chatThread.delete({ where: { id: thread.id } });
  });
});
/**
 * Workspace lifecycle: create, switch, roles, removal, leaving, transfer.
 * Each test cleans up so the switcher stays deterministic for the others.
 */
test.describe("workspaces", () => {
  const guestEmail = `e2e-guest-${Date.now()}@noema.local`;
  const guestPassword = "password123";
  let guestId = "";

  test.beforeAll(async () => {
    const bcrypt = (await import("bcryptjs")).default;
    const guest = await prisma.user.create({
      data: {
        email: guestEmail,
        name: "E2E Guest",
        passwordHash: await bcrypt.hash(guestPassword, 10),
      },
      select: { id: true },
    });
    guestId = guest.id;
  });

  test.afterAll(async () => {
    if (guestId) await prisma.user.deleteMany({ where: { id: guestId } });
    await prisma.workspace.deleteMany({ where: { slug: { startsWith: "e2e-workspace" } } });
    await prisma.$disconnect();
  });

  const workspace = async () => prisma.workspace.findFirst({ where: { slug: "demo-workspace" } });

  test("creates a workspace from the switcher and switches back", async ({ page }) => {
    await signIn(page);
    const current = await workspace();
    const name = `E2E workspace ${Date.now()}`;

    // Open the switcher (the button shows the current workspace name), then create.
    await page.getByRole("button", { name: new RegExp(current!.name) }).click();
    await page.getByRole("menuitem", { name: /New workspace/ }).click();
    const createDialog = page.getByRole("dialog");
    await createDialog.getByLabel("Name").fill(name);
    await createDialog.getByRole("button", { name: "Use 🧠" }).click();
    await page.getByRole("button", { name: "Create workspace" }).click();

    await page.waitForURL(/\/w\/e2e-workspace/);
    const created = await prisma.workspace.findFirst({
      where: { name },
      select: { id: true, slug: true, icon: true },
    });
    expect(created).not.toBeNull();
    expect(created!.icon).toBe("🧠");
    // A starter page was created and contains the welcome document.
    const welcome = await prisma.page.findFirst({
      where: { workspaceId: created!.id },
      select: { title: true },
    });
    expect(welcome?.title).toBe("Getting started");
    // The switcher now names the new workspace.
    await expect(page.getByRole("button", { name: new RegExp(name) })).toBeVisible();

    // Switch back to the demo workspace.
    await page.getByRole("button", { name: new RegExp(name) }).click();
    await page.getByRole("menuitem", { name: current!.name }).click();
    await page.waitForURL(new RegExp(`/w/${current!.slug}`));
    await expect(page.getByRole("button", { name: new RegExp(current!.name) })).toBeVisible();

    await prisma.workspace.deleteMany({ where: { id: created!.id } });
  });

  test("renames a workspace and changes its icon from settings", async ({ page }) => {
    await signIn(page);
    const current = await workspace();
    await page.goto(`/w/${current!.slug}/settings`);

    await page.getByRole("button", { name: "Rename / icon" }).click();
    const editDialog = page.getByRole("dialog");
    await editDialog.getByLabel("Name").fill("Demo Workspace");
    // Type the emoji rather than toggling a preset, so the test is order-independent.
    await editDialog.getByLabel("Custom emoji").fill("🚀");
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect
      .poll(async () => {
        const after = await prisma.workspace.findUnique({
          where: { id: current!.id },
          select: { icon: true, name: true },
        });
        return `${after?.icon}|${after?.name}`;
      }, { timeout: 15000 })
      .toBe("🚀|Demo Workspace");
  });

  test("changes a member's role, removes them, and protects the owner", async ({ page }) => {
    const current = await workspace();
    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: current!.id, userId: guestId } },
      update: { role: "MEMBER" },
      create: { workspaceId: current!.id, userId: guestId, role: "MEMBER" },
    });

    await signIn(page);
    await page.goto(`/w/${current!.slug}/settings`);
    await expect(
      page.getByRole("listitem").filter({ hasText: "E2E Guest" }).first(),
    ).toBeVisible();

    // The owner cannot leave their own workspace: the control is not offered.
    await expect(page.getByText("Leave this workspace")).toHaveCount(0);

    // Promote to admin. The role picker is the shared combobox, not a native
    // <select>, so open it and choose the option.
    await page.getByLabel("Role for E2E Guest").click();
    await page
      .getByTestId("select-menu")
      .getByRole("option", { name: "Admin", exact: true })
      .click();
    await expect
      .poll(async () => {
        const member = await prisma.workspaceMember.findFirst({
          where: { workspaceId: current!.id, userId: guestId },
          select: { role: true },
        });
        return member?.role;
      }, { timeout: 15000 })
      .toBe("ADMIN");

    // Remove them (inline confirm), which clears their page permissions too.
    await page.getByLabel("Remove E2E Guest").click();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await expect
      .poll(async () => {
        const member = await prisma.workspaceMember.findFirst({
          where: { workspaceId: current!.id, userId: guestId },
          select: { id: true },
        });
        return member === null;
      }, { timeout: 15000 })
      .toBe(true);
  });

  test("transfers ownership and back", async ({ page }) => {
    const current = await workspace();
    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: current!.id, userId: guestId } },
      update: { role: "MEMBER" },
      create: { workspaceId: current!.id, userId: guestId, role: "MEMBER" },
    });

    await signIn(page);
    await page.goto(`/w/${current!.slug}/settings`);
    await page.getByRole("button", { name: "Make E2E Guest the owner" }).click();
    // Transfer is a re-authenticated action: the confirmation asks for the
    // current owner's password before it will move ownership.
    await page.getByPlaceholder("Password").fill("password123");
    await page.getByRole("button", { name: "Transfer ownership" }).click();

    await expect
      .poll(async () => {
        const after = await prisma.workspace.findUnique({
          where: { id: current!.id },
          select: { ownerId: true },
        });
        return after?.ownerId;
      }, { timeout: 15000 })
      .toBe(guestId);

    const previousOwner = await prisma.workspaceMember.findFirst({
      where: { workspaceId: current!.id, userId: current!.ownerId },
      select: { role: true },
    });
    expect(previousOwner?.role).toBe("ADMIN");

    // Restore the demo owner directly (the UI correctly stops offering a second
    // transfer to a non-owner, which is what we want to leave behind).
    await prisma.workspace.update({ where: { id: current!.id }, data: { ownerId: current!.ownerId } });
    await prisma.workspaceMember.updateMany({
      where: { workspaceId: current!.id, userId: current!.ownerId },
      data: { role: "OWNER" },
    });
    await prisma.workspaceMember.updateMany({
      where: { workspaceId: current!.id, userId: guestId },
      data: { role: "GUEST" },
    });
  });

  test("a member can leave a workspace they were invited to", async ({ page }) => {
    const current = await workspace();
    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: current!.id, userId: guestId } },
      update: { role: "MEMBER" },
      create: { workspaceId: current!.id, userId: guestId, role: "MEMBER" },
    });

    await page.goto("/login");
    await page.getByLabel("Email").fill(guestEmail);
    await page.getByRole("textbox", { name: "Password" }).fill(guestPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/w\//);

    await page.goto(`/w/${current!.slug}/settings`);
    await page.getByRole("button", { name: "Leave this workspace", exact: true }).click();
    await page.getByRole("button", { name: "Leave workspace" }).click();

    await expect
      .poll(async () => {
        const member = await prisma.workspaceMember.findFirst({
          where: { workspaceId: current!.id, userId: guestId },
          select: { id: true },
        });
        return member === null;
      }, { timeout: 15000 })
      .toBe(true);
  });
});
/**
 * Collaboration depth: reactions, comment mentions and the workspace activity
 * trail (the three things the audit listed as missing or unproven).
 */
test.describe("collaboration", () => {
  const mentionedEmail = `e2e-mentioned-${Date.now()}@noema.local`;
  let mentionedId = "";

  test.beforeAll(async () => {
    const bcrypt = (await import("bcryptjs")).default;
    const mentioned = await prisma.user.create({
      data: {
        email: mentionedEmail,
        name: "E2E Mentioned",
        passwordHash: await bcrypt.hash("password123", 10),
      },
      select: { id: true },
    });
    mentionedId = mentioned.id;
  });

  test.afterAll(async () => {
    if (mentionedId) await prisma.user.deleteMany({ where: { id: mentionedId } });
    await prisma.$disconnect();
  });

  test("reacts to a comment and takes the reaction back", async ({ page }) => {
    await signIn(page);
    const workspace = await prisma.workspace.findFirst({ where: { slug: "demo-workspace" } });
    const user = await prisma.user.findUnique({
      where: { email: "demo@noema.local" },
      select: { id: true },
    });
    const target = await prisma.page.findFirst({
      where: { workspaceId: workspace!.id, type: "PAGE", deletedAt: null },
      select: { id: true },
    });
    const body = `reaction target ${Date.now()}`;
    const comment = await prisma.comment.create({
      data: { pageId: target!.id, authorId: user!.id, body },
      select: { id: true },
    });

    await page.goto(`/w/${workspace!.slug}/${target!.id}`);
    const row = page.getByRole("listitem").filter({ hasText: body }).first();
    await expect(row).toBeVisible();

    await row.getByLabel("Add a reaction").click();
    // The shared emoji picker floats in a portal outside the row.
    await page.getByLabel("React 👍").click();
    await expect(row.getByLabel("👍 (1)")).toBeVisible();

    await expect
      .poll(async () => {
        return prisma.commentReaction.count({ where: { commentId: comment.id, emoji: "👍" } });
      }, { timeout: 15000 })
      .toBe(1);

    // Clicking your own chip removes it again.
    await row.getByLabel("👍 (1)").click();
    await expect
      .poll(async () => {
        return prisma.commentReaction.count({ where: { commentId: comment.id } });
      }, { timeout: 15000 })
      .toBe(0);

    await prisma.comment.delete({ where: { id: comment.id } });
  });

  test("mentioning a member notifies them", async ({ page }) => {
    await prisma.workspaceMember.upsert({
      where: {
        workspaceId_userId: {
          workspaceId: (await prisma.workspace.findFirst({ where: { slug: "demo-workspace" } }))!.id,
          userId: mentionedId,
        },
      },
      update: {},
      create: {
        workspaceId: (await prisma.workspace.findFirst({ where: { slug: "demo-workspace" } }))!.id,
        userId: mentionedId,
        role: "MEMBER",
      },
    });

    await signIn(page);
    const workspace = await prisma.workspace.findFirst({ where: { slug: "demo-workspace" } });
    const target = await prisma.page.findFirst({
      where: { workspaceId: workspace!.id, type: "PAGE", deletedAt: null },
      select: { id: true },
    });

    await page.goto(`/w/${workspace!.slug}/${target!.id}`);
    const marker = `ping ${Date.now()}`;
    await page.getByLabel("Add a comment").fill(`@E2E Mentioned ${marker}`);
    await page.getByLabel("Post comment").click();

    await expect(page.getByText(marker)).toBeVisible();
    await expect
      .poll(async () => {
        const notification = await prisma.notification.findFirst({
          where: { userId: mentionedId, type: "page.mention" },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });
        return notification !== null;
      }, { timeout: 15000 })
      .toBe(true);

    await prisma.notification.deleteMany({ where: { userId: mentionedId } });
    await prisma.comment.deleteMany({ where: { body: { contains: marker } } });
  });

  test("records workspace changes in the activity trail", async ({ page }) => {
    await signIn(page);
    const workspace = await prisma.workspace.findFirst({ where: { slug: "demo-workspace" } });
    await prisma.activity.deleteMany({ where: { workspaceId: workspace!.id } });

    await page.goto(`/w/${workspace!.slug}/settings`);
    await page.getByRole("button", { name: "Rename / icon" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Custom emoji").fill("🚀");
    await dialog.getByRole("button", { name: "Save changes" }).click();

    await expect
      .poll(async () => {
        return prisma.activity.count({
          where: { workspaceId: workspace!.id, action: "workspace.updated" },
        });
      }, { timeout: 15000 })
      .toBe(1);

    // …and the trail is visible in Settings.
    await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
    await expect(page.getByText("updated the workspace settings")).toBeVisible();
  });

  test("saves the tracker filters as a view and applies them again", async ({ page }) => {
    await signIn(page);
    const workspace = await prisma.workspace.findFirst({ where: { slug: "demo-workspace" } });
    const name = `E2E view ${Date.now()}`;

    await page.goto(`/w/${workspace!.slug}/tickets`);
    const priority = page.locator("#main").getByLabel("Filter by priority").last();
    const priorityRoot = priority.locator("..");
    await priority.click();
    await page
      .getByTestId("select-menu")
      .getByRole("option", { name: "Urgent", exact: true })
      .click();
    await page.getByRole("button", { name: "Saved views" }).click();
    await page.getByRole("menuitem", { name: /Save current filters/ }).click();
    await page.getByRole("dialog").getByLabel("View name").fill(name);
    await page.getByRole("button", { name: "Save view" }).click();

    await expect
      .poll(async () => {
        return prisma.ticketView.count({ where: { workspaceId: workspace!.id, name } });
      }, { timeout: 15000 })
      .toBe(1);

    // Clear the filter, then re-apply the saved view.
    await priorityRoot.getByTestId("select-clear").click();
    await expect(priorityRoot.getByTestId("select-clear")).toHaveCount(0);
    await page.getByRole("button", { name: "Saved views" }).click();
    await page.getByRole("menuitem", { name }).click();
    await expect(priority).toContainText("Urgent");

    // Delete it from the same menu (and prove the deletion through the database).
    await page.getByRole("button", { name: "Saved views" }).click();
    await page.getByRole("button", { name: `Delete ${name}` }).click();
    await expect
      .poll(async () => prisma.ticketView.count({ where: { workspaceId: workspace!.id, name } }), {
        timeout: 15000,
      })
      .toBe(0);
  });

  test("edits a comment in place", async ({ page }) => {
    await signIn(page);
    const workspace = await prisma.workspace.findFirst({ where: { slug: "demo-workspace" } });
    const user = await prisma.user.findUnique({
      where: { email: "demo@noema.local" },
      select: { id: true },
    });
    const target = await prisma.page.findFirst({
      where: { workspaceId: workspace!.id, type: "PAGE", deletedAt: null },
      select: { id: true },
    });
    const original = `typo target ${Date.now()}`;
    const comment = await prisma.comment.create({
      data: { pageId: target!.id, authorId: user!.id, body: original },
      select: { id: true },
    });

    await page.goto(`/w/${workspace!.slug}/${target!.id}`);
    const row = page.getByRole("listitem").filter({ hasText: original }).first();
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const fixed = `fixed body ${Date.now()}`;
    await row.getByLabel("Edit comment").fill(fixed);
    await row.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText(fixed)).toBeVisible({ timeout: 15000 });
    await expect
      .poll(async () => {
        const after = await prisma.comment.findUnique({
          where: { id: comment.id },
          select: { body: true },
        });
        return after?.body;
      }, { timeout: 15000 })
      .toBe(fixed);

    await prisma.comment.delete({ where: { id: comment.id } });
  });
});
/** Sprints: create a cycle, schedule a ticket into it, see the commitment. */
test.describe("cycles", () => {
  test("plans a cycle, schedules a ticket and reports progress", async ({ page }) => {
    await signIn(page);
    const workspace = await prisma.workspace.findFirst({ where: { slug: "demo-workspace" } });
    const user = await prisma.user.findUnique({
      where: { email: "demo@noema.local" },
      select: { id: true },
    });
    const name = `E2E cycle ${Date.now()}`;
    const stamp = Date.now();
    // Clear leftovers from earlier runs so the click can never hit the wrong row.
    await prisma.ticket.deleteMany({ where: { workspaceId: workspace!.id, title: { startsWith: "cycle target" } } });
    const ticket = await prisma.ticket.create({
      data: {
        workspaceId: workspace!.id,
        number: 90000 + Math.floor(Math.random() * 1000),
        key: `E2E-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        title: `cycle target ${stamp}`,
        status: "todo",
        priority: "medium",
        estimate: 5,
        estimateUnit: "points",
        reporterId: user!.id,
      },
      select: { id: true, key: true },
    });

    await page.goto(`/w/${workspace!.slug}/cycles`);
    await expect(page.getByRole("heading", { name: "Cycles", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "New cycle" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill(name);
    await dialog.getByLabel("Starts").fill("2026-04-01");
    await dialog.getByLabel("Ends").fill("2026-04-14");
    await dialog.getByLabel("Goal").fill("Ship the cycle view");
    await dialog.getByRole("button", { name: "Create cycle" }).click();

    await expect
      .poll(
        async () => prisma.cycle.count({ where: { name } }),
        { timeout: 15_000 },
      )
      .toBe(1);
    const created = await prisma.cycle.findFirst({ where: { name }, select: { id: true } });
    expect(created).not.toBeNull();
    await expect(page.getByRole("heading", { name })).toBeVisible({ timeout: 15000 });

    // Schedule the ticket into it from the ticket drawer.
    await page.goto(`/w/${workspace!.slug}/tickets`);
    await page.getByText(`cycle target ${stamp}`).first().click();
    await page.getByLabel("Ticket cycle").click();
    await page
      .getByTestId("select-menu")
      .getByRole("option")
      .filter({ hasText: name })
      .click();
    await expect
      .poll(async () => {
        const updated = await prisma.ticket.findUnique({
          where: { id: ticket.id },
          select: { cycleId: true },
        });
        return updated?.cycleId;
      }, { timeout: 15000 })
      .toBe(created!.id);

    // The cycle now reports the committed estimate.
    await page.goto(`/w/${workspace!.slug}/cycles`);
    const card = page.getByRole("listitem").filter({ hasText: name }).first();
    await expect(card).toContainText("5 points");
    await expect(card.getByRole("progressbar")).toBeVisible();

    await prisma.ticket.update({ where: { id: ticket.id }, data: { cycleId: null } });
    await prisma.cycle.delete({ where: { id: created!.id } });
    await prisma.ticket.delete({ where: { id: ticket.id } });
  });
});
/** Keyset pagination: the list loads one page and can fetch the next. */
test.describe("pagination", () => {
  test("paging through a large tracker never repeats or drops a ticket", async ({ page }) => {
    await signIn(page);
    const workspace = await prisma.workspace.findFirst({ where: { slug: "demo-workspace" } });
    const user = await prisma.user.findUnique({
      where: { email: "demo@noema.local" },
      select: { id: true },
    });
    const stamp = Date.now();
    // 120 tickets so the first page (100) leaves a second one behind.
    await prisma.ticket.createMany({
      data: Array.from({ length: 120 }, (_, index) => ({
        workspaceId: workspace!.id,
        number: 100000 + index,
        key: `PAGE-${stamp}-${index}`,
        title: `paged ticket ${stamp}-${index}`,
        status: "backlog",
        priority: "low",
        reporterId: user!.id,
        position: index,
      })),
    });

    await page.goto(`/w/${workspace!.slug}/tickets`);
    await page.getByRole("radio", { name: "List" }).click();
    const loadMore = page.getByRole("button", { name: /Load more|Charger plus/ });
    await expect(loadMore).toBeVisible();

    // Only one page is rendered before loading more.
    await expect(page.getByText(`paged ticket ${stamp}-104`)).toHaveCount(0);
    await loadMore.click();
    await expect(page.getByText(`paged ticket ${stamp}-104`)).toBeVisible();
    // The button disappears once every page is loaded (no cursor left).
    await expect(page.getByRole("button", { name: /Load more|Charger plus/ })).toHaveCount(0, {
      timeout: 15000,
    });

    await prisma.ticket.deleteMany({ where: { workspaceId: workspace!.id, key: { startsWith: `PAGE-${stamp}` } } });
  });
});
/**
 * Guests are external collaborators: they only see what was shared with them —
 * in the sidebar, in search, and at the route level.
 */
test.describe("guest scoping", () => {
  const guestEmail = `e2e-guest-scope-${Date.now()}@noema.local`;
  const guestPassword = "password123";
  let guestId = "";
  let sharedId = "";
  let privateId = "";
  let stamp = 0;

  test.beforeAll(async () => {
    const bcrypt = (await import("bcryptjs")).default;
    const guest = await prisma.user.create({
      data: { email: guestEmail, name: "Scoped Guest", passwordHash: await bcrypt.hash(guestPassword, 10) },
      select: { id: true },
    });
    guestId = guest.id;
  });

  test.afterAll(async () => {
    await prisma.page.deleteMany({ where: { id: { in: [sharedId, privateId].filter(Boolean) } } });
    if (guestId) await prisma.user.deleteMany({ where: { id: guestId } });
    await prisma.$disconnect();
  });

  test("a guest only sees the pages shared with them", async ({ page }) => {
    const workspace = await prisma.workspace.findFirst({ where: { slug: "demo-workspace" } });
    const owner = await prisma.user.findUnique({
      where: { email: "demo@noema.local" },
      select: { id: true },
    });
    stamp = Date.now();

    // One shared page, one that stays private, both created by the owner.
    const shared = await prisma.page.create({
      data: { workspaceId: workspace!.id, title: `shared page ${stamp}`, createdById: owner!.id },
      select: { id: true },
    });
    const secret = await prisma.page.create({
      data: { workspaceId: workspace!.id, title: `private page ${stamp}`, createdById: owner!.id },
      select: { id: true },
    });
    sharedId = shared.id;
    privateId = secret.id;

    await prisma.workspaceMember.create({
      data: { workspaceId: workspace!.id, userId: guestId, role: "GUEST" },
    });
    await prisma.pagePermission.create({
      data: { pageId: shared.id, userId: guestId, level: "READ" },
    });

    // Sign in as the guest.
    await page.goto("/login");
    await page.getByLabel("Email").fill(guestEmail);
    await page.getByRole("textbox", { name: "Password" }).fill(guestPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/w\//);

    // The sidebar lists the shared page and not the private one.
    const sidebar = page.getByRole("complementary");
    await expect(sidebar.getByText(`shared page ${stamp}`)).toBeVisible();
    await expect(sidebar.getByText(`private page ${stamp}`)).toHaveCount(0);

    // The shared page opens…
    await page.goto(`/w/${workspace!.slug}/${shared.id}`);
    await expect(page.getByText(`shared page ${stamp}`).first()).toBeVisible();

    // …and the private one renders the not-found surface, not its content.
    // Next can stream the not-found boundary with HTTP 200, so assert the
    // user-visible result and the absence of the private title.
    await page.goto(`/w/${workspace!.slug}/${secret.id}`);
    await expect(page.getByText("This page does not exist")).toBeVisible();
    await expect(page.getByText(`private page ${stamp}`)).toHaveCount(0);

    // Search never surfaces it either (assert on the results, not the echoed query).
    await page.goto(`/w/${workspace!.slug}/search?q=${encodeURIComponent(`private page ${stamp}`)}`);
    await expect(page.locator(`a[href*="${secret.id}"]`)).toHaveCount(0);
    await page.goto(`/w/${workspace!.slug}/search?q=${encodeURIComponent(`shared page ${stamp}`)}`);
    await expect(page.locator(`a[href*="${shared.id}"]`).first()).toBeVisible();
  });

  test("pages through a large result set", async ({ page }) => {
    await signIn(page);
    const workspace = await prisma.workspace.findFirst({ where: { slug: "demo-workspace" } });
    const user = await prisma.user.findUnique({
      where: { email: "demo@noema.local" },
      select: { id: true },
    });
    const stamp = Date.now();
    const marker = `paginated${stamp}`;
    // 60 matching pages so the first window (50) leaves a second one.
    await prisma.page.createMany({
      data: Array.from({ length: 60 }, (_, index) => ({
        workspaceId: workspace!.id,
        title: `${marker} note ${index}`,
        createdById: user!.id,
        searchText: `${marker} note ${index} body`,
      })),
    });

    await page.goto(`/w/${workspace!.slug}/search?q=${marker}`);
    const loadMore = page.getByRole("button", { name: /Load more|Charger plus/ });
    await expect(loadMore).toBeVisible();
    // The second window is not rendered yet.
    // Scope to the results column: the sidebar lists every page title too.
    const results = page.locator("#main");
    await expect(results.getByText(`${marker} note 59`)).toHaveCount(0);

    await loadMore.click();
    // The list virtualises past 40 rows, so row 59 is mounted only after the
    // scroller reaches the bottom. Wait for the cursor to drain first, then
    // scroll the windowed results to the tail.
    await expect(page.getByRole("button", { name: /Load more|Charger plus/ })).toHaveCount(0, {
      timeout: 15_000,
    });
    const scroller = page.getByRole("region", { name: "Search results" });
    await expect
      .poll(
        async () => {
          if ((await results.getByText(`${marker} note 59`).count()) > 0) return true;
          await scroller.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
            element.dispatchEvent(new Event("scroll", { bubbles: true }));
          });
          return false;
        },
        { timeout: 30_000, intervals: [500] },
      )
      .toBe(true);
    await expect(results.getByText(`${marker} note 59`).first()).toBeVisible({
      timeout: 15_000,
    });

    await prisma.page.deleteMany({ where: { title: { startsWith: marker } } });
  });
test("slash menu adds heading 4", async ({ page }) => {
    // Use a fresh page: the shared first page accumulates one h4 and one
    // captioned image per previous run, which makes the strict locators below
    // ambiguous after a failure.
    const workspace = await prisma.workspace.findFirst({
      where: { slug: "demo-workspace" },
      select: { id: true, slug: true },
    });
    const owner = await prisma.user.findUnique({
      where: { email: "demo@noema.local" },
      select: { id: true },
    });
    const probe = await prisma.page.create({
      data: {
        workspaceId: workspace!.id,
        title: `E2E slash ${Date.now()}`,
        createdById: owner!.id,
        content: { type: "doc", content: [{ type: "paragraph" }] },
      },
      select: { id: true },
    });

    await signIn(page);
    await page.goto(`/w/${workspace!.slug}/${probe.id}`);

    const editor = page.locator(".ProseMirror").first();
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");

    // Heading 4 could be parsed but not created; it is a slash item now.
    await page.keyboard.type("/heading 4");
    await expect(
      page.getByRole("option", { name: /Heading 4/ }),
    ).toBeVisible();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Deep heading");
    await expect(editor.locator("h4")).toContainText("Deep heading");

    await prisma.page.delete({ where: { id: probe.id } }).catch(() => {});
  });


  test("toggle block keeps its collapsed state across a reload", async ({ page }) => {
    await signIn(page);
    const workspace = await prisma.workspace.findFirst({ where: { slug: "demo-workspace" } });
    const owner = await prisma.user.findUnique({
      where: { email: "demo@noema.local" },
      select: { id: true },
    });
    // A dedicated page: the shared first page accumulates state from the
    // other tests, which poisons structural assertions.
    const created = await prisma.page.create({
      data: {
        workspaceId: workspace!.id,
        title: `toggle persist ${Date.now()}`,
        createdById: owner!.id,
        content: { type: "doc", content: [{ type: "paragraph" }] },
      },
      select: { id: true },
    });

    try {
      await page.goto(`/w/demo-workspace/${created.id}`);
      const editor = page.locator(".ProseMirror").first();
      await editor.click();
      await page.keyboard.type("/toggle");
      await expect(page.getByRole("option", { name: "Toggle" })).toBeVisible();
      await page.keyboard.press("Enter");

      const toggle = editor.locator(".noema-toggle");
      await expect(toggle).toBeVisible();
      // Open by default: the header button collapses it...
      await toggle.getByRole("button", { name: "Collapse" }).click();
      await expect(toggle.getByRole("button", { name: "Expand" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });

      // ...and the open flag is document state, so it survives a reload.
      await page.reload();
      const after = page.locator(".ProseMirror .noema-toggle");
      await expect(after.getByRole("button", { name: "Expand" })).toHaveAttribute(
        "aria-expanded",
        "false",
        { timeout: 15_000 },
      );
    } finally {
      await prisma.page.delete({ where: { id: created.id } }).catch(() => {});
    }
  });

  test("code block language selector persists language and code across a reload", async ({
    page,
  }) => {
    await signIn(page);
    const workspace = await prisma.workspace.findFirst({ where: { slug: "demo-workspace" } });
    const owner = await prisma.user.findUnique({
      where: { email: "demo@noema.local" },
      select: { id: true },
    });
    // A dedicated page: the shared first page accumulates state from the
    // other tests, which poisons structural assertions.
    const created = await prisma.page.create({
      data: {
        workspaceId: workspace!.id,
        title: `code language persist ${Date.now()}`,
        createdById: owner!.id,
        content: { type: "doc", content: [{ type: "paragraph" }] },
      },
      select: { id: true },
    });

    try {
      await page.goto(`/w/demo-workspace/${created.id}`);
      const editor = page.locator(".ProseMirror").first();
      await editor.click();
      await page.keyboard.type("/code");
      await expect(page.getByRole("option", { name: "Code" })).toBeVisible();
      await page.keyboard.press("Enter");

      const block = editor.locator("[data-code-block]");
      await expect(block).toBeVisible();
      await block.locator("pre").click();
      await page.keyboard.type("print('hello noema')");

      // Pick a language from the Notion-style selector in the block corner.
      const trigger = block.getByLabel("Languages");
      await expect(trigger).toBeVisible();
      await trigger.click();
      const menu = page.getByTestId("select-menu").last();
      await expect(menu).toBeVisible();
      await menu.getByPlaceholder(/Filter languages/).fill("python");
      await menu.getByRole("option", { name: "Python", exact: true }).click();
      await expect(block.getByLabel("Languages")).toContainText("Python");

      await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });

      // Language and code are document state, so both survive a reload.
      await page.reload();
      const after = page.locator(".ProseMirror [data-code-block]");
      await expect(after.locator("pre code.language-python")).toHaveText(
        "print('hello noema')",
        { timeout: 15_000 },
      );
      await expect(after.getByLabel("Languages")).toContainText("Python");
      await expect(after.locator("[data-code-language-menu]")).toHaveCount(0);
    } finally {
      await prisma.page.delete({ where: { id: created.id } }).catch(() => {});
    }
  });

  test("right-click colour menu paints a block background that survives a reload", async ({
    page,
  }) => {
    await signIn(page);
    const workspace = await prisma.workspace.findFirst({ where: { slug: "demo-workspace" } });
    const owner = await prisma.user.findUnique({
      where: { email: "demo@noema.local" },
      select: { id: true },
    });
    const marker = `painted-${Date.now()}`;
    const created = await prisma.page.create({
      data: {
        workspaceId: workspace!.id,
        title: `paint persist ${Date.now()}`,
        createdById: owner!.id,
        content: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: marker }] }],
        },
      },
      select: { id: true },
    });

    try {
      await page.goto(`/w/demo-workspace/${created.id}`);
      const editor = page.locator(".ProseMirror").first();
      const paragraph = editor.locator("p", { hasText: marker });
      await paragraph.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Color" }).hover();
      await page.getByRole("menuitem", { name: "Gray background" }).click();

      await expect(paragraph).toHaveAttribute("data-block-color", "gray");
      await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });

      // The tint is an attribute on the block in the stored document.
      await page.reload();
      const after = page.locator(".ProseMirror").locator("p", { hasText: marker });
      await expect(after).toHaveAttribute("data-block-color", "gray", { timeout: 15_000 });
    } finally {
      await prisma.page.delete({ where: { id: created.id } }).catch(() => {});
    }
  });
});

test.describe("editor drag & clipboard", () => {
  // Negative control: `E2E_FEATURE_OFF=1` neutralises the feature under test at
  // runtime (the editor exposes its instance only to automation sessions), so
  // each test proves it can fail when the custom handler is absent.
  const featureOff = process.env.E2E_FEATURE_OFF === "1";

  async function markE2E(page: Page) {
    await page.addInitScript(() => {
      (window as unknown as { __NOEMA_E2E?: boolean }).__NOEMA_E2E = true;
    });
  }

  async function createEditorPage(content: Prisma.InputJsonValue, title: string) {
    const workspace = await prisma.workspace.findFirst({ where: { slug: "demo-workspace" } });
    const owner = await prisma.user.findUnique({
      where: { email: "demo@noema.local" },
      select: { id: true },
    });
    return prisma.page.create({
      data: { workspaceId: workspace!.id, title, createdById: owner!.id, content },
      select: { id: true },
    });
  }

  test("drag handle nests and unnests a bullet item with a horizontal drag", async ({ page }) => {
    await markE2E(page);
    await signIn(page);
    const stamp = Date.now();
    const created = await createEditorPage(
      {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "drag alpha" }] }],
              },
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "drag beta" }] }],
              },
            ],
          },
        ],
      },
      `drag indent ${stamp}`,
    );

    try {
      await page.goto(`/w/demo-workspace/${created.id}`);
      const main = page.locator("#main");
      const editor = main.locator(".ProseMirror").first();
      await expect(editor.locator("> ul > li")).toHaveCount(2);

      if (featureOff) {
        // Stock ProseMirror only reorders; without our handleDrop planner the
        // horizontal drag can never nest or unnest.
        await page.evaluate(() => {
          const w = window as unknown as {
            __noemaEditor?: { setOptions: (options: unknown) => void };
          };
          w.__noemaEditor?.setOptions({ editorProps: { handleDrop: () => false } });
        });
        const applied = await page.evaluate(() => {
          const w = window as unknown as {
            __noemaEditor?: { view: { props: { handleDrop?: () => boolean } } };
          };
          const prop = w.__noemaEditor?.view.props.handleDrop;
          return typeof prop === "function" && prop() === false;
        });
        expect(applied, "negative control: handleDrop override did not engage").toBe(true);
      }

      // Nest: grab the handle on the second item and drop it ~48px to the
      // right, over the first item's row.
      const handle = main.locator(".noema-drag-handle");
      const beta = editor.locator("> ul > li").nth(1);
      const alpha = editor.locator("> ul > li").nth(0);
      await beta.hover();
      await expect(handle).toBeVisible();
      await page.waitForTimeout(300); // the handle repositions asynchronously
      const grab = (await handle.boundingBox())!;
      expect(grab.x).toBeGreaterThan(0);
      const alphaBox = (await alpha.boundingBox())!;
      await page.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        Math.max(grab.x + grab.width / 2 + 48, alphaBox.x + alphaBox.width * 0.5),
        alphaBox.y + alphaBox.height / 2,
        { steps: 12 },
      );
      await page.mouse.up();

      // beta now lives inside alpha's list item.
      await expect(editor.locator("> ul > li")).toHaveCount(1, { timeout: 10_000 });
      const alphaTop = editor.locator("> ul > li").filter({ hasText: "drag alpha" });
      const nestedBeta = alphaTop.locator("> ul > li").filter({ hasText: "drag beta" });
      await expect(nestedBeta).toHaveCount(1);

      // Unnest: grab the handle on the nested item and drop it ~48px left.
      // Leaving the list first resets the drag-handle plugin's hover target
      // after the previous drag; otherwise its chrome can stay stuck hidden.
      await page.mouse.move(10, 10);
      await page.waitForTimeout(150);
      await nestedBeta.hover();
      await expect(handle).toBeVisible();
      await page.waitForTimeout(300);
      const grab2 = (await handle.boundingBox())!;
      const betaBox = (await nestedBeta.boundingBox())!;
      const editorBox = (await editor.boundingBox())!;
      // Start the drag on the handle's right edge and drop at the editor's
      // left edge: the outdent zone needs dx <= -24, and the handle floats
      // close to the editor's left border.
      const startX2 = grab2.x + grab2.width - 1;
      const targetX2 = editorBox.x + 2;
      await page.mouse.move(startX2, grab2.y + grab2.height / 2);
      await page.mouse.down();
      await page.mouse.move(targetX2, betaBox.y + betaBox.height / 2, { steps: 12 });
      await page.mouse.up();

      // Back to two top-level items in the original order.
      await expect(editor.locator("> ul > li")).toHaveCount(2, { timeout: 10_000 });
      await expect(editor.locator("> ul > li").filter({ hasText: "drag alpha" })).toHaveCount(1);
      await expect(editor.locator("> ul > li").filter({ hasText: "drag beta" })).toHaveCount(1);
      await expect(editor.locator("> ul > li > ul > li")).toHaveCount(0);
      await expect(main.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });
    } finally {
      await prisma.page.delete({ where: { id: created.id } }).catch(() => {});
    }
  });

  test("copying in one editor and pasting in another keeps heading, colour and checked todo", async ({
    page,
    context,
  }) => {
    await markE2E(page);
    await signIn(page);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const stamp = Date.now();
    const heading = `Clip heading ${stamp}`;
    const tinted = `Tinted paragraph ${stamp}`;
    const todo = `Checked todo ${stamp}`;
    const source = await createEditorPage(
      {
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: heading }] },
          {
            type: "paragraph",
            attrs: { blockColor: "gray" },
            content: [{ type: "text", text: tinted }],
          },
          {
            type: "taskList",
            content: [
              {
                type: "taskItem",
                attrs: { checked: true },
                content: [{ type: "paragraph", content: [{ type: "text", text: todo }] }],
              },
            ],
          },
        ],
      },
      `clip source ${stamp}`,
    );
    const target = await createEditorPage(
      { type: "doc", content: [{ type: "paragraph" }] },
      `clip target ${stamp}`,
    );
    let other: Page | null = null;

    try {
      // Instance one: copy a selection that starts inside the heading, so the
      // clipboard carries an open-depth (partial) copy.
      await page.goto(`/w/demo-workspace/${source.id}`);
      const srcEditor = page.locator("#main .ProseMirror").first();
      await expect(srcEditor).toBeVisible();
      await expect(srcEditor.locator("h1")).toHaveText(heading);
      await srcEditor.click();
      await page.evaluate(() => {
        const w = window as unknown as {
          __noemaEditor?: {
            state: { doc: { content: { size: number } }; selection: { to: number } };
            commands: {
              selectAll: () => boolean;
              setTextSelection: (range: { from: number; to: number }) => boolean;
            };
          };
        };
        const editor = w.__noemaEditor;
        if (!editor) throw new Error("editor test hook missing");
        editor.commands.selectAll();
        const to = editor.state.selection.to;
        // Start inside the heading: the copy is partial (open depths > 0).
        editor.commands.setTextSelection({ from: 1 + "Clip heading ".length, to });
      });
      await page.keyboard.press("Control+c");

      // Read back what the copy actually put on the clipboard.
      const readClipboard = async (p: Page) => {
        for (let attempt = 0; attempt < 20; attempt++) {
          const html = await p.evaluate(async () => {
            try {
              const items = await navigator.clipboard.read();
              for (const item of items) {
                if (item.types.includes("text/html")) {
                  const blob = await item.getType("text/html");
                  return await blob.text();
                }
              }
            } catch {
              return "";
            }
            return "";
          });
          if (html) return html;
          await p.waitForTimeout(200);
        }
        return "";
      };
      const clipboardHtml = await readClipboard(page);
      expect(clipboardHtml).toContain(String(stamp));
      expect(clipboardHtml).toContain(`data-block-color="gray"`);
      expect(clipboardHtml).toContain(`data-checked="true"`);

      // Instance two: paste into a second dedicated page's editor.
      other = await context.newPage();
      await markE2E(other);
      await other.goto(`/w/demo-workspace/${target.id}`);
      const dstEditor = other.locator("#main .ProseMirror").first();
      await expect(dstEditor).toBeVisible();
      await dstEditor.click();
      // Paste after existing content: the stock path applies the copy's open
      // depths and merges the partial heading into this paragraph; ours must
      // split it and keep every block type.
      await other.keyboard.type(`pre-existing ${stamp} `);
      if (featureOff) {
        await other.evaluate(() => {
          const w = window as unknown as {
            __noemaEditor?: { setOptions: (options: unknown) => void };
          };
          w.__noemaEditor?.setOptions({ editorProps: { handlePaste: () => false } });
        });
        const applied = await other.evaluate(() => {
          const w = window as unknown as {
            __noemaEditor?: { view: { props: { handlePaste?: () => boolean } } };
          };
          const prop = w.__noemaEditor?.view.props.handlePaste;
          return typeof prop === "function" && prop() === false;
        });
        expect(applied, "negative control: handlePaste override did not engage").toBe(true);
      }
      await other.bringToFront();
      await other.keyboard.press("Control+v");

      // All three blocks keep their type, colour and checked state.
      const dstMain = other.locator("#main");
      await expect(dstMain.locator(".ProseMirror h1")).toContainText(String(stamp), { timeout: 15_000 });
      await expect(dstMain.locator(".ProseMirror h1")).toHaveCount(1);
      await expect(
        dstMain.locator('.ProseMirror p[data-block-color="gray"]'),
      ).toContainText(tinted);
      await expect(dstMain.locator('.ProseMirror ul[data-type="taskList"]')).toHaveCount(1);
      await expect(
        dstMain.locator('.ProseMirror li[data-checked="true"]'),
      ).toContainText(todo);
      await expect(dstMain).toContainText(`pre-existing ${stamp}`);
      await expect(dstMain.getByText("Saved", { exact: true })).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      if (other) await other.close().catch(() => {});
      await prisma.page
        .deleteMany({ where: { id: { in: [source.id, target.id] } } })
        .catch(() => {});
    }
  });
});

test.describe("editor delete undo & nested text colour", () => {
  async function markE2E(page: Page) {
    await page.addInitScript(() => {
      (window as unknown as { __NOEMA_E2E?: boolean }).__NOEMA_E2E = true;
    });
  }

  async function createEditorPage(content: Prisma.InputJsonValue, title: string) {
    const workspace = await prisma.workspace.findFirst({ where: { slug: "demo-workspace" } });
    const owner = await prisma.user.findUnique({
      where: { email: "demo@noema.local" },
      select: { id: true },
    });
    return prisma.page.create({
      data: { workspaceId: workspace!.id, title, createdById: owner!.id, content },
      select: { id: true },
    });
  }

  test("right-click delete offers Undo in a toast that restores the block in place", async ({
    page,
  }) => {
    await markE2E(page);
    await signIn(page);
    const stamp = Date.now();
    const alpha = `alpha ${stamp}`;
    const doomed = `doomed ${stamp}`;
    const omega = `omega ${stamp}`;
    const created = await createEditorPage(
      {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: alpha }] },
          { type: "paragraph", content: [{ type: "text", text: doomed }] },
          { type: "paragraph", content: [{ type: "text", text: omega }] },
        ],
      },
      `delete undo ${stamp}`,
    );

    try {
      await page.goto(`/w/demo-workspace/${created.id}`);
      const main = page.locator("#main");
      const editor = main.locator(".ProseMirror").first();
      await expect(editor.locator("> p")).toHaveCount(3);

      await editor.locator("> p", { hasText: doomed }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
      await expect(editor.locator("> p")).toHaveCount(2);

      // The toast carries the Undo affordance (scoped past the history widget's
      // own Undo button, which also answers to the name "Undo").
      const undo = page.locator("[data-sonner-toaster]").getByRole("button", { name: "Undo" });
      await expect(undo).toBeVisible();
      await undo.click();

      // The block returns at its original position with its exact text.
      await expect(editor.locator("> p")).toHaveCount(3, { timeout: 10_000 });
      await expect(editor.locator("> p")).toHaveText([alpha, doomed, omega]);
      await expect(main.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });
    } finally {
      await prisma.page.delete({ where: { id: created.id } }).catch(() => {});
    }
  });

  test("colouring part of a bolded range keeps bold + colour, Default clears only the colour", async ({
    page,
  }) => {
    await markE2E(page);
    await signIn(page);
    const stamp = Date.now();
    const created = await createEditorPage(
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Hello " },
              { type: "text", marks: [{ type: "bold" }], text: "bold world" },
              { type: "text", text: " tail" },
            ],
          },
        ],
      },
      `nested colour ${stamp}`,
    );

    try {
      await page.goto(`/w/demo-workspace/${created.id}`);
      const main = page.locator("#main");
      const editor = main.locator(".ProseMirror").first();
      await expect(editor.locator("strong")).toHaveText("bold world");

      // Select just "world" — a strict sub-range of the bolded text.
      const selectWorld = () =>
        page.evaluate(() => {
        const w = window as unknown as {
          __noemaEditor?: {
            state: {
              doc: {
                descendants: (
                  fn: (
                    node: {
                      isText?: boolean;
                      text?: string;
                      marks?: { type: { name?: string } }[];
                    },
                    pos: number,
                  ) => boolean,
                ) => void;
              };
            };
            commands: {
              setTextSelection: (range: { from: number; to: number }) => boolean;
              focus: () => boolean;
            };
          };
        };
        const editor = w.__noemaEditor;
        if (!editor) throw new Error("editor test hook missing");
        let from = -1;
        let to = -1;
        editor.state.doc.descendants((node, pos) => {
          if (
            from === -1 &&
            node.isText &&
            node.marks?.some((m) => m.type.name === "bold") &&
            node.text?.includes("world")
          ) {
            from = pos + node.text.indexOf("world");
            to = from + "world".length;
          }
          return from === -1;
        });
        if (from === -1) throw new Error("bolded word not found");
        editor.commands.focus();
        editor.commands.setTextSelection({ from, to });
      });

      await selectWorld();
      const bubble = page.locator("[data-bubble-toolbar]");
      await expect(bubble).toBeVisible();
      await bubble.getByRole("button", { name: "Text color" }).click();
      const panel = page
        .locator("[data-radix-popper-content-wrapper]")
        .filter({ has: page.getByRole("button", { name: "Red", exact: true }) })
        .last();
      await expect(panel).toBeVisible();
      await panel.getByRole("button", { name: "Red", exact: true }).click();

      // The span carries the colour AND the bold mark (either nesting order).
      const colored = editor.locator('span[style*="color"]');
      await expect(colored).toHaveCount(1);
      await expect(colored).toHaveText("world");
      const keepsBold = await colored.evaluate(
        (el) => el.closest("strong") !== null || el.querySelector("strong") !== null,
      );
      expect(keepsBold, "coloured span must stay inside the bold mark").toBe(true);

      // Default clears the colour only; the bold mark survives. Select the
      // coloured word again with a real double-click so the bubble menu is
      // anchored to a live (not programmatic) selection.
      await colored.dblclick();
      await expect(bubble).toBeVisible();
      await bubble.getByRole("button", { name: "Text color" }).click();
      await expect(panel).toBeVisible();
      await panel.getByRole("button", { name: "Default", exact: true }).click();
      await expect(editor.locator("span[style]")).toHaveCount(0);
      await expect(editor.locator("strong", { hasText: "world" })).toHaveCount(1);

      await expect(main.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });
    } finally {
      await prisma.page.delete({ where: { id: created.id } }).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// B11 — topbar Actions (⋯) menu parity (dedicated prisma pages + cleanup)
// ---------------------------------------------------------------------------
test.describe("actions menu (topbar ⋯)", () => {
  const textDoc = (text: string) => ({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });

  async function probeWorkspace() {
    const workspace = await prisma.workspace.findFirst({
      where: { slug: "demo-workspace" },
      select: { id: true, slug: true },
    });
    if (!workspace) throw new Error("demo-workspace not found");
    return workspace;
  }

  async function createProbePage(input: {
    title: string;
    parentId?: string | null;
    content?: unknown;
  }) {
    const workspace = await probeWorkspace();
    const owner = await prisma.user.findUnique({
      where: { email: CREDENTIALS.email },
      select: { id: true },
    });
    if (!owner) throw new Error("demo user not found");
    return prisma.page.create({
      data: {
        workspaceId: workspace.id,
        createdById: owner.id,
        parentId: input.parentId ?? null,
        title: input.title,
        ...(input.content
          ? { content: input.content as Prisma.InputJsonValue }
          : {}),
      },
      select: { id: true, parentId: true, title: true, content: true },
    });
  }

  async function openProbe(page: Page, pageId: string) {
    const workspace = await probeWorkspace();
    await page.goto(`/w/${workspace.slug}/${pageId}`);
    await expect(page.locator(".ProseMirror")).toBeVisible();
  }

  async function openActions(page: Page) {
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Page actions" });
    await expect(dialog).toBeVisible();
    return dialog;
  }

  test("search actions filters the list live (combobox + listbox + arrows)", async ({ page }) => {
    const probe = await createProbePage({ title: "B11 search probe" });
    try {
      await signIn(page);
      await openProbe(page, probe.id);
      const dialog = await openActions(page);

      const search = dialog.getByRole("combobox", { name: "Search" });
      await expect(search).toBeVisible();
      await expect(
        dialog.getByRole("combobox", { name: "Font style" }),
      ).toBeVisible();
      await expect(dialog.getByRole("menuitem", { name: /Duplicate/ })).toBeVisible();
      await expect(dialog.getByRole("menuitem", { name: /Move to Trash/ })).toBeVisible();

      // Arrow keys move the active option through aria-activedescendant.
      await search.press("ArrowDown");
      await expect(search).toHaveAttribute(
        "aria-activedescendant",
        "actions-menu-list-opt-copy-link",
      );

      // Typing filters the listbox live.
      await search.fill("duplicate");
      await expect(dialog.getByRole("menuitem")).toHaveCount(1);
      await expect(dialog.getByRole("menuitem", { name: /Duplicate/ })).toBeVisible();

      await search.fill("no-such-action");
      await expect(dialog.getByRole("menuitem")).toHaveCount(0);

      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "Page actions" })).toHaveCount(0);
    } finally {
      await prisma.page.deleteMany({ where: { id: probe.id } });
    }
  });

  test("Copy page contents writes the page markdown to the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const probe = await createProbePage({
      title: "B11 clipboard probe",
      content: textDoc("zephyr clipboard marker alpha"),
    });
    try {
      await signIn(page);
      await openProbe(page, probe.id);
      const dialog = await openActions(page);
      await dialog.getByRole("menuitem", { name: /^Copy page contents$/ }).click();
      await expect(page.getByText("Page contents copied")).toBeVisible();

      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toContain("zephyr clipboard marker alpha");
      expect(copied).toContain("# B11 clipboard probe");
    } finally {
      await prisma.page.deleteMany({ where: { id: probe.id } });
    }
  });

  test("Duplicate creates a sibling page with the same content", async ({ page }) => {
    const parent = await createProbePage({ title: "B11 duplicate parent" });
    const child = await createProbePage({
      title: "B11 duplicate child",
      parentId: parent.id,
      content: textDoc("twin content marker"),
    });
    try {
      await signIn(page);
      await openProbe(page, child.id);
      const dialog = await openActions(page);
      await dialog.getByRole("menuitem", { name: /^Duplicate$/ }).click();

      await expect
        .poll(
          () =>
            prisma.page.count({
              where: { parentId: parent.id, id: { not: child.id } },
            }),
          { timeout: 15_000 },
        )
        .toBe(1);

      const sibling = await prisma.page.findFirst({
        where: { parentId: parent.id, id: { not: child.id } },
      });
      expect(sibling?.title).toBe("B11 duplicate child");
      expect(JSON.stringify(sibling?.content ?? null)).toContain("twin content marker");
    } finally {
      await prisma.page.deleteMany({ where: { parentId: parent.id } });
      await prisma.page.deleteMany({ where: { id: { in: [parent.id, child.id] } } });
    }
  });

  test("menu footer shows word count, reading time and last edited by", async ({ page }) => {
    const probe = await createProbePage({
      title: "B11 footer probe",
      content: textDoc("quiet river stones"),
    });
    try {
      await signIn(page);
      await openProbe(page, probe.id);
      const dialog = await openActions(page);
      const footer = dialog.locator("footer");
      await expect(footer).toContainText("3 words");
      await expect(footer).toContainText("1 min read");
      await expect(footer).toContainText("Last edited by");
      await expect(footer).toContainText(/Today at \d{1,2}:\d{2} (AM|PM)/);
    } finally {
      await prisma.page.deleteMany({ where: { id: probe.id } });
    }
  });

  test("Translate submenu lists the five shipped locales", async ({ page }) => {
    const probe = await createProbePage({ title: "B11 translate probe" });
    try {
      await signIn(page);
      await openProbe(page, probe.id);
      const dialog = await openActions(page);
      await dialog.getByRole("menuitem", { name: /^Translate$/ }).click();
      const submenu = page
        .getByRole("menu")
        .filter({ has: page.getByRole("menuitem", { name: "English", exact: true }) })
        .last();
      await expect(submenu).toBeVisible();
      for (const label of ["English", "Français", "Español", "Deutsch", "العربية"]) {
        await expect(submenu.getByRole("menuitem", { name: label })).toBeVisible();
      }
    } finally {
      await prisma.page.deleteMany({ where: { id: probe.id } });
    }
  });

  test("Undo (Ctrl+Z) from the menu reverts the last editor change", async ({ page }) => {
    const probe = await createProbePage({
      title: "B11 undo probe",
      content: textDoc("stable text"),
    });
    try {
      await signIn(page);
      await openProbe(page, probe.id);
      const editor = page.locator(".ProseMirror");
      await editor.click();
      await page.keyboard.type("QQQ");
      await expect(editor).toContainText("QQQ");

      const dialog = await openActions(page);
      await dialog.getByRole("menuitem", { name: /Undo/ }).click();
      await expect(editor).not.toContainText("QQQ");
      await expect(editor).toContainText("stable text");
    } finally {
      await prisma.page.deleteMany({ where: { id: probe.id } });
    }
  });

  test("Small text and Full width toggle and persist across a reload", async ({ page }) => {
    const probe = await createProbePage({ title: "B11 toggles probe" });
    const flags = () =>
      prisma.page.findUnique({
        where: { id: probe.id },
        select: { smallText: true, fullWidth: true },
      });
    try {
      await signIn(page);
      await openProbe(page, probe.id);

      let dialog = await openActions(page);
      await dialog.getByRole("menuitemcheckbox", { name: /^Small text/ }).click();
      await dialog.getByRole("menuitemcheckbox", { name: /^Full width/ }).click();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "Page actions" })).toHaveCount(0);

      // The toggles round-trip through the server action first…
      await expect.poll(flags, { timeout: 15_000 }).toEqual({
        smallText: true,
        fullWidth: true,
      });
      // …and a fresh render (reload) reflects and persists them.
      await page.reload();
      await expect(page.locator("#main .noema-page-small.max-w-none")).toHaveCount(1);

      // Toggle back off through the menu (finally also resets the row).
      dialog = await openActions(page);
      await dialog.getByRole("menuitemcheckbox", { name: /^Small text/ }).click();
      await dialog.getByRole("menuitemcheckbox", { name: /^Full width/ }).click();
      await page.keyboard.press("Escape");
      await expect.poll(flags, { timeout: 15_000 }).toEqual({
        smallText: false,
        fullWidth: false,
      });
      await page.reload();
      await expect(page.locator("#main .noema-page-small.max-w-none")).toHaveCount(0);
    } finally {
      await prisma.page.update({
        where: { id: probe.id },
        data: { smallText: false, fullWidth: false },
      });
      await prisma.page.deleteMany({ where: { id: probe.id } });
    }
  });
});

/**
 * R80.12 / D6 — linked references are guest-scoped: a guest reading a shared
 * page sees mentioners they can open, and never the title/icon of one they
 * cannot. The mentioners deliberately mention the target while they exist, so
 * the assertions probe real data (a visible mentioner proves the panel had
 * rows to scope).
 */
test.describe("backlink guest scoping", () => {
  const guestEmail = `e2e-backlink-guest-${Date.now()}@noema.local`;
  const guestPassword = "password123";
  let guestId = "";
  let targetId = "";
  let openMentionerId = "";
  let secretMentionerId = "";

  const mentionDoc = (targetId: string, label: string) => ({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "mentions " },
          { type: "mention", attrs: { id: targetId, label, type: "page" } },
        ],
      },
    ],
  });

  test.beforeAll(async () => {
    const bcrypt = (await import("bcryptjs")).default;
    const guest = await prisma.user.create({
      data: { email: guestEmail, name: "Backlink Guest", passwordHash: await bcrypt.hash(guestPassword, 10) },
      select: { id: true },
    });
    guestId = guest.id;
  });

  test.afterAll(async () => {
    await prisma.page.deleteMany({
      where: { id: { in: [targetId, openMentionerId, secretMentionerId].filter(Boolean) } },
    });
    if (guestId) await prisma.user.deleteMany({ where: { id: guestId } });
    await prisma.$disconnect();
  });

  test("a guest sees only mentioners they can open", async ({ page }) => {
    const workspace = await prisma.workspace.findFirst({ where: { slug: "demo-workspace" } });
    const owner = await prisma.user.findUnique({
      where: { email: "demo@noema.local" },
      select: { id: true },
    });
    const stamp = Date.now();
    const targetLabel = `link target ${stamp}`;
    const openLabel = `open mentioner ${stamp}`;
    const secretLabel = `secret mentioner ${stamp}`;

    const target = await prisma.page.create({
      data: {
        workspaceId: workspace!.id,
        title: targetLabel,
        createdById: owner!.id,
        content: { type: "doc", content: [{ type: "paragraph" }] },
      },
      select: { id: true },
    });
    targetId = target.id;
    await prisma.pagePermission.create({
      data: { pageId: target.id, userId: guestId, level: "READ" },
    });
    const openMentioner = await prisma.page.create({
      data: {
        workspaceId: workspace!.id,
        title: openLabel,
        createdById: owner!.id,
        content: mentionDoc(target.id, targetLabel),
      },
      select: { id: true },
    });
    openMentionerId = openMentioner.id;
    await prisma.pagePermission.create({
      data: { pageId: openMentioner.id, userId: guestId, level: "READ" },
    });
    const secretMentioner = await prisma.page.create({
      data: {
        workspaceId: workspace!.id,
        title: secretLabel,
        createdById: owner!.id,
        content: mentionDoc(target.id, targetLabel),
      },
      select: { id: true },
    });
    secretMentionerId = secretMentioner.id;
    // The guest was never granted access to this one.
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace!.id, userId: guestId, role: "GUEST" },
    });

    try {
      await page.goto("/login");
      await page.getByLabel("Email").fill(guestEmail);
      await page.getByRole("textbox", { name: "Password" }).fill(guestPassword);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/w\//);

      await page.goto(`/w/${workspace!.slug}/${target.id}`);
      const panel = page.locator("#main");
      await expect(panel.getByRole("heading", { name: /Linked references/i })).toBeVisible({
        timeout: 15_000,
      });

      // The mentioner they can open shows up…
      const openRow = panel.locator(`a[href*="${openMentioner.id}"]`);
      await expect(openRow.filter({ hasText: openLabel })).toBeVisible();

      // …and the hidden mentioner never leaks its title or link.
      await expect(panel.getByText(secretLabel)).toHaveCount(0);
      await expect(panel.locator(`a[href*="${secretMentioner.id}"]`)).toHaveCount(0);
    } finally {
      await prisma.pagePermission.deleteMany({
        where: { pageId: { in: [target.id, openMentioner.id] } },
      });
    }
  });
});