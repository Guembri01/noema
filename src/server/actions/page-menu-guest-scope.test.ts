import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B02 — the page-menu actions honour the guest page scope.
 *
 * The topbar menu is a read surface: `getPageMenuDataAction` returned the
 * word/character statistics of a private page's content, its version timeline
 * and up to 30 page titles of the workspace (the move targets) to any guest
 * that named a page id. Both it and `getPageEditedAction` now ask the same
 * question as the page route, and the move targets carry the scope.
 *
 * The real scope resolution runs here; only the transport edges are mocked.
 */

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  pageFindUnique: vi.fn(),
  pageFindMany: vi.fn(),
  pageVersionFindMany: vi.fn(),
  webhookFindMany: vi.fn(),
  oauthAppFindMany: vi.fn(),
  pagePermissionFindMany: vi.fn(),
  teamspaceMemberFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: h.pageFindUnique, findMany: h.pageFindMany },
    pageVersion: { findMany: h.pageVersionFindMany },
    webhook: { findMany: h.webhookFindMany },
    oAuthApp: { findMany: h.oauthAppFindMany },
    user: { findUnique: vi.fn(async () => null) },
    pagePermission: { findMany: h.pagePermissionFindMany },
    teamspaceMember: { findMany: h.teamspaceMemberFindMany },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: h.requireUser }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: h.getWorkspaceAccess };
});
vi.mock("@/server/version-authors", () => ({
  loadVersionAuthors: vi.fn(async () => (id: string | null) => (id ? { name: "Ada" } : null)),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getPageEditedAction, getPageMenuDataAction } from "./page-menu";

const SECRET_DOC = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "TOP SECRET PAYROLL" }] }],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue({ id: "u1" });
  h.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
  h.pageFindUnique.mockImplementation(
    async (args: { where: { id: string }; select?: Record<string, unknown> }) => {
      const select = args?.select ?? {};
      // The edited label: the newest version's author.
      if (select.versions) {
        return {
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
          createdBy: { name: "Ada" },
          versions: [],
        };
      }
      // The menu detail: the page's own content and editor.
      if (select.updatedAt) {
        return {
          content: SECRET_DOC,
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
          createdBy: { name: "Ada" },
        };
      }
      // The authorization read: the page itself.
      return { id: args.where.id, workspaceId: "ws1", deletedAt: null };
    },
  );
  h.pageVersionFindMany.mockResolvedValue([]);
  h.webhookFindMany.mockResolvedValue([]);
  h.oauthAppFindMany.mockResolvedValue([]);
  // The guest scope resolves for real: one shared page plus its ancestor.
  h.pagePermissionFindMany.mockResolvedValue([{ pageId: "page-shared" }]);
  h.teamspaceMemberFindMany.mockResolvedValue([]);
  // `prisma.page.findMany` serves three callers here — the guest's own pages,
  // the scope's tree and the move-target list — so the mock tells them apart
  // by their `select`.
  h.pageFindMany.mockImplementation((args: { select?: Record<string, unknown> }) => {
    const select = args?.select ?? {};
    if (select.type) {
      return [
        { id: "page-root", parentId: null, title: "Workspace", icon: null, type: "PAGE" },
        { id: "page-shared", parentId: "page-root", title: "Shared notes", icon: null, type: "PAGE" },
        { id: "page-secret", parentId: "page-root", title: "Board strategy", icon: null, type: "PAGE" },
      ];
    }
    if (select.parentId) {
      return [
        { id: "page-root", parentId: null, teamspaceId: null },
        { id: "page-shared", parentId: "page-root", teamspaceId: null },
        { id: "page-secret", parentId: "page-root", teamspaceId: null },
      ];
    }
    return [];
  });
});

/** The `where` clause the move-target list was queried with. */
function moveTargetWhere(): Record<string, unknown> {
  const call = h.pageFindMany.mock.calls.find(
    ([args]) => (args as { select?: { type?: boolean } }).select?.type === true,
  );
  expect(call).toBeDefined();
  return (call as [{ where: Record<string, unknown> }])[0].where;
}

describe("getPageMenuDataAction", () => {
  it("refuses a page outside the guest scope", async () => {
    const result = await getPageMenuDataAction("page-secret");

    expect(result).toEqual({ error: "Page not found." });
  });

  it("scopes the move targets to the guest's pages", async () => {
    const result = await getPageMenuDataAction("page-shared");

    expect(result).toMatchObject({ ok: true });
    expect(moveTargetWhere()).toEqual({
      workspaceId: "ws1",
      deletedAt: null,
      id: { in: ["page-shared", "page-root"] },
    });
  });

  it("gives a full member the whole workspace", async () => {
    h.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    const result = await getPageMenuDataAction("page-secret");

    expect(result).toMatchObject({ ok: true });
    expect(moveTargetWhere()).toEqual({ workspaceId: "ws1", deletedAt: null });
  });
});

describe("getPageEditedAction", () => {
  it("refuses a page outside the guest scope", async () => {
    const result = await getPageEditedAction("page-secret");

    expect(result).toEqual({ error: "Page not found." });
  });

  it("serves a page inside the guest scope", async () => {
    const result = await getPageEditedAction("page-shared");

    expect(result).toMatchObject({ ok: true });
  });
});
