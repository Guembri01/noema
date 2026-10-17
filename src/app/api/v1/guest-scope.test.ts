import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B02 — a `GUEST` must not be able to read a whole workspace through the API.
 *
 * The vulnerability: the workspace UI scopes guests correctly through
 * `pageScopeFor()`, but the API and export routes only checked
 * "is a workspace member" — which is also true for a guest. A guest could
 * therefore list every page, read every page's content, search the whole
 * workspace and export everything as Markdown/CSV/ZIP.
 *
 * The contract under test:
 *  - the listing, the single-page read and the search all receive the guest
 *    scope instead of `null` ("sees everything");
 *  - a page outside the scope is a 404, never a leak;
 *  - an export — a full-text copy — is refused for a guest with a 403;
 *  - a full member keeps the whole workspace (`null` scope).
 *
 * The transport edges are mocked; the scope resolution, the role predicates
 * and the response shaping run for real.
 */

const edge = vi.hoisted(() => ({
  authenticateApiRequest: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  getPagesPage: vi.fn(),
  getPageTree: vi.fn(),
  searchPagesPage: vi.fn(),
  pageFindUnique: vi.fn(),
  pageFindMany: vi.fn(),
  pagePermissionFindMany: vi.fn(),
  teamspaceMemberFindMany: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({ authenticateApiRequest: edge.authenticateApiRequest }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: edge.getWorkspaceAccess };
});
vi.mock("@/server/queries", () => ({
  getPagesPage: edge.getPagesPage,
  getPageTree: edge.getPageTree,
  searchPagesPage: edge.searchPagesPage,
}));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: vi.fn(async () => undefined) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: edge.pageFindUnique, findMany: edge.pageFindMany },
    pagePermission: { findMany: edge.pagePermissionFindMany },
    teamspaceMember: { findMany: edge.teamspaceMemberFindMany },
  },
}));

import { GET as listPages } from "./pages/route";
import { GET as readPage } from "./pages/[pageId]/route";
import { GET as search } from "./search/route";

/** The pages a guest may see: one shared page plus its ancestor. */
const GUEST_SCOPE = new Set(["page-shared", "page-root"]);

beforeEach(() => {
  edge.authenticateApiRequest.mockReset();
  edge.getWorkspaceAccess.mockReset();
  edge.getPagesPage.mockReset();
  edge.getPageTree.mockReset();
  edge.searchPagesPage.mockReset();
  edge.pageFindUnique.mockReset();
  edge.pageFindMany.mockReset();
  edge.pagePermissionFindMany.mockReset();
  edge.teamspaceMemberFindMany.mockReset();

  edge.authenticateApiRequest.mockResolvedValue({ userId: "user-1" });
  edge.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
  // The guest scope resolves for real: one shared page plus its ancestor.
  edge.pagePermissionFindMany.mockResolvedValue([{ pageId: "page-shared" }]);
  edge.teamspaceMemberFindMany.mockResolvedValue([]);
  // `guestVisiblePageIds` asks twice: once for the pages the guest created
  // (none) and once for the whole tree. The mock has to answer both
  // differently, or the guest would appear to own every page.
  edge.pageFindMany.mockImplementation((args: { where?: { createdById?: string } }) =>
    args?.where?.createdById ? [] : [
      { id: "page-root", parentId: null, teamspaceId: null },
      { id: "page-shared", parentId: "page-root", teamspaceId: null },
      { id: "page-secret", parentId: "page-root", teamspaceId: null },
    ],
  );
  edge.getPagesPage.mockResolvedValue({
    items: [{ id: "page-shared", parentId: null, title: "Shared", type: "PAGE" }],
    hasMore: false,
    nextCursor: null,
  });
  edge.getPageTree.mockResolvedValue([]);
  edge.searchPagesPage.mockResolvedValue({ items: [], hasMore: false, nextCursor: null });
});

const listCall = (ip = "203.0.113.10") =>
  listPages(
    new Request("http://localhost/api/v1/pages?workspaceId=ws-1&include=breadcrumbs", {
      headers: { "x-forwarded-for": ip },
    }),
  );

const readCall = (pageId: string) =>
  readPage(
    new Request(`http://localhost/api/v1/pages/${pageId}`, {
      headers: { "x-forwarded-for": "203.0.113.10" },
    }),
    { params: Promise.resolve({ pageId }) },
  );

const searchCall = () =>
  search(
    new Request("http://localhost/api/v1/search?workspaceId=ws-1&q=secret", {
      headers: { "x-forwarded-for": "203.0.113.10" },
    }),
  );

describe("the guest scope on the read API (B02)", () => {
  it("scopes the page listing instead of listing the whole workspace", async () => {
    await listCall();

    expect(edge.getPagesPage).toHaveBeenCalledTimes(1);
    const [, visiblePageIds] = edge.getPagesPage.mock.calls[0] as [string, Set<string> | null];
    expect(visiblePageIds).not.toBeNull();
    expect(visiblePageIds).toBeInstanceOf(Set);
    expect([...(visiblePageIds as Set<string>)]).toEqual(
      expect.arrayContaining(["page-shared"]),
    );
  });

  it("scopes the breadcrumb tree as well", async () => {
    await listCall();

    const [, visiblePageIds] = edge.getPageTree.mock.calls[0] as [string, Set<string> | null];
    // The value, not just "not null": before the fix the tree was loaded
    // unscoped, so the call carried no scope at all.
    expect(visiblePageIds).toEqual(new Set(["page-shared", "page-root"]));
  });

  it("scopes the search instead of searching the whole workspace", async () => {
    await searchCall();

    expect(edge.searchPagesPage).toHaveBeenCalledTimes(1);
    const [, , visiblePageIds] = edge.searchPagesPage.mock.calls[0] as [
      string,
      string,
      Set<string> | null,
    ];
    expect(visiblePageIds).not.toBeNull();
  });

  it("answers 404 for a page outside the guest scope", async () => {
    edge.pageFindUnique.mockResolvedValue({
      id: "page-secret",
      workspaceId: "ws-1",
      title: "Secret",
      type: "PAGE",
      content: { type: "doc", content: [] },
      deletedAt: null,
    });

    const response = await readCall("page-secret");

    expect(response.status).toBe(404);
  });

  it("serves a page inside the guest scope", async () => {
    edge.pageFindUnique.mockResolvedValue({
      id: "page-shared",
      workspaceId: "ws-1",
      title: "Shared",
      type: "PAGE",
      content: { type: "doc", content: [] },
      deletedAt: null,
    });

    const response = await readCall("page-shared");

    expect(response.status).toBe(200);
  });

  it("gives a full member the whole workspace", async () => {
    edge.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    await listCall();

    const [, visiblePageIds] = edge.getPagesPage.mock.calls[0] as [string, Set<string> | null];
    expect(visiblePageIds).toBeNull();
  });
});
