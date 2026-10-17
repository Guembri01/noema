import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B116 — a removed workspace member must not keep a project role.
 *
 * The `projectMember` row carries a project-scoped role. It is written by
 * `setProjectRoleAction` and by the project-scoped invitation, and it was only
 * ever deleted by `removeProjectRoleAction` — never by the removal from the
 * workspace. The roster reads the row without a workspace baseline
 * (`listMembers` takes the override even for a person who is no longer a
 * member), so a removed member stood in the project roster with their old
 * role and got it back at the next invitation.
 *
 * The real engine runs here (`listMembers`, `getWorkspaceAccess`,
 * `canPerformWorkspaceAction`); only the transport edges (prisma, auth,
 * activity, cache) are mocked. The prisma double keeps the rows in memory, so
 * the roster read after the removal answers what a database would answer.
 */

const state = vi.hoisted(() => ({
  users: [] as { id: string; name: string | null }[],
  workspaces: [] as { id: string; ownerId: string }[],
  members: [] as { id: string; workspaceId: string; userId: string; role: string }[],
  projects: [] as { id: string; workspaceId: string; ownerId: string | null }[],
  projectMembers: [] as { projectId: string; userId: string; role: string }[],
}));

const auth = vi.hoisted(() => ({ userId: "owner-1" }));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.workspaces.find((workspace) => workspace.id === where.id) ?? null,
    },
    workspaceMember: {
      findUnique: async ({
        where,
      }: {
        where: { workspaceId_userId: { workspaceId: string; userId: string } };
      }) => {
        const key = where.workspaceId_userId;
        const row = state.members.find(
          (member) => member.workspaceId === key.workspaceId && member.userId === key.userId,
        );
        return row ? { role: row.role } : null;
      },
      findFirst: async ({ where }: { where: { workspaceId: string; userId: string } }) => {
        const row = state.members.find(
          (member) => member.workspaceId === where.workspaceId && member.userId === where.userId,
        );
        return row ? { id: row.id, role: row.role } : null;
      },
      findMany: async ({ where }: { where: { workspaceId: string } }) =>
        state.members
          .filter((member) => member.workspaceId === where.workspaceId)
          .map((member) => ({
            userId: member.userId,
            role: member.role,
            user: {
              id: member.userId,
              name: state.users.find((user) => user.id === member.userId)?.name ?? null,
            },
          })),
      delete: async ({ where }: { where: { id: string } }) => {
        const index = state.members.findIndex((member) => member.id === where.id);
        if (index < 0) throw new Error(`no workspace member ${where.id}`);
        const [row] = state.members.splice(index, 1);
        return row;
      },
    },
    project: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.projects.find((project) => project.id === where.id) ?? null,
    },
    projectMember: {
      findMany: async ({ where }: { where: { projectId: string } }) =>
        state.projectMembers
          .filter((row) => row.projectId === where.projectId)
          .map((row) => ({ userId: row.userId, role: row.role })),
      deleteMany: async ({
        where,
      }: {
        where: { userId: string; project?: { workspaceId: string } };
      }) => {
        const kept = state.projectMembers.filter((row) => {
          if (row.userId !== where.userId) return true;
          const project = state.projects.find((entry) => entry.id === row.projectId);
          if (where.project?.workspaceId && project?.workspaceId !== where.project.workspaceId) {
            return true;
          }
          return false;
        });
        const count = state.projectMembers.length - kept.length;
        state.projectMembers = kept;
        return { count };
      },
    },
    pagePermission: { deleteMany: async () => ({ count: 0 }) },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: auth.userId }) }));
