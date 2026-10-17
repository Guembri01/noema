import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B02 — a trashed page is not part of the guest scope.
 *
 * The scope was collected from the `PagePermission` rows without a
 * `deletedAt` filter, so a page that was shared and *then* trashed stayed in
 * the scope — while the page route and the read API answer 404 for it. The
 * scope now filters the trashed pages out, so the two answers agree.
 *
 * Only the Prisma edge is mocked; the scope resolution runs for real.
 */

const h = vi.hoisted(() => ({
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

import { guestVisiblePageIds, pageScopeFor } from "./guest-access";

beforeEach(() => {
  vi.clearAllMocks();
  // The database honours the `deletedAt: null` filter the query carries: the
  // permission on the trashed page only comes back when the query does not
  // ask for the live pages only.
  h.pagePermissionFindMany.mockImplementation(
    async (args: { where: { page: { deletedAt?: null } } }) =>
      args?.where?.page?.deletedAt === null
        ? [{ pageId: "page-live" }]
        : [{ pageId: "page-live" }, { pageId: "page-trashed" }],
  );
  h.teamspaceMemberFindMany.mockResolvedValue([]);
  h.pageFindMany.mockImplementation((args: { where?: { createdById?: string } }) =>
    args?.where?.createdById
      ? []
      : [
          { id: "page-root", parentId: null, teamspaceId: null },
          { id: "page-live", parentId: "page-root", teamspaceId: null },
        ],
  );
});

describe("guestVisiblePageIds", () => {
  it("excludes a trashed page, even one the guest was given", async () => {
    const visible = await guestVisiblePageIds("u1", "ws1");

    expect(visible.has("page-trashed")).toBe(false);
    expect(visible.has("page-live")).toBe(true);
  });

  it("asks for the live pages only", async () => {
    await guestVisiblePageIds("u1", "ws1");

    const [args] = h.pagePermissionFindMany.mock.calls[0] as [
      { where: { userId: string; page: { workspaceId: string; deletedAt: null } } },
    ];
    expect(args.where).toEqual({
      userId: "u1",
      page: { workspaceId: "ws1", deletedAt: null },
    });
  });
});

describe("pageScopeFor (guest)", () => {
  it("never widens to a trashed page", async () => {
    const scope = await pageScopeFor("u1", "ws1", "GUEST");

    expect(scope).not.toBeNull();
    expect((scope as Set<string>).has("page-trashed")).toBe(false);
  });
});
