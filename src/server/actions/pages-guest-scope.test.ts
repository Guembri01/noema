import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B02 — the page-content action honours the guest scope.
 *
 * `GET /api/v1/pages/[pageId]` answers 404 for a page outside the guest's
 * scope, but the server action behind the client components (`getPageContent-
 * Action`) only asked "is a workspace member" — which is also true for a guest
 * — so the same document was readable one request away.
 *
 * The real scope resolution runs here (`pageScopeFor` → `guestVisiblePageIds`);
 * only the transport edges (prisma, auth, the workspace access) are mocked.
 */

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  pageFindUnique: vi.fn(),
  pageFindMany: vi.fn(),
  pagePermissionFindMany: vi.fn(),
  teamspaceMemberFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: h.pageFindUnique, findMany: h.pageFindMany },
    pagePermission: { findMany: h.pagePermissionFindMany },
    teamspaceMember: { findMany: h.teamspaceMemberFindMany },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: h.requireUser }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: h.getWorkspaceAccess };
});
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: vi.fn(async () => undefined) }));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("@/server/actions/notifications", () => ({ notifyPageUpdated: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getPageContentAction } from "./pages";

const SECRET_CONTENT = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "TOP SECRET PAYROLL" }] }],
};

/** The page row the action reads (authorize + content lookup share the id). */
function pageRow(id: string) {
  return {
    id,
    workspaceId: "ws1",
    parentId: "page-root",
    deletedAt: null,
    title: id === "page-secret" ? "Board strategy" : "Shared notes",
    icon: null,
    content: SECRET_CONTENT,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue({ id: "u1" });
  h.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
  h.pageFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    pageRow(where.id),
  );
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

describe("getPageContentAction", () => {
  it("refuses a page outside the guest scope", async () => {
    const result = await getPageContentAction("page-secret");

    expect(result).toEqual({ error: "Page not found." });
  });

  it("serves a page inside the guest scope", async () => {
    const result = await getPageContentAction("page-shared");

    expect(result).toMatchObject({ id: "page-shared", title: "Shared notes" });
  });

  it("gives a full member the whole workspace", async () => {
    h.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    const result = await getPageContentAction("page-secret");

    expect(result).toMatchObject({ id: "page-secret", title: "Board strategy" });
  });

  it("reports a page the caller cannot reach at all", async () => {
    h.pageFindUnique.mockResolvedValue(null);

    const result = await getPageContentAction("page-missing");

    expect(result).toEqual({ error: "Page not found." });
  });

  it("refuses a trashed page, like the read API does", async () => {
    // A full member: the scope is the whole workspace, so only the trashed
    // check itself can refuse the page.
    h.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
    h.pageFindUnique.mockResolvedValue({ ...pageRow("page-trashed"), deletedAt: new Date() });

    const result = await getPageContentAction("page-trashed");

    expect(result).toEqual({ error: "Page not found." });
  });
});
