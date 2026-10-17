import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B115 — the teamspace membership must not outlive the workspace membership.
 *
 * The `teamspaceMember` row is written by the three ways into a teamspace:
 * `addTeamspaceMemberAction` (`actions/teamspaces.ts:63`), the invitation for
 * a workspace member (`actions/teamspace-invites.ts:88`) and the acceptance of
 * an invitation (`actions/teamspace-invites.ts:251`). It was deleted only when
 * the **teamspace** was left (`actions/teamspaces.ts:86`) — never when the
 * person was removed from the workspace. The guest scope takes the pages of a
 * teamspace from that row (`lib/guest-access.ts:95-97`, `:109-115`), so a
 * removed person who is invited again as a guest gets the pages of the
 * teamspace in the scope right away, without anybody granting them again.
 *
 * Only the transport edges are mocked (`@/lib/db`, `@/lib/auth`,
 * `@/lib/activity`, `next/cache`): the real action, the real permission chain
 * (`getWorkspaceAccess` → `canPerformWorkspaceAction`) and the real scope
 * computation (`lib/guest-access.ts`) run. The prisma mock is an in-memory
 * store that applies the filters the database would apply — a `where` on the
 * workspace really excludes the rows of another workspace and a nested relation
 * filter (`teamspace: { workspaceId }`) really narrows the result — so the
 * scope measured here is the scope the database would hand out.
 */

type Row = Record<string, unknown>;

/** The in-memory store the prisma mock reads from. */
const h = vi.hoisted(() => {
  const tables: Record<string, Row[]> = {
    workspace: [],
    workspaceMember: [],
    teamspace: [],
    teamspaceMember: [],
    page: [],
    pagePermission: [],
    // The other membership rows the removal deletes as well (the findings
    // B37, B115 and B116) — the mock has to offer them.
    pageFollow: [],
    favorite: [],
    projectMember: [],
    project: [],
  };
  /** Every call the mock received — the queries the code under test ran. */
  const calls: { model: string; op: string; args: Row }[] = [];
  return { tables, calls };
});

const auth = vi.hoisted(() => ({
  /** The actor — the seam the test switches. */
  requireUser: vi.fn(async () => ({ id: "user-owner" })),
}));

