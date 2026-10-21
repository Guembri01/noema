import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B37 — the exploit of the issue, end to end.
 *
 * A member of workspace A follows a page of workspace B (the page id is
 * known). Before the fix the toggle wrote the row, and every later edit of B's
 * page produced a notification for the follower in A carrying B's page title.
 *
 * The real actions run here (the toggle and the dispatch); only the transport
 * edges (prisma, auth, permissions, cache) are mocked. The prisma mock keeps
 * the rows of the two stores the exploit touches (the follows and the written
 * notifications), so the assertion is about what a member of A ends up with.
 */

const FOLLOWER_A = "member-of-a";
const FOLLOWER_C = "member-of-b";
const EDITOR_B = "editor-of-b";
const PAGE_IN_B = "page-in-b";
const TITLE_IN_B = "Board strategy Q3";

const h = vi.hoisted(() => ({
  follows: [] as { userId: string; pageId: string }[],
  notifications: [] as { userId: string; type: string; payload: unknown }[],
  requireUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  pageFindFirst: vi.fn(),
  pageFindUnique: vi.fn(),
  pageFollowFindUnique: vi.fn(),
  pageFollowCreate: vi.fn(),
  pageFollowDelete: vi.fn(),
  pageFollowFindMany: vi.fn(),
  favoriteFindUnique: vi.fn(),
  favoriteCreate: vi.fn(),
  workspaceMemberFindMany: vi.fn(),
  userFindMany: vi.fn(),
  notificationFindMany: vi.fn(),
  notificationCreateMany: vi.fn(),
  webhookFindMany: vi.fn(),
  workspaceFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findFirst: h.pageFindFirst, findUnique: h.pageFindUnique },
    pageFollow: {
      findUnique: h.pageFollowFindUnique,
      create: h.pageFollowCreate,
      delete: h.pageFollowDelete,
      findMany: h.pageFollowFindMany,
    },
    favorite: { findUnique: h.favoriteFindUnique, create: h.favoriteCreate },
    workspaceMember: { findMany: h.workspaceMemberFindMany },
    user: { findMany: h.userFindMany },
    notification: {
      findMany: h.notificationFindMany,
      createMany: h.notificationCreateMany,
    },
    webhook: { findMany: h.webhookFindMany },
    workspace: { findUnique: h.workspaceFindUnique },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: h.requireUser }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: h.getWorkspaceAccess };
});
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: vi.fn(async () => undefined) }));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { toggleFollowAction } from "./pages";
import { notifyPageUpdated } from "./notifications";

/** The pages of the fixture: the only one lives in workspace B. */
const PAGES = [
  { id: PAGE_IN_B, workspaceId: "ws-b", title: TITLE_IN_B },
];

/** The memberships of the fixture. */
const MEMBERS = [
  { userId: FOLLOWER_A, workspaceId: "ws-a" },
  { userId: FOLLOWER_C, workspaceId: "ws-b" },
  { userId: EDITOR_B, workspaceId: "ws-b" },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.follows.length = 0;
  h.notifications.length = 0;

  h.getWorkspaceAccess.mockImplementation(
    async (userId: string, workspaceId: string) =>
      MEMBERS.some(
        (member) => member.userId === userId && member.workspaceId === workspaceId,
      )
        ? { role: "MEMBER" }
        : null,
  );
  // The tenant-scoped page query of the toggle.
  h.pageFindFirst.mockImplementation(
    async ({ where }: { where: { id: string; workspaceId: string } }) => {
      const page = PAGES.find(
        (row) => row.id === where.id && row.workspaceId === where.workspaceId,
      );
      return page ? { id: page.id } : null;
    },
  );
  // The page row the dispatch reads.
  h.pageFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const page = PAGES.find((row) => row.id === where.id);
    return page
      ? { id: page.id, workspaceId: page.workspaceId, title: page.title, deletedAt: null }
      : null;
  });

  h.pageFollowFindUnique.mockImplementation(
    async ({ where }: { where: { userId_pageId: { userId: string; pageId: string } } }) => {
      const row = h.follows.find(
        (follow) =>
          follow.userId === where.userId_pageId.userId &&
          follow.pageId === where.userId_pageId.pageId,
      );
      return row ? { id: "follow-1" } : null;
    },
  );
  h.pageFollowCreate.mockImplementation(
    async ({ data }: { data: { userId: string; pageId: string } }) => {
      h.follows.push({ userId: data.userId, pageId: data.pageId });
      return { id: "follow-1" };
    },
  );
  h.pageFollowFindMany.mockImplementation(
    async ({ where }: { where: { pageId: string } }) =>
      h.follows
        .filter((follow) => follow.pageId === where.pageId)
        .map((follow) => ({ userId: follow.userId })),
  );
  h.workspaceMemberFindMany.mockImplementation(
    async ({ where }: { where: { workspaceId: string; userId: { in: string[] } } }) =>
      MEMBERS.filter(
        (member) =>
          member.workspaceId === where.workspaceId &&
          where.userId.in.includes(member.userId),
      ).map((member) => ({ userId: member.userId })),
  );
  h.userFindMany.mockImplementation(
    async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map((id) => ({ id, notificationPrefs: null })),
  );
  h.notificationFindMany.mockResolvedValue([]);
  h.notificationCreateMany.mockImplementation(
    async ({ data }: { data: { userId: string; type: string; payload: unknown }[] }) => {
      h.notifications.push(...data);
      return { count: data.length };
    },
  );
  h.webhookFindMany.mockResolvedValue([]);
  h.workspaceFindUnique.mockResolvedValue({ slug: "b" });
});

describe("following a page of another workspace", () => {
  it("writes no follow and no notification with the page's title", async () => {
    // A member of workspace A follows a page of workspace B.
    h.requireUser.mockResolvedValue({ id: FOLLOWER_A });
    const follow = await toggleFollowAction("ws-a", PAGE_IN_B);

    expect(follow).toEqual({ error: "Page not found." });
    expect(h.follows).toEqual([]);

    // The editor of workspace B edits the page.
    h.requireUser.mockResolvedValue({ id: EDITOR_B });
    await notifyPageUpdated(PAGE_IN_B);

    expect(h.notifications).toEqual([]);
    expect(JSON.stringify(h.notifications)).not.toContain(TITLE_IN_B);
  });
});

describe("following a page of your own workspace", () => {
  it("notifies the follower with the page's title", async () => {
    // A member of workspace B follows a page of workspace B.
    h.requireUser.mockResolvedValue({ id: FOLLOWER_C });
    const follow = await toggleFollowAction("ws-b", PAGE_IN_B);

    expect(follow).toEqual({ ok: true, following: true });
    expect(h.follows).toEqual([{ userId: FOLLOWER_C, pageId: PAGE_IN_B }]);

    // The editor of workspace B edits the page.
    h.requireUser.mockResolvedValue({ id: EDITOR_B });
    await notifyPageUpdated(PAGE_IN_B);

    expect(h.notifications).toEqual([
      {
        userId: FOLLOWER_C,
        type: "page.updated",
        payload: {
          workspaceId: "ws-b",
          pageId: PAGE_IN_B,
          title: TITLE_IN_B,
          actorId: EDITOR_B,
        },
      },
    ]);
  });
});
