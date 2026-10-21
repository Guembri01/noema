import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B02 — the page route hands a guest neither the roster nor a foreign title.
 *
 * The route itself was already scope-checked (a guest may only open the pages
 * shared with them), but its payload carried two workspace-wide lists:
 *
 *  - the **member directory** (every member's name), and
 *  - every **database title** of the workspace.
 *
 * Both are now decided before the data enters the RSC payload: the roster
 * needs the `viewMemberDirectory` permission, the database list carries the
 * guest scope.
 *
 * The real scope resolution and the real role matrix run here; only the
 * transport edges are mocked.
 */

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  getWorkspaceBySlug: vi.fn(),
  getPageDetail: vi.fn(),
  getAncestorTrail: vi.fn(),
  getDatabase: vi.fn(),
  getTeamspaces: vi.fn(),
  getUserWorkspaces: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  pageFindMany: vi.fn(),
  pageFollowFindUnique: vi.fn(),
  pagePermissionFindMany: vi.fn(),
  pageVersionFindMany: vi.fn(),
  teamspaceMemberFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findMany: h.pageFindMany },
    pageFollow: { findUnique: h.pageFollowFindUnique },
    pagePermission: { findMany: h.pagePermissionFindMany },
    pageVersion: { findMany: h.pageVersionFindMany },
    teamspaceMember: { findMany: h.teamspaceMemberFindMany },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: h.requireUser }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: h.getWorkspaceAccess };
});
vi.mock("@/server/queries", () => ({
  getWorkspaceBySlug: h.getWorkspaceBySlug,
  getPageDetail: h.getPageDetail,
  getAncestorTrail: h.getAncestorTrail,
  getDatabase: h.getDatabase,
  getTeamspaces: h.getTeamspaces,
  getUserWorkspaces: h.getUserWorkspaces,
  getWorkspaceMembers: h.getWorkspaceMembers,
}));
vi.mock("@/server/backlinks", () => ({
  getPageReferences: vi.fn(async () => ({ linked: [], unlinked: [] })),
}));
vi.mock("@/server/version-authors", () => ({
  loadVersionAuthors: vi.fn(async () => new Map()),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("katex/dist/katex.min.css", () => ({}));

import PageRoute from "./page";

/** The page row the route reads. */
function pageRow() {
  return {
    id: "page-shared",
    workspaceId: "ws1",
    deletedAt: null,
    type: "PAGE",
    title: "Shared notes",
    icon: null,
    coverUrl: null,
    isFavorite: false,
    fullWidth: false,
    smallText: false,
    font: null,
    lineSpacing: null,
    locked: false,
    schemaLocked: false,
    content: null,
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    shareLinks: [],
    versions: [],
    comments: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue({ id: "u1", locale: "en" });
  h.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
  h.getWorkspaceBySlug.mockResolvedValue({ id: "ws1", name: "Acme", slug: "acme" });
  h.getPageDetail.mockResolvedValue(pageRow());
  h.getAncestorTrail.mockResolvedValue([]);
  h.getDatabase.mockResolvedValue(null);
  h.getTeamspaces.mockResolvedValue([]);
  h.getUserWorkspaces.mockResolvedValue([]);
  h.getWorkspaceMembers.mockResolvedValue([{ id: "m1", name: "Ada", email: "ada@example.com" }]);
  h.pageFindMany.mockResolvedValue([]);
  h.pageFollowFindUnique.mockResolvedValue(null);
  h.pageVersionFindMany.mockResolvedValue([]);
  // The guest scope resolves for real: one shared page plus its ancestor.
  // `prisma.pagePermission.findMany` serves two callers here — the scope
  // resolution (a permission row) and the route's own permission read (a
  // level) — so the mock tells them apart by their `where` clause.
  h.pagePermissionFindMany.mockImplementation(
    (args: { where?: { userId?: string } }) =>
      args?.where?.userId ? [{ pageId: "page-shared" }] : [],
  );
  h.teamspaceMemberFindMany.mockResolvedValue([]);
  // `prisma.page.findMany` serves three callers here — the guest's own pages,
  // the whole tree (both part of the scope) and the database list — so the
  // mock tells them apart by their `where`/`select`.
  h.pageFindMany.mockImplementation(
    (args: { where?: { createdById?: string; type?: string }; select?: Record<string, unknown> }) => {
      if (args?.where?.type === "DATABASE") return [];
      if (args?.where?.createdById) return [];
      if (args?.select?.parentId) {
        return [
          { id: "page-root", parentId: null, teamspaceId: null, permissions: [] },
          {
            id: "page-shared",
            parentId: "page-root",
            teamspaceId: null,
            // The read scope is resolved from the per-page grant select.
            permissions: [{ level: "READ" }],
          },
          { id: "page-secret", parentId: "page-root", teamspaceId: null, permissions: [] },
        ];
      }
      return [];
    },
  );
});

/** The `where` clause the database list was queried with. */
function databaseWhere(): Record<string, unknown> {
  const call = h.pageFindMany.mock.calls.find(
    ([args]) => (args as { where?: { type?: string } }).where?.type === "DATABASE",
  );
  expect(call).toBeDefined();
  return (call as [{ where: Record<string, unknown> }])[0].where;
}

describe("the page route", () => {
  it("never reads the member directory for a guest", async () => {
    await PageRoute({ params: Promise.resolve({ slug: "acme", pageId: "page-shared" }) });

    expect(h.getWorkspaceMembers).not.toHaveBeenCalled();
  });

  it("scopes the database list to the guest's readable pages, not its ancestors", async () => {
    await PageRoute({ params: Promise.resolve({ slug: "acme", pageId: "page-shared" }) });

    expect(databaseWhere()).toEqual({
      workspaceId: "ws1",
      type: "DATABASE",
      deletedAt: null,
      // `page-root` is only a display ancestor; a database inherited from the
      // shared page is in scope, one reachable only through the ancestor is not.
      id: { in: ["page-shared"] },
    });
  });

  it("gives a full member the whole workspace", async () => {
    h.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    await PageRoute({ params: Promise.resolve({ slug: "acme", pageId: "page-secret" }) });

    expect(h.getWorkspaceMembers).toHaveBeenCalledTimes(1);
    expect(databaseWhere()).toEqual({
      workspaceId: "ws1",
      type: "DATABASE",
      deletedAt: null,
    });
  });
});