vi.mock("@/lib/activity", () => ({ logActivity: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import {
  leaveWorkspaceAction,
  listProjectRolesAction,
  removeMemberAction,
} from "./workspaces";

const OWNER = "owner-1";
const MEMBER = "member-2";
const STAYER = "member-3";

/** The project roster of `p-1`, read by the workspace owner. */
async function roster() {
  const result = await listProjectRolesAction("p-1");
  if ("error" in result) throw new Error(result.error);
  return result.members;
}

beforeEach(() => {
  state.users = [
    { id: OWNER, name: "Ada" },
    { id: MEMBER, name: "Bob" },
    { id: STAYER, name: "Cleo" },
  ];
  state.workspaces = [
    { id: "ws-1", ownerId: OWNER },
    { id: "ws-2", ownerId: OWNER },
  ];
  state.members = [
    { id: "m-1", workspaceId: "ws-1", userId: OWNER, role: "OWNER" },
    { id: "m-2", workspaceId: "ws-1", userId: MEMBER, role: "MEMBER" },
    { id: "m-3", workspaceId: "ws-1", userId: STAYER, role: "GUEST" },
    { id: "m-4", workspaceId: "ws-2", userId: MEMBER, role: "MEMBER" },
  ];
  state.projects = [
    { id: "p-1", workspaceId: "ws-1", ownerId: OWNER },
    { id: "p-2", workspaceId: "ws-2", ownerId: OWNER },
  ];
  state.projectMembers = [
    { projectId: "p-1", userId: MEMBER, role: "editor" },
    { projectId: "p-2", userId: MEMBER, role: "editor" },
  ];
  auth.userId = OWNER;
});

describe("removeMemberAction", () => {
  it("takes the removed member out of the project roster", async () => {
    await expect(removeMemberAction("ws-1", MEMBER)).resolves.toEqual({ ok: true });

    expect((await roster()).filter((member) => member.userId === MEMBER)).toEqual([]);
  });

  it("drops the project rows of the removed member", async () => {
    await expect(removeMemberAction("ws-1", MEMBER)).resolves.toEqual({ ok: true });

    expect(state.projectMembers.filter((row) => row.projectId === "p-1")).toEqual([]);
  });

  it("keeps the project roles the member holds in another workspace", async () => {
    await expect(removeMemberAction("ws-1", MEMBER)).resolves.toEqual({ ok: true });

    expect(state.projectMembers).toEqual([{ projectId: "p-2", userId: MEMBER, role: "editor" }]);
  });

  it("keeps the project roles of the members who stay", async () => {
    state.projectMembers.push({ projectId: "p-1", userId: STAYER, role: "commenter" });

    await expect(removeMemberAction("ws-1", MEMBER)).resolves.toEqual({ ok: true });

    expect(state.projectMembers).toEqual([
      { projectId: "p-2", userId: MEMBER, role: "editor" },
      { projectId: "p-1", userId: STAYER, role: "commenter" },
    ]);
    expect((await roster()).filter((member) => member.userId === STAYER)).toEqual([
      {
        userId: STAYER,
        name: "Cleo",
        role: "commenter",
        permissions: ["view", "comment"],
        source: "project",
      },
    ]);
  });

  it("still removes the workspace membership and keeps the other ones", async () => {
    await expect(removeMemberAction("ws-1", MEMBER)).resolves.toEqual({ ok: true });

    expect(state.members.map((member) => `${member.workspaceId}:${member.userId}`)).toEqual([
      "ws-1:owner-1",
      "ws-1:member-3",
      "ws-2:member-2",
    ]);
  });
});

describe("leaveWorkspaceAction", () => {
  it("takes the member out of the project roster", async () => {
    auth.userId = MEMBER;

    await expect(leaveWorkspaceAction("ws-1")).resolves.toEqual({ ok: true });

    auth.userId = OWNER;
    expect((await roster()).filter((member) => member.userId === MEMBER)).toEqual([]);
  });

  it("drops the project rows of the member who left", async () => {
    auth.userId = MEMBER;

    await expect(leaveWorkspaceAction("ws-1")).resolves.toEqual({ ok: true });

    expect(state.projectMembers.filter((row) => row.projectId === "p-1")).toEqual([]);
  });
});
