import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B02 — the move page hands the page tree the guest scope.
 *
 * The source-page picker lists every page of the workspace, so an unscoped
 * `getPageTree` told a guest the titles of pages that were never shared with
 * them. The tree query takes its scope as a required argument
 * (`getPageTree`), and this page now resolves it with `pageScopeFor` — the
 * same scope the sidebar and the page route use.
 *
 * The real scope resolution runs here; only the transport edges are mocked.
 */

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  getPageTree: vi.fn(),
  getWorkspaceBySlug: vi.fn(),
  getUserWorkspaces: vi.fn(),
  pageFindMany: vi.fn(),
  pagePermissionFindMany: vi.fn(),
  teamspaceMemberFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findMany: h.pageFindMany },
    pagePermission: { findMany: h.pagePermissionFindMany },
    teamspaceMember: { findMany: h.teamspaceMemberFindMany },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: h.requireUser }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: h.getWorkspaceAccess };
});
vi.mock("@/server/queries", () => ({
  getPageTree: h.getPageTree,
  getWorkspaceBySlug: h.getWorkspaceBySlug,
  getUserWorkspaces: h.getUserWorkspaces,
}));
vi.mock("@/server/actions/move-workspace", () => ({
  previewWorkspaceMoveAction: vi.fn(),
  executeWorkspaceMoveAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

import MovePagesPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue({ id: "u1", locale: "en" });
  h.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
  h.getWorkspaceBySlug.mockResolvedValue({ id: "ws1", name: "Acme", slug: "acme" });
  h.getPageTree.mockResolvedValue([]);
  h.getUserWorkspaces.mockResolvedValue([]);
  // The guest scope resolves for real: one shared page plus its ancestor.
  h.pagePermissionFindMany.mockResolvedValue([{ pageId: "page-shared" }]);
  h.teamspaceMemberFindMany.mockResolvedValue([]);
  // `guestVisiblePageIds` asks twice: once for the pages the guest created
  // (none) and once for the whole tree. The mock has to answer both
  // differently, or the guest would appear to own every page.
  h.pageFindMany.mockImplementation((args: { where?: { createdById?: string } }) =>
    args?.where?.createdById
      ? []
      : [
          { id: "page-root", parentId: null, teamspaceId: null },
          { id: "page-shared", parentId: "page-root", teamspaceId: null },
          { id: "page-secret", parentId: "page-root", teamspaceId: null },
        ],
  );
});

/** The scope the tree was loaded with. */
function treeScope(): Set<string> | null | undefined {
  const [, scope] = h.getPageTree.mock.calls[0] as [string, Set<string> | null];
  return scope;
}

describe("the move-pages settings page", () => {
  it("loads the tree with the guest scope, not the whole workspace", async () => {
    await MovePagesPage({
      params: Promise.resolve({ slug: "acme" }),
      searchParams: Promise.resolve({}),
    });

    expect(h.getPageTree).toHaveBeenCalledTimes(1);
    expect(treeScope()).toEqual(new Set(["page-shared", "page-root"]));
  });

  it("gives a full member the whole workspace", async () => {
    h.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    await MovePagesPage({
      params: Promise.resolve({ slug: "acme" }),
      searchParams: Promise.resolve({}),
    });

    expect(treeScope()).toBeNull();
  });
});
