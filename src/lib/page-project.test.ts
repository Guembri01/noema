import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B127 — the project scope guard (`src/lib/page-project.ts`).
 *
 * `Page.projectId` is a plain foreign key, so the application is the only
 * thing that keeps a page inside its own workspace. These tests pin the one
 * helper every write path uses for that: a project is only accepted when it
 * lives in the caller's workspace, and the rejection never names a foreign
 * project.
 */

const db = vi.hoisted(() => ({ projectFindFirst: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { project: { findFirst: db.projectFindFirst } },
}));

import { assertScopedProject, INVALID_PROJECT_ERROR } from "./page-project";

/** The projects that exist in the fake database, across two workspaces. */
const PROJECTS = [
  { id: "project-own", workspaceId: "ws-1" },
  { id: "project-foreign", workspaceId: "ws-2" },
];

beforeEach(() => {
  vi.clearAllMocks();
  // The helper's lookup is tenant-scoped in the query, so a project of
  // another workspace exists but is never returned.
  db.projectFindFirst.mockImplementation(
    async (args: { where: { id: string; workspaceId: string } }) => {
      const row = PROJECTS.find(
        (project) => project.id === args.where.id && project.workspaceId === args.where.workspaceId,
      );
      return row ? { id: row.id } : null;
    },
  );
});

describe("assertScopedProject", () => {
  it("accepts a project of the caller's workspace", async () => {
    const result = await assertScopedProject({
      workspaceId: "ws-1",
      projectId: "project-own",
    });
    expect(result).toEqual({ ok: true, projectId: "project-own" });
  });

  it("refuses a project of another workspace", async () => {
    const result = await assertScopedProject({
      workspaceId: "ws-1",
      projectId: "project-foreign",
    });
    expect(result).toEqual({ error: INVALID_PROJECT_ERROR });
  });

  it("does not name the foreign project", async () => {
    const result = await assertScopedProject({
      workspaceId: "ws-1",
      projectId: "project-foreign",
    });
    expect("error" in result ? result.error : "").not.toContain("project-foreign");
  });

  it("refuses a project that does not exist", async () => {
    const result = await assertScopedProject({
      workspaceId: "ws-1",
      projectId: "project-nowhere",
    });
    expect(result).toEqual({ error: INVALID_PROJECT_ERROR });
  });

  it("accepts a write without a project", async () => {
    for (const projectId of [undefined, null, "", "   "]) {
      const result = await assertScopedProject({ workspaceId: "ws-1", projectId });
      expect(result).toEqual({ ok: true, projectId: null });
    }
    expect(db.projectFindFirst).not.toHaveBeenCalled();
  });

  it("asks the query with the workspace of the caller", async () => {
    await assertScopedProject({ workspaceId: "ws-1", projectId: "project-own" });
    expect(db.projectFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "project-own", workspaceId: "ws-1" },
      }),
    );
  });
});
