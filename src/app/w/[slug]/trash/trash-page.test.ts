import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B02 — the trash page hands the trash the guest scope.
 *
 * The trash lists page *titles*, and the query was filtered by workspace only,
 * so a guest saw the titles of every archived page of the workspace. The
 * scope now travels with the query (`getTrash` takes it as a required
 * argument), and the page resolves it with `pageScopeFor` — the same scope the
 * library page and the page route use.
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

import TrashPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue({ id: "u1", locale: "en" });
  h.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
  h.getWorkspaceBySlug.mockResolvedValue({ id: "ws1", name: "Acme", slug: "acme" });
  h.getTrash.mockResolvedValue([]);
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

/** The scope the trash was loaded with. */
function trashScope(): Set<string> | null | undefined {
  const [, scope] = h.getTrash.mock.calls[0] as [string, Set<string> | null];
  return scope;
}

describe("the trash page", () => {
  it("loads the trash with the guest scope, not the whole workspace", async () => {
    await TrashPage({ params: Promise.resolve({ slug: "acme" }) });

    expect(h.getTrash).toHaveBeenCalledTimes(1);
    expect(trashScope()).toEqual(new Set(["page-shared", "page-root"]));
  });

  it("gives a full member the whole trash", async () => {
    h.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    await TrashPage({ params: Promise.resolve({ slug: "acme" }) });

    expect(trashScope()).toBeNull();
  });
});
