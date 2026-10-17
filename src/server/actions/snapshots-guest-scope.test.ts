import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B02 — the snapshot actions honour the guest page scope.
 *
 * A snapshot carries the *previous* document of a page, so the two read
 * actions — `listPageSnapshotsAction` and `planPageSnapshotRestoreAction` —
 * handed a guest the full text of any page's history, one server-action call
 * away from the page-content read that is scoped. They now ask the same
 * question and answer "Page not found." for a page outside the scope.
 *
 * The real scope resolution runs here; only the transport edges are mocked.
 */

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  pageFindUnique: vi.fn(),
  pageFindMany: vi.fn(),
  pageVersionFindMany: vi.fn(),
  pageVersionFindUnique: vi.fn(),
  pagePermissionFindMany: vi.fn(),
  teamspaceMemberFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: h.pageFindUnique, findMany: h.pageFindMany },
    pageVersion: { findMany: h.pageVersionFindMany, findUnique: h.pageVersionFindUnique },
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

import { listPageSnapshotsAction, planPageSnapshotRestoreAction } from "./snapshots";

const SECRET_DOC = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "TOP SECRET PAYROLL" }] }],
};

/** The page row the actions read. */
function pageRow(id: string, deletedAt: Date | null = null) {
  return { id, workspaceId: "ws1", deletedAt };
}

/** The snapshot row the plan action reads. */
function versionRow(pageId: string) {
  return {
    id: "v1",
    pageId,
    title: "Board strategy",
    content: SECRET_DOC,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    label: null,
    createdById: "u2",
    page: { workspaceId: "ws1", content: SECRET_DOC, deletedAt: null },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue({ id: "u1" });
  h.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
  h.pageFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    pageRow(where.id),
  );
  h.pageVersionFindMany.mockResolvedValue([versionRow("page-secret")]);
  h.pageVersionFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    versionRow("page-secret"),
  );
  // The guest scope resolves for real: one shared page plus its ancestor.
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

describe("listPageSnapshotsAction", () => {
  it("refuses a page outside the guest scope and never reads a version", async () => {
    const result = await listPageSnapshotsAction("page-secret");

    expect(result).toEqual({ error: "Page not found." });
    expect(h.pageVersionFindMany).not.toHaveBeenCalled();
  });

  it("serves a page inside the guest scope", async () => {
    h.pageVersionFindMany.mockResolvedValue([versionRow("page-shared")]);

    const result = await listPageSnapshotsAction("page-shared");

    expect(result).toMatchObject({ ok: true });
  });

  it("refuses a trashed page", async () => {
    h.pageFindUnique.mockResolvedValue(pageRow("page-secret", new Date("2026-01-01")));

    const result = await listPageSnapshotsAction("page-secret");

    expect(result).toEqual({ error: "Page not found." });
    expect(h.pageVersionFindMany).not.toHaveBeenCalled();
  });

  it("gives a full member the whole workspace", async () => {
    h.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    const result = await listPageSnapshotsAction("page-secret");

    expect(result).toMatchObject({ ok: true });
  });
});

describe("planPageSnapshotRestoreAction", () => {
  it("refuses a snapshot of a page outside the guest scope", async () => {
    const result = await planPageSnapshotRestoreAction("v1");

    expect(result).toEqual({ error: "Page not found." });
  });

  it("serves a snapshot of a page inside the guest scope", async () => {
    h.pageVersionFindUnique.mockResolvedValue(versionRow("page-shared"));

    const result = await planPageSnapshotRestoreAction("v1");

    expect(result).toMatchObject({ ok: true, pageId: "page-shared" });
  });

  it("gives a full member the whole workspace", async () => {
    h.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    const result = await planPageSnapshotRestoreAction("v1");

    expect(result).toMatchObject({ ok: true, pageId: "page-secret" });
  });
});
