import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Per-project role actions — the server side of the `project-detail.tsx` role
 * editor, driven by `@/lib/project-roles`. The real decision table runs
 * (`effectiveRole` → `canProjectAction` → `assignRole`/`removeMember`); only the
 * transport edges (prisma, auth, cache) are mocked. Pins the ceiling rule, the
 * last-owner guard and the legacy `CLIENT` → `viewer` read.
 */

const db = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  workspaceFindUnique: vi.fn(),
  projectFindUnique: vi.fn(),
  projectMemberFindMany: vi.fn(),
  projectMemberUpsert: vi.fn(),
  projectMemberDeleteMany: vi.fn(),
  workspaceMemberFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspaceMember: { findUnique: db.memberFindUnique, findMany: db.workspaceMemberFindMany },
    workspace: { findUnique: db.workspaceFindUnique },
    project: { findUnique: db.projectFindUnique },
    projectMember: {
      findMany: db.projectMemberFindMany,
      upsert: db.projectMemberUpsert,
      deleteMany: db.projectMemberDeleteMany,
    },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "actor-1" })) }));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  listProjectRolesAction,
  removeProjectRoleAction,
  setProjectRoleAction,
} from "./workspaces";

const PROJECT = { id: "p1", workspaceId: "ws-1", ownerId: "actor-1" };

beforeEach(() => {
  vi.clearAllMocks();
  db.projectFindUnique.mockResolvedValue(PROJECT);
  db.memberFindUnique.mockResolvedValue({ role: "OWNER" });
  db.projectMemberFindMany.mockResolvedValue([]);
  db.projectMemberUpsert.mockResolvedValue({});
  db.projectMemberDeleteMany.mockResolvedValue({ count: 1 });
  db.workspaceMemberFindMany.mockResolvedValue([
    { userId: "actor-1", role: "OWNER", user: { id: "actor-1", name: "Actor" } },
    { userId: "user-2", role: "MEMBER", user: { id: "user-2", name: "Bob" } },
  ]);
});

describe("listProjectRolesAction", () => {
  it("projects the roster onto the decision table and reports manage rights", async () => {
    db.projectMemberFindMany.mockResolvedValue([{ userId: "user-2", role: "editor" }]);
    const result = await listProjectRolesAction("p1");
    if ("error" in result) throw new Error(result.error);

    expect(result.actorRole).toBe("owner");
    expect(result.canManage).toBe(true);
    expect(result.roles.map((role) => role.id)).toContain("owner");
    const bob = result.members.find((member) => member.userId === "user-2");
    expect(bob?.role).toBe("editor");
    expect(bob?.source).toBe("project");
  });

  it("reads a legacy CLIENT row as viewer", async () => {
    db.projectMemberFindMany.mockResolvedValue([{ userId: "user-2", role: "CLIENT" }]);
    db.workspaceMemberFindMany.mockResolvedValue([
      { userId: "user-2", role: "GUEST", user: { id: "user-2", name: "Bob" } },
    ]);
    const result = await listProjectRolesAction("p1");
    if ("error" in result) throw new Error(result.error);
    expect(result.members.find((member) => member.userId === "user-2")?.role).toBe("viewer");
  });
});

describe("setProjectRoleAction", () => {
  it("lets the project owner assign a role", async () => {
    db.projectMemberFindMany.mockResolvedValue([{ userId: "actor-1", role: "owner" }]);
    await expect(setProjectRoleAction("p1", "user-2", "viewer")).resolves.toEqual({ ok: true });
    expect(db.projectMemberUpsert).toHaveBeenCalledWith({
      where: { projectId_userId: { projectId: "p1", userId: "user-2" } },
      create: { projectId: "p1", userId: "user-2", role: "viewer" },
      update: { role: "viewer" },
    });
  });

  it("refuses an editor (workspace member) who cannot manage members", async () => {
    db.memberFindUnique.mockResolvedValue({ role: "MEMBER" });
    await expect(setProjectRoleAction("p1", "user-2", "viewer")).resolves.toEqual({
      error: "You cannot manage this project's members.",
    });
    expect(db.projectMemberUpsert).not.toHaveBeenCalled();
  });

  it("refuses to demote the last owner", async () => {
    db.projectMemberFindMany.mockResolvedValue([{ userId: "actor-1", role: "owner" }]);
    await expect(setProjectRoleAction("p1", "actor-1", "viewer")).resolves.toEqual({
      error: "Cannot demote the last owner.",
    });
    expect(db.projectMemberUpsert).not.toHaveBeenCalled();
  });

  it("rejects an unknown role before touching prisma", async () => {
    await expect(setProjectRoleAction("p1", "user-2", "superuser")).resolves.toEqual({
      error: "That project role is not recognised.",
    });
    expect(db.projectFindUnique).not.toHaveBeenCalled();
  });
});

describe("removeProjectRoleAction", () => {
  it("removes a regular member", async () => {
    db.projectMemberFindMany.mockResolvedValue([{ userId: "user-2", role: "editor" }]);
    await expect(removeProjectRoleAction("p1", "user-2")).resolves.toEqual({ ok: true });
    expect(db.projectMemberDeleteMany).toHaveBeenCalledWith({
      where: { projectId: "p1", userId: "user-2" },
    });
  });

  it("refuses to remove the project owner", async () => {
    await expect(removeProjectRoleAction("p1", "actor-1")).resolves.toEqual({
      error: "Transfer project ownership before removing the owner.",
    });
    expect(db.projectMemberDeleteMany).not.toHaveBeenCalled();
  });

  it("refuses to remove the last owner (engine guard)", async () => {
    db.projectFindUnique.mockResolvedValue({ id: "p1", workspaceId: "ws-1", ownerId: null });
    db.memberFindUnique.mockResolvedValue({ role: "ADMIN" });
    db.projectMemberFindMany.mockResolvedValue([{ userId: "user-2", role: "owner" }]);
    await expect(removeProjectRoleAction("p1", "user-2")).resolves.toEqual({
      error: "Cannot remove the last owner.",
    });
    expect(db.projectMemberDeleteMany).not.toHaveBeenCalled();
  });
});
