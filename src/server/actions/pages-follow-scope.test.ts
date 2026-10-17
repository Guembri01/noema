import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B37 — a follow (or a favorite) may only point at a page of the caller's own
 * workspace.
 *
 * `PageFollow.pageId` and `Favorite.pageId` are plain foreign keys: the toggle
 * actions checked the caller's access to the workspace but never that the page
 * belongs to it, so a member of workspace A could follow a page of workspace B
 * and be told about every edit of it — the notice carries the page's title.
 *
 * The tenant check is the real one: the page query is workspace-scoped, so a
 * foreign page is never read (the mock below answers exactly what the database
 * would answer) and the refusal never names it. The guest scope runs for real
 * (`pageScopeFor` → `guestScope`), so a guest may not subscribe to a page they
 * may not open either.
 */

const CALLER = "member-1";
const PAGE_IN_A = "page-in-a";
const PAGE_HIDDEN = "page-hidden-in-a";
const PAGE_IN_B = "page-in-b";
const SECRET_TITLE = "Board strategy";

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  pageFindFirst: vi.fn(),
  pageFindMany: vi.fn(),
  pagePermissionFindMany: vi.fn(),
  teamspaceMemberFindMany: vi.fn(),
  pageFollowFindUnique: vi.fn(),
  pageFollowCreate: vi.fn(),
  pageFollowDelete: vi.fn(),
  favoriteFindUnique: vi.fn(),
  favoriteCreate: vi.fn(),
  favoriteDelete: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findFirst: h.pageFindFirst, findMany: h.pageFindMany },
    pagePermission: { findMany: h.pagePermissionFindMany },
    teamspaceMember: { findMany: h.teamspaceMemberFindMany },
    pageFollow: {
      findUnique: h.pageFollowFindUnique,
      create: h.pageFollowCreate,
      delete: h.pageFollowDelete,
    },
    favorite: {
      findUnique: h.favoriteFindUnique,
      create: h.favoriteCreate,
      delete: h.favoriteDelete,
    },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: h.requireUser }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: h.getWorkspaceAccess };
});
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: vi.fn(async () => undefined) }));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("@/server/actions/notifications", () => ({
  notifyPageUpdated: vi.fn(async () => undefined),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { toggleFavoriteAction, toggleFollowAction } from "./pages";

/** The pages of the fixture: two in the caller's workspace, one foreign. */
const PAGES = [
  { id: PAGE_IN_A, workspaceId: "ws-a", title: "Roadmap" },
  { id: PAGE_HIDDEN, workspaceId: "ws-a", title: SECRET_TITLE },
  { id: PAGE_IN_B, workspaceId: "ws-b", title: SECRET_TITLE },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue({ id: CALLER });
  h.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
  // The tenant-scoped page query: a page of another workspace matches no row.
  h.pageFindFirst.mockImplementation(
    async ({ where }: { where: { id: string; workspaceId: string } }) => {
      const page = PAGES.find(
        (row) => row.id === where.id && row.workspaceId === where.workspaceId,
      );
      return page ? { id: page.id } : null;
    },
  );
  h.pageFollowFindUnique.mockResolvedValue(null);
  h.favoriteFindUnique.mockResolvedValue(null);
  h.pageFollowCreate.mockResolvedValue({ id: "follow-1" });
  h.favoriteCreate.mockResolvedValue({ id: "fav-1" });
  // The guest scope (only a GUEST resolves it): one shared page, nothing else.
  h.pagePermissionFindMany.mockResolvedValue([{ pageId: PAGE_IN_A }]);
  h.teamspaceMemberFindMany.mockResolvedValue([]);
  h.pageFindMany.mockImplementation(
    (args: { where?: { createdById?: string } }) =>
      args?.where?.createdById
        ? []
        : PAGES.map((row) => ({ id: row.id, parentId: null, teamspaceId: null })),
  );
});

describe("toggleFollowAction — the page must live in the caller's workspace", () => {
  it("refuses a page of another workspace and writes no row", async () => {
    const result = await toggleFollowAction("ws-a", PAGE_IN_B);

    expect(result).toEqual({ error: "Page not found." });
    expect(h.pageFollowCreate).not.toHaveBeenCalled();
  });

  it("refuses a foreign page for a favorite as well", async () => {
    const result = await toggleFavoriteAction("ws-a", PAGE_IN_B);

    expect(result).toEqual({ error: "Page not found." });
    expect(h.favoriteCreate).not.toHaveBeenCalled();
  });

  it("follows a page of the caller's own workspace", async () => {
    const result = await toggleFollowAction("ws-a", PAGE_IN_A);

    expect(result).toEqual({ ok: true, following: true });
    expect(h.pageFollowCreate).toHaveBeenCalledWith({
      data: { userId: CALLER, pageId: PAGE_IN_A },
    });
  });

  it("favorites a page of the caller's own workspace", async () => {
    const result = await toggleFavoriteAction("ws-a", PAGE_IN_A);

    expect(result).toEqual({ ok: true, favorite: true });
    expect(h.favoriteCreate).toHaveBeenCalledWith({
      data: { userId: CALLER, pageId: PAGE_IN_A },
    });
  });

  it("unfollows a page of the caller's own workspace", async () => {
    h.pageFollowFindUnique.mockResolvedValue({ id: "follow-1" });

    const result = await toggleFollowAction("ws-a", PAGE_IN_A);

    expect(result).toEqual({ ok: true, following: false });
    expect(h.pageFollowDelete).toHaveBeenCalledWith({ where: { id: "follow-1" } });
  });

  it("refuses a page of their own workspace a guest may not open", async () => {
    h.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });

    const result = await toggleFollowAction("ws-a", PAGE_HIDDEN);

    expect(result).toEqual({ error: "Page not found." });
    expect(h.pageFollowCreate).not.toHaveBeenCalled();
  });

  it("lets a guest follow a page that was shared with them", async () => {
    h.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });

    const result = await toggleFollowAction("ws-a", PAGE_IN_A);

    expect(result).toEqual({ ok: true, following: true });
    expect(h.pageFollowCreate).toHaveBeenCalledWith({
      data: { userId: CALLER, pageId: PAGE_IN_A },
    });
  });
});