vi.mock("@/lib/db", () => {
  const TABLES = h.tables;

  type Model = string;

  /** The relations the queries use — a belongs-to join. */
  const RELATIONS: Record<string, Record<string, { model: Model; key: string }>> = {
    pagePermission: { page: { model: "page", key: "pageId" } },
    teamspaceMember: { teamspace: { model: "teamspace", key: "teamspaceId" } },
    pageFollow: { page: { model: "page", key: "pageId" } },
    favorite: { page: { model: "page", key: "pageId" } },
    projectMember: { project: { model: "project", key: "projectId" } },
  };

  const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  /** The joined row of a belongs-to relation (null when the row is gone). */
  const relatedRow = (model: Model, row: Row, name: string): Row | null => {
    const spec = RELATIONS[model]?.[name];
    if (!spec) return null;
    return TABLES[spec.model].find((entry) => entry.id === row[spec.key]) ?? null;
  };

  /** A single column filter: equality or `null`. */
  const matchesScalar = (value: unknown, condition: unknown): boolean => {
    if (condition === null) return value === null || value === undefined;
    return value === condition;
  };

  /** The `where` interpreter — the heart of the mock. */
  const matchesWhere = (model: Model, row: Row, where: unknown): boolean => {
    if (!isPlainObject(where)) return true;
    for (const [key, condition] of Object.entries(where)) {
      const spec = RELATIONS[model]?.[key];
      if (spec) {
        // A relation filter: the joined row has to match the condition.
        const related = relatedRow(model, row, key);
        if (!related || !matchesWhere(spec.model, related, condition)) return false;
        continue;
      }
      if (!matchesScalar(row[key], condition)) return false;
    }
    return true;
  };

  /** The `select` projection of one row. */
  const project = (row: Row, select?: unknown): Row => {
    if (!isPlainObject(select)) return { ...row };
    const out: Row = {};
    for (const [name, wanted] of Object.entries(select)) {
      if (!wanted) continue;
      out[name] = row[name];
    }
    return out;
  };

  /** The `where` of a unique lookup: a plain id or a compound key. */
  const uniqueWhere = (where: unknown): Row => {
    if (!isPlainObject(where)) return {};
    const keys = Object.keys(where);
    if (keys.length !== 1) return where;
    // A compound unique (`workspaceId_userId`) carries its fields nested.
    const value = where[keys[0]];
    if (keys[0].includes("_") && isPlainObject(value)) return { ...value };
    return where;
  };

  const findMany = async (model: Model, args: Record<string, unknown> = {}) => {
    h.calls.push({ model, op: "findMany", args });
    const rows = TABLES[model].filter((row) => matchesWhere(model, row, args.where));
    return rows.map((row) => project(row, args.select));
  };

  const findFirst = async (model: Model, args: Record<string, unknown> = {}) => {
    h.calls.push({ model, op: "findFirst", args });
    const rows = await findMany(model, args);
    return rows[0] ?? null;
  };

  const findUnique = async (model: Model, args: Record<string, unknown> = {}) => {
    h.calls.push({ model, op: "findUnique", args });
    const rows = await findMany(model, { where: uniqueWhere(args.where) });
    return rows[0] ?? null;
  };

  const deleteRow = async (model: Model, args: Record<string, unknown> = {}) => {
    h.calls.push({ model, op: "delete", args });
    const where = uniqueWhere(args.where);
    const index = TABLES[model].findIndex((row) => matchesWhere(model, row, where));
    if (index < 0) throw new Error("An operation was called on a record that does not exist.");
    const [row] = TABLES[model].splice(index, 1);
    return row;
  };

  const deleteMany = async (model: Model, args: Record<string, unknown> = {}) => {
    h.calls.push({ model, op: "deleteMany", args });
    const rows = TABLES[model];
    const keep = rows.filter((row) => !matchesWhere(model, row, args.where));
    const count = rows.length - keep.length;
    rows.length = 0;
    rows.push(...keep);
    return { count };
  };

  return {
    prisma: {
      workspace: { findUnique: (args: Record<string, unknown>) => findUnique("workspace", args) },
      workspaceMember: {
        findFirst: (args: Record<string, unknown>) => findFirst("workspaceMember", args),
        findUnique: (args: Record<string, unknown>) => findUnique("workspaceMember", args),
        delete: (args: Record<string, unknown>) => deleteRow("workspaceMember", args),
      },
      teamspace: { findMany: (args: Record<string, unknown>) => findMany("teamspace", args) },
      teamspaceMember: {
        findMany: (args: Record<string, unknown>) => findMany("teamspaceMember", args),
        deleteMany: (args: Record<string, unknown>) => deleteMany("teamspaceMember", args),
      },
      page: { findMany: (args: Record<string, unknown>) => findMany("page", args) },
      pagePermission: {
        findMany: (args: Record<string, unknown>) => findMany("pagePermission", args),
        deleteMany: (args: Record<string, unknown>) => deleteMany("pagePermission", args),
      },
      pageFollow: {
        deleteMany: (args: Record<string, unknown>) => deleteMany("pageFollow", args),
      },
      favorite: {
        deleteMany: (args: Record<string, unknown>) => deleteMany("favorite", args),
      },
      project: { findMany: (args: Record<string, unknown>) => findMany("project", args) },
      projectMember: {
        deleteMany: (args: Record<string, unknown>) => deleteMany("projectMember", args),
      },
    },
  };
});

vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { guestScope } from "@/lib/guest-access";
import { leaveWorkspaceAction, removeMemberAction } from "./workspaces";

