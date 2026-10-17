import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B02 — the workspace template gallery honours the guest page scope.
 *
 * A template carries the text of the row it was saved from, so the gallery
 * (the templates page and the home gallery, which both read it through
 * `listWorkspaceTemplatesAction`) handed a guest the body of every template
 * of every database of the workspace. The databases now carry the guest
 * scope: a guest only sees the templates of the databases they may open.
 *
 * The real scope resolution runs here; only the transport edges are mocked.
 */

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  pageFindMany: vi.fn(),
  templateFindMany: vi.fn(),
  pagePermissionFindMany: vi.fn(),
  teamspaceMemberFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findMany: h.pageFindMany },
    template: { findMany: h.templateFindMany },
    pagePermission: { findMany: h.pagePermissionFindMany },
    teamspaceMember: { findMany: h.teamspaceMemberFindMany },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: h.requireUser }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: h.getWorkspaceAccess };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { listWorkspaceTemplatesAction } from "./home-templates";

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue({ id: "u1" });
  h.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
  h.templateFindMany.mockResolvedValue([]);
  // The guest scope resolves for real: one shared page plus its ancestor.
  h.pagePermissionFindMany.mockResolvedValue([{ pageId: "page-shared" }]);
  h.teamspaceMemberFindMany.mockResolvedValue([]);
  // `prisma.page.findMany` serves three callers here — the guest's own pages,
  // the scope's tree and the database list — so the mock tells them apart by
  // their `select`.
  h.pageFindMany.mockImplementation((args: { select?: Record<string, unknown> }) => {
    const select = args?.select ?? {};
    if (select.title) return [{ id: "db-secret", title: "Payroll" }];
    if (select.parentId) {
      return [
        { id: "page-root", parentId: null, teamspaceId: null },
        { id: "page-shared", parentId: "page-root", teamspaceId: null },
        { id: "db-secret", parentId: "page-root", teamspaceId: null },
      ];
    }
    return [];
  });
});

/** The `where` clause the database list was queried with. */
function databaseWhere(): Record<string, unknown> {
  const call = h.pageFindMany.mock.calls.find(
    ([args]) => (args as { select?: { title?: boolean } }).select?.title === true,
  );
  expect(call).toBeDefined();
  return (call as [{ where: Record<string, unknown> }])[0].where;
}

describe("listWorkspaceTemplatesAction", () => {
  it("scopes the databases to the guest's pages", async () => {
    const result = await listWorkspaceTemplatesAction({ workspaceId: "ws1" });

    expect(result).toMatchObject({ ok: true });
    expect(databaseWhere()).toEqual({
      workspaceId: "ws1",
      type: "DATABASE",
      deletedAt: null,
      id: { in: ["page-shared", "page-root"] },
    });
  });

  it("gives a full member the whole workspace", async () => {
    h.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    const result = await listWorkspaceTemplatesAction({ workspaceId: "ws1" });

    expect(result).toMatchObject({ ok: true });
    expect(databaseWhere()).toEqual({
      workspaceId: "ws1",
      type: "DATABASE",
      deletedAt: null,
    });
  });
});
