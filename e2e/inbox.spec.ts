import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * B41 — inbox + follow:
 *  (a) a mention of a workspace member creates an inbox notification for them
 *      (the member is prisma-created; the real comment/mention flow posts it
 *      and the member sees it in their own inbox),
 *  (b) the inbox marks ONE notification read — sibling rows stay unread,
 *  (c) the page follow toggle survives a reload (server-side pageFollow row).
 *
 * Dedicated prisma fixtures + try/finally cleanup (descriptions.spec.ts
 * pattern); never the shared first page. Locators are scoped to #main.
 * Does NOT touch e2e/noema.spec.ts — its similar flows stay untouched.
 */

const CREDENTIALS = { email: "demo@noema.local", password: "password123" };
const SLUG = "demo-workspace";
const STAMP = Date.now();
const MARKER = `B41-${STAMP}`;

const prisma = new PrismaClient();

/** Rows this spec created — swept even if a test body dies mid-flight. */
const notificationIds: string[] = [];
const pageIds: string[] = [];
const memberIds: string[] = [];

test.afterAll(async () => {
  await prisma.notification
    .deleteMany({ where: { id: { in: notificationIds } } })
    .catch(() => {});
  await prisma.comment
    .deleteMany({ where: { body: { contains: MARKER } } })
    .catch(() => {});
  await prisma.pageFollow
    .deleteMany({ where: { pageId: { in: pageIds } } })
    .catch(() => {});
  await prisma.notification
    .deleteMany({ where: { userId: { in: memberIds } } })
    .catch(() => {});
  await prisma.workspaceMember
    .deleteMany({ where: { userId: { in: memberIds } } })
    .catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: memberIds } } }).catch(() => {});
  await prisma.page.deleteMany({ where: { id: { in: pageIds } } }).catch(() => {});
  await prisma.$disconnect();
});

async function signIn(page: Page, creds = CREDENTIALS) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(creds.email);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/w\//);
}

/**
 * Deterministic hydration signal (descriptions.spec.ts): filling a form before
 * React takes over writes to a DOM node React then reconciles away, so the
 * composer would submit an empty body.
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
    where: { slug: SLUG },
    select: { id: true, slug: true },
  });
  const owner = await prisma.user.findUnique({
    where: { email: CREDENTIALS.email },
    select: { id: true },
  });
  if (!workspace || !owner) throw new Error("demo workspace/user not seeded");
  return { workspace, owner };
}

/** Dedicated page so no assertion can ride on shared first-page state. */
async function createPage(title: string) {
  const { workspace, owner } = await workspaceAndOwner();
  const created = await prisma.page.create({
    data: { workspaceId: workspace.id, title, createdById: owner.id, type: "PAGE" },
    select: { id: true },
  });
  pageIds.push(created.id);
  return created;
}