const WORKSPACE_ID = "ws-1";
const OTHER_WORKSPACE_ID = "ws-2";
const OWNER_ID = "user-owner";
const GUEST_ID = "user-guest";
const MEMBER_ID = "user-member";

/**
 * The workspace under test:
 *
 *   ts-1 (teamspace)          ts-2 (teamspace of another workspace)
 *   ├── page-root
 *   └── page-teamspace
 *
 *   page-private              (an ordinary page, never granted)
 */
function seed() {
  for (const table of Object.values(h.tables)) table.length = 0;
  h.calls.length = 0;

  h.tables.workspace.push(
    { id: WORKSPACE_ID, ownerId: OWNER_ID, name: "Workspace" },
    { id: OTHER_WORKSPACE_ID, ownerId: OWNER_ID, name: "Other workspace" },
  );

  h.tables.workspaceMember.push(
    { id: "wm-owner", workspaceId: WORKSPACE_ID, userId: OWNER_ID, role: "OWNER" },
    { id: "wm-guest", workspaceId: WORKSPACE_ID, userId: GUEST_ID, role: "GUEST" },
    { id: "wm-member", workspaceId: WORKSPACE_ID, userId: MEMBER_ID, role: "MEMBER" },
  );

  h.tables.teamspace.push(
    { id: "ts-1", workspaceId: WORKSPACE_ID, name: "Teamspace" },
    { id: "ts-2", workspaceId: OTHER_WORKSPACE_ID, name: "Other teamspace" },
  );

  h.tables.teamspaceMember.push(
    { id: "tm-guest", teamspaceId: "ts-1", userId: GUEST_ID, role: "MEMBER" },
    { id: "tm-member", teamspaceId: "ts-1", userId: MEMBER_ID, role: "MEMBER" },
    // A teamspace of another workspace — the removal must not reach it.
    { id: "tm-guest-other", teamspaceId: "ts-2", userId: GUEST_ID, role: "MEMBER" },
  );

  // The pages belong to the owner, so the only way into them is the teamspace
  // membership — the scope below is the teamspace's pages and nothing else.
  h.tables.page.push(
    { id: "page-root", parentId: null, teamspaceId: "ts-1", workspaceId: WORKSPACE_ID, deletedAt: null, createdById: OWNER_ID },
    { id: "page-teamspace", parentId: "page-root", teamspaceId: "ts-1", workspaceId: WORKSPACE_ID, deletedAt: null, createdById: OWNER_ID },
    { id: "page-private", parentId: null, teamspaceId: null, workspaceId: WORKSPACE_ID, deletedAt: null, createdById: OWNER_ID },
  );
}

/** The page scope of a viewer in the workspace — the real computation. */
async function scopeOf(userId: string): Promise<string[]> {
  const scope = await guestScope(userId, WORKSPACE_ID);
  return [...scope.pageIds].sort();
}

/** The teamspace scope of a viewer — the names the viewer may see. */
async function teamspaceScopeOf(userId: string): Promise<string[]> {
  const scope = await guestScope(userId, WORKSPACE_ID);
  return [...scope.teamspaceIds].sort();
}

/** The teamspace rows of a user in the workspace under test. */
function teamspaceRowsOf(userId: string): Row[] {
  return h.tables.teamspaceMember.filter(
    (row) => row.userId === userId && row.teamspaceId === "ts-1",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUser.mockResolvedValue({ id: OWNER_ID });
  seed();
});

