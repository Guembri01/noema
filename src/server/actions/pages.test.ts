import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B127 — `createPageAction` must not write a project of another workspace.
 *
 * `Page.projectId` is a plain foreign key: the schema carries no composite
 * `(projectId, workspaceId)` constraint, so the *application* is the only
 * thing that keeps a page inside its own workspace. The action therefore
 * passes the project through the scope guard before it is stored — and the
 * page is not written at all when the project belongs to another tenant.
 */

const db = vi.hoisted(() => ({
  memberFindFirst: vi.fn(),
  workspaceFindUnique: vi.fn(),
  pageFindFirst: vi.fn(),
  pageCreate: vi.fn(),
  projectFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: { findFirst: db.memberFindFirst },
    workspace: { findUnique: db.workspaceFindUnique },
    page: { findFirst: db.pageFindFirst, create: db.pageCreate },
    project: { findFirst: db.projectFindFirst },
  },
}));

vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "user-1", email: "member@example.test" }),
}));

vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: async () => ({ role: "MEMBER" }),
  canEditContent: () => true,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn() }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: vi.fn() }));

import { createPageAction } from "./pages";

/** The projects that exist in the fake database, across two workspaces. */
const PROJECTS = [
  { id: "project-own", workspaceId: "ws-1" },
  { id: "project-foreign", workspaceId: "ws-2" },
];

beforeEach(() => {
  vi.clearAllMocks();
  db.workspaceFindUnique.mockResolvedValue({ slug: "team" });
  db.pageFindFirst.mockResolvedValue(null);
  db.pageCreate.mockResolvedValue({ id: "page-1" });
  db.projectFindFirst.mockImplementation(
    async (args: { where: { id: string; workspaceId: string } }) => {
      const row = PROJECTS.find(
        (project) => project.id === args.where.id && project.workspaceId === args.where.workspaceId,
      );
      return row ? { id: row.id } : null;
    },
  );
});

describe("createPageAction", () => {
  it("writes a page into a project of the caller's workspace", async () => {
    const result = await createPageAction({
      workspaceId: "ws-1",
      title: "Notes",
      projectId: "project-own",
    });

    expect(result).toEqual({ ok: true, id: "page-1", slug: "team" });
    expect(db.pageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ projectId: "project-own" }),
      }),
    );
  });

  it("refuses a project of another workspace and writes nothing", async () => {
    const result = await createPageAction({
      workspaceId: "ws-1",
      title: "Notes",
      projectId: "project-foreign",
    });

    expect("error" in result ? result.error : "").toBe(
      "That project does not exist in this workspace.",
    );
    expect(db.pageCreate).not.toHaveBeenCalled();
  });

  it("does not name the foreign project", async () => {
    const result = await createPageAction({
      workspaceId: "ws-1",
      projectId: "project-foreign",
    });

    expect("error" in result ? result.error : "").not.toContain("project-foreign");
  });

  it("creates a page without a project", async () => {
    const result = await createPageAction({ workspaceId: "ws-1", title: "Notes" });

    expect(result).toEqual({ ok: true, id: "page-1", slug: "team" });
    expect(db.pageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ projectId: expect.anything() }),
      }),
    );
  });
});