test.describe("inbox + follow", () => {
  test("mention of a workspace member creates an inbox notification for them", async ({
    page,
  }) => {
    const { workspace } = await workspaceAndOwner();
    const bcrypt = (await import("bcryptjs")).default;
    // Single-token name: `@B41m…` matches exactly this member (first-name rule).
    const memberName = `B41m${STAMP}`;
    const memberEmail = `b41-${STAMP}@noema.local`;
    const memberPassword = "password123";

    const member = await prisma.user.create({
      data: {
        email: memberEmail,
        name: memberName,
        passwordHash: await bcrypt.hash(memberPassword, 10),
      },
      select: { id: true },
    });
    memberIds.push(member.id);
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: member.id, role: "MEMBER" },
    });
    const target = await createPage(`B41 mention ${STAMP}`);

    try {
      // The author posts through the real comment/mention flow…
      await signIn(page);
      const main = page.locator("#main");
      await page.goto(`/w/${SLUG}/${target.id}`);
      await waitForHydration(page, 'textarea[aria-label="Add a comment"]');
      await main
        .getByLabel("Add a comment")
        .fill(`@${memberName} inbox ping ${MARKER}`);
      await main.getByRole("button", { name: "Post comment" }).click();
      await expect(main.getByText(MARKER)).toBeVisible({ timeout: 15_000 });

      // …which creates the mention notification for THAT member, not the author.
      await expect
        .poll(
          async () => {
            const row = await prisma.notification.findFirst({
              where: { userId: member.id, type: "page.mention" },
              select: { payload: true },
            });
            const payload = (row?.payload ?? {}) as { pageId?: string };
            return row !== null && payload.pageId === target.id;
          },
          { timeout: 15_000 },
        )
        .toBe(true);
      const created = await prisma.notification.findMany({
        where: { userId: member.id, type: "page.mention" },
        select: { id: true },
      });
      notificationIds.push(...created.map((row) => row.id));

      // …and it shows up in the member's own inbox, linking at the page.
      await page.context().clearCookies();
      await signIn(page, { email: memberEmail, password: memberPassword });
      await page.goto(`/w/${SLUG}/inbox`);
      const row = main
        .getByRole("listitem")
        .filter({ hasText: "You were mentioned on a page" });
      await expect(row.first()).toBeVisible({ timeout: 15_000 });
      await expect(
        row.first().locator(`a[href="/w/${SLUG}/${target.id}"]`),
      ).toHaveCount(1);
    } finally {
      await prisma.comment
        .deleteMany({ where: { body: { contains: MARKER } } })
        .catch(() => {});
      await prisma.notification
        .deleteMany({ where: { userId: member.id } })
        .catch(() => {});
      await prisma.workspaceMember
        .deleteMany({ where: { userId: member.id } })
        .catch(() => {});
      await prisma.user.delete({ where: { id: member.id } }).catch(() => {});
      await prisma.page.delete({ where: { id: target.id } }).catch(() => {});
    }
  });

  test("inbox marks a single notification read and leaves siblings unread", async ({
    page,
  }) => {
    const { owner } = await workspaceAndOwner();
    const target = await createPage(`B41 inbox ${STAMP}`);

    const marked = await prisma.notification.create({
      data: {
        userId: owner.id,
        type: "page.mention",
        payload: { pageId: target.id },
        read: false,
      },
      select: { id: true },
    });
    const sibling = await prisma.notification.create({
      data: { userId: owner.id, type: "page.shared", payload: {}, read: false },
      select: { id: true },
    });
    notificationIds.push(marked.id, sibling.id);

    try {
      await signIn(page);
      await page.goto(`/w/${SLUG}/inbox`);
      const main = page.locator("#main");
      // Unique row even in a busy inbox: it is the one linking at our page.
      const row = main
        .getByRole("listitem")
        .filter({ has: page.locator(`a[href="/w/${SLUG}/${target.id}"]`) });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText("You were mentioned on a page");
      await row.getByRole("button", { name: "Mark read", exact: true }).click();

      await expect
        .poll(
          async () => {
            const after = await prisma.notification.findUnique({
              where: { id: marked.id },
              select: { read: true },
            });
            return after?.read;
          },
          { timeout: 15_000 },
        )
        .toBe(true);
      const siblingRow = await prisma.notification.findUnique({
        where: { id: sibling.id },
        select: { read: true },
      });
      expect(siblingRow?.read).toBe(false);

      // The single-mark is persisted: after a reload the row keeps its link
      // and loses the action, while the sibling is still unread.
      await page.reload();
      await expect(row).toHaveCount(1);
      await expect(
        row.getByRole("button", { name: "Mark read", exact: true }),
      ).toHaveCount(0);
      const siblingAfterReload = await prisma.notification.findUnique({
        where: { id: sibling.id },
        select: { read: true },
      });
      expect(siblingAfterReload?.read).toBe(false);
    } finally {
      await prisma.notification
        .deleteMany({ where: { id: { in: [marked.id, sibling.id] } } })
        .catch(() => {});
    }
  });

  test("follow toggle persists across reload", async ({ page }) => {
    const { owner } = await workspaceAndOwner();
    const target = await createPage(`B41 follow ${STAMP}`);
    const followCount = async () =>
      prisma.pageFollow.count({ where: { pageId: target.id, userId: owner.id } });

    try {
      await signIn(page);
      await page.goto(`/w/${SLUG}/${target.id}`);
      const main = page.locator("#main");
      const followBtn = main.getByRole("button", { name: "Follow page", exact: true });
      await waitForHydration(page, '#main button[aria-label="Follow page"]');

      await followBtn.click();
      await expect(
        main.getByRole("button", { name: "Unfollow page", exact: true }),
      ).toBeVisible({ timeout: 15_000 });
      await expect.poll(followCount, { timeout: 15_000 }).toBe(1);

      // Persisted server-side: the reloaded page still knows we follow it.
      await page.reload();
      const unfollowBtn = main.getByRole("button", {
        name: "Unfollow page",
        exact: true,
      });
      await expect(unfollowBtn).toBeVisible({ timeout: 15_000 });

      await unfollowBtn.click();
      await expect(
        main.getByRole("button", { name: "Follow page", exact: true }),
      ).toBeVisible({ timeout: 15_000 });
      await expect.poll(followCount, { timeout: 15_000 }).toBe(0);

      await page.reload();
      await expect(
        main.getByRole("button", { name: "Follow page", exact: true }),
      ).toBeVisible({ timeout: 15_000 });
    } finally {
      await prisma.pageFollow
        .deleteMany({ where: { pageId: target.id } })
        .catch(() => {});
      await prisma.page.delete({ where: { id: target.id } }).catch(() => {});
    }
  });
});
