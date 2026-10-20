import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B02 — the workspace home hands the trash the guest scope.
 *
 * The home page shows a "recently deleted" list of page titles. The query was
 * filtered by workspace only, so a guest read the titles of archived pages
 * they were never given — the same leak the trash page had. The scope now
 * travels with the query (`getTrash` takes it as a required argument).
 *
 * The real scope resolution runs here; only the transport edges are mocked.
 */

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  getTrash: vi.fn(),
  getWorkspaceBySlug: vi.fn(),
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
  getTrash: h.getTrash,
  getWorkspaceBySlug: h.getWorkspaceBySlug,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

import WorkspaceHome from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue({ id: "u1", name: "Ada", locale: "en" });
  h.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
  h.getWorkspaceBySlug.mockResolvedValue({ id: "ws1", name: "Acme", slug: "acme", icon: null });
  h.getTrash.mockResolvedValue([]);
  h.pagePermissionFindMany.mockResolvedValue([{ pageId: "page-shared" }]);
  h.teamspaceMemberFindMany.mockResolvedValue([]);
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

/** The scope the trash was loaded with. */
function trashScope(): Set<string> | null | undefined {
  const [, scope] = h.getTrash.mock.calls[0] as [string, Set<string> | null];
  return scope;
}

describe("the workspace home", () => {
  it("loads the recently-deleted list with the guest scope", async () => {
    await WorkspaceHome({ params: Promise.resolve({ slug: "acme" }) });

    expect(h.getTrash).toHaveBeenCalledTimes(1);
    expect(trashScope()).toEqual(new Set(["page-shared", "page-root"]));
  });

  it("gives a full member the whole trash", async () => {
    h.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    await WorkspaceHome({ params: Promise.resolve({ slug: "acme" }) });

    expect(trashScope()).toBeNull();
  });
});