describe("removeMemberAction — the teamspace membership dies with the workspace membership", () => {
  it("takes the teamspace rows of the removed member with it", async () => {
    await expect(removeMemberAction(WORKSPACE_ID, GUEST_ID)).resolves.toEqual({ ok: true });

    // The teamspace row of the removed member is gone ...
    expect(teamspaceRowsOf(GUEST_ID)).toEqual([]);
    // ... the row of the remaining member stays ...
    expect(teamspaceRowsOf(MEMBER_ID)).toHaveLength(1);
    // ... and the row of the teamspace in the other workspace is untouched.
    expect(h.tables.teamspaceMember.some((row) => row.id === "tm-guest-other")).toBe(true);
  });

  it("deletes the teamspace rows with the workspace as the filter", async () => {
    await removeMemberAction(WORKSPACE_ID, GUEST_ID);

    const deletion = h.calls.find(
      (call) => call.model === "teamspaceMember" && call.op === "deleteMany",
    );
    expect(deletion?.args).toEqual({
      where: { userId: GUEST_ID, teamspace: { workspaceId: WORKSPACE_ID } },
    });
  });

  it("does not hand the teamspace pages back at the next invitation", async () => {
    // Before the removal the scope of the guest is the teamspace's pages.
    expect(await scopeOf(GUEST_ID)).toEqual(["page-root", "page-teamspace"]);

    await removeMemberAction(WORKSPACE_ID, GUEST_ID);

    // The invitation writes the workspace membership again (`actions/email.ts:567`).
    h.tables.workspaceMember.push({
      id: "wm-guest-2",
      workspaceId: WORKSPACE_ID,
      userId: GUEST_ID,
      role: "GUEST",
    });

    // Nobody granted the teamspace pages again — the scope stays empty.
    expect(await scopeOf(GUEST_ID)).toEqual([]);
    // The name of the teamspace does not travel to the re-invited guest either.
    expect(await teamspaceScopeOf(GUEST_ID)).toEqual([]);
  });

  it("leaves the remaining member's scope and the pages of the workspace untouched", async () => {
    await removeMemberAction(WORKSPACE_ID, GUEST_ID);

    // The member who stays keeps the teamspace pages.
    expect(await scopeOf(MEMBER_ID)).toEqual(["page-root", "page-teamspace"]);
    // The pages stay in the workspace — only the membership rows are deleted.
    expect(h.tables.page.map((row) => row.id).sort()).toEqual([
      "page-private",
      "page-root",
      "page-teamspace",
    ]);
    // The teamspace itself stays.
    expect(h.tables.teamspace.some((row) => row.id === "ts-1")).toBe(true);
  });

  it("deletes nothing when the removal is refused", async () => {
    auth.requireUser.mockResolvedValue({ id: MEMBER_ID });

    await expect(removeMemberAction(WORKSPACE_ID, GUEST_ID)).resolves.toEqual({
      error: "You do not have permission to remove members.",
    });
    expect(h.tables.teamspaceMember).toHaveLength(3);
  });
});

describe("leaveWorkspaceAction — the same for the person who leaves by themselves", () => {
  it("takes the teamspace rows with it", async () => {
    auth.requireUser.mockResolvedValue({ id: GUEST_ID });

    await expect(leaveWorkspaceAction(WORKSPACE_ID)).resolves.toEqual({ ok: true });

    expect(teamspaceRowsOf(GUEST_ID)).toEqual([]);
    // The row of the teamspace in the other workspace is untouched.
    expect(h.tables.teamspaceMember.some((row) => row.id === "tm-guest-other")).toBe(true);
  });

  it("does not hand the teamspace pages back at the next invitation", async () => {
    auth.requireUser.mockResolvedValue({ id: GUEST_ID });

    // Before the departure the scope of the guest is the teamspace's pages.
    expect(await scopeOf(GUEST_ID)).toEqual(["page-root", "page-teamspace"]);

    await leaveWorkspaceAction(WORKSPACE_ID);

    // The invitation writes the workspace membership again (`actions/email.ts:567`).
    h.tables.workspaceMember.push({
      id: "wm-guest-2",
      workspaceId: WORKSPACE_ID,
      userId: GUEST_ID,
      role: "GUEST",
    });

    expect(await scopeOf(GUEST_ID)).toEqual([]);
    // The name of the teamspace does not travel to the re-invited guest either.
    expect(await teamspaceScopeOf(GUEST_ID)).toEqual([]);
  });
});
