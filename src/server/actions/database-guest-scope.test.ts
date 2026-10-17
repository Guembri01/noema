import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B95 — the database actions must honour the guest page scope.
 *
 * A guest may read a database only when it lies in their *read* scope: the
 * pages shared with them plus their whole subtree (the inheritance rule of
 * `access-inheritance.ts` — a grant covers the page itself and its
 * descendants, never its ancestors). `authorizeDatabase()` resolves the
 * workspace *membership* only, so before the fix a guest could list the
 * trashed rows of every database of the workspace — title, icon and deletion
 * time — through `listDeletedRowsAction`.
 *
 * Only the transport edges (prisma/auth/permissions/revalidation) are mocked —
 * the real scope computation (`lib/guest-access.ts`) and the real action logic
 * run.
 */

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  pageFindMany: vi.fn(),
  propertyFindUnique: vi.fn(),
  propertyUpdate: vi.fn(),
  teamspaceMemberFindMany: vi.fn(),
}));
const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
const perm = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: db.pageFindUnique, findMany: db.pageFindMany },
    property: { findUnique: db.propertyFindUnique, update: db.propertyUpdate },
    teamspaceMember: { findMany: db.teamspaceMemberFindMany },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: perm.getWorkspaceAccess,
  canEditContent: (role: string) => role !== "GUEST",
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { listDeletedRowsAction, updatePropertyAction } from "./database";

const WORKSPACE_ID = "ws-1";
const GUEST_ID = "guest-1";

type Fixture = {
  id: string;
  parentId: string | null;
  type: "PAGE" | "DATABASE";
  title: string;
};

/**
 * The workspace's tree. `db-1` holds the row `row-1`; `db-3` sits below the
 * ordinary page `parent-1`; `db-2` was never shared with anybody.
 */
const TREE: Fixture[] = [
  { id: "parent-1", parentId: null, type: "PAGE", title: "Parent" },
  { id: "db-1", parentId: null, type: "DATABASE", title: "Shared" },
  { id: "row-1", parentId: "db-1", type: "PAGE", title: "Row" },
  { id: "db-2", parentId: null, type: "DATABASE", title: "Private" },
  { id: "db-3", parentId: "parent-1", type: "DATABASE", title: "Inherited" },
];

/** The trashed rows of every database — the content the shelf hands out. */
const TRASHED_ROWS = [
  {
    id: "trash-1",
    parentId: "db-1",
    title: "Trashed customer",
    icon: "🗑️",
    deletedAt: new Date("2026-10-01T10:00:00.000Z"),
  },
  {
    id: "trash-2",
    parentId: "db-2",
    title: "Trashed secret",
    icon: null,
    deletedAt: new Date("2026-10-02T10:00:00.000Z"),
  },
  {
    id: "trash-3",
    parentId: "db-3",
    title: "Trashed inherited",
    icon: "📄",
    deletedAt: new Date("2026-10-03T10:00:00.000Z"),
  },
];

/** The guest's page grants: page id → permission levels. */
let grants: Record<string, string[]>;

/** The guest's own pages (empty in these fixtures). */
let ownPages: string[] = [];

/** The calls that hit the *content* query (the trashed rows of a database). */
function contentCalls(): unknown[][] {
  return db.pageFindMany.mock.calls.filter(([args]) => {
    const where = (args as { where?: Record<string, unknown> })?.where ?? {};
    return typeof where.parentId === "string";
  });
}

/** The calls that hit the *scope* query (`guestReadablePageIds`). */
function scopeCalls(): unknown[][] {
  return db.pageFindMany.mock.calls.filter(([args]) => {
    const where = (args as { where?: Record<string, unknown> })?.where ?? {};
    return typeof where.parentId !== "string";
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  grants = {};
  ownPages = [];

  auth.requireUser.mockResolvedValue({ id: GUEST_ID });
  perm.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
  db.teamspaceMemberFindMany.mockResolvedValue([]);

  db.pageFindMany.mockImplementation(async (args: { where?: Record<string, unknown> }) => {
    const where = args?.where ?? {};
    if (typeof where.parentId === "string") {
      // The trashed-rows query of `listDeletedRowsAction`.
      return TRASHED_ROWS.filter((row) => row.parentId === where.parentId);
    }
    // The scope query: every page of the workspace with this guest's grants.
    return TREE.map((page) => ({
      id: page.id,
      parentId: page.parentId,
      teamspaceId: null,
      createdById: ownPages.includes(page.id) ? GUEST_ID : "owner-1",
      permissions: (grants[page.id] ?? []).map((level) => ({ level })),
    }));
  });

  db.pageFindUnique.mockImplementation(async (args: { where: { id: string } }) => {
    const page = TREE.find((candidate) => candidate.id === args.where.id);
    if (!page) return null;
    return {
      id: page.id,
      workspaceId: WORKSPACE_ID,
      type: page.type,
      schemaLocked: false,
    };
  });

  db.propertyFindUnique.mockResolvedValue({ databasePageId: "db-2" });
});

describe("listDeletedRowsAction — guest scope", () => {
  it("hides a database the guest was never granted", async () => {
    grants = {};

    const result = await listDeletedRowsAction("db-2");

    expect(result).toEqual({ error: "Database not found." });
  });

  it("reads no content for a database outside the scope", async () => {
    grants = {};

    await listDeletedRowsAction("db-2");

    // The scope check stands in front of the content query: the trashed rows
    // of a foreign database are never read.
    expect(contentCalls()).toHaveLength(0);
  });

  it("answers an unknown id exactly like an out-of-scope database", async () => {
    grants = {};

    const missing = await listDeletedRowsAction("does-not-exist");
    const outOfScope = await listDeletedRowsAction("db-2");
    if (!("error" in missing) || !("error" in outOfScope)) {
      throw new Error("both answers must be a refusal");
    }

    // Byte-identical: the answer must not confirm that the database exists.
    expect(outOfScope.error).toBe(missing.error);
    expect(JSON.stringify(outOfScope)).toBe(JSON.stringify(missing));
    expect(missing).toEqual({ error: "Database not found." });
  });

  it("reads the trashed rows of a database that was shared with the guest", async () => {
    grants = { "db-1": ["READ"] };

    const result = await listDeletedRowsAction("db-1");

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.rows).toEqual([
      {
        id: "trash-1",
        title: "Trashed customer",
        icon: "🗑️",
        deletedAt: "2026-10-01T10:00:00.000Z",
      },
    ]);
  });

  it("hides a database whose only shared page is one of its rows", async () => {
    // The core of the finding: the row was shared, the database was not. The
    // database is an *ancestor* of the grant — inheritance runs downwards, so
    // it is not readable.
    grants = { "row-1": ["READ"] };

    const result = await listDeletedRowsAction("db-1");

    expect(result).toEqual({ error: "Database not found." });
    expect(contentCalls()).toHaveLength(0);
  });

  it("reads a database below a shared page (inheritance runs downwards)", async () => {
    grants = { "parent-1": ["READ"] };

    const result = await listDeletedRowsAction("db-3");

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.rows.map((row) => row.id)).toEqual(["trash-3"]);
  });

  it("leaves a member untouched and asks for no scope", async () => {
    perm.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    const result = await listDeletedRowsAction("db-2");

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.rows.map((row) => row.id)).toEqual(["trash-2"]);
    // A member sees the whole workspace: the scope is not computed at all.
    expect(scopeCalls()).toHaveLength(0);
  });

  it("keeps the refusal of a caller without any membership", async () => {
    perm.getWorkspaceAccess.mockResolvedValue(null);

    const result = await listDeletedRowsAction("db-2");

    expect(result).toEqual({ error: "No access to this database." });
    expect(contentCalls()).toHaveLength(0);
  });

  it("gives a role that is not a known workspace role no access at all", async () => {
    // Fail closed: only OWNER, ADMIN and MEMBER read a workspace unscoped —
    // every other role (a forged one, a stale one from an older schema) gets
    // no pages at all, even when the database was shared with the caller.
    grants = { "db-1": ["READ"] };
    perm.getWorkspaceAccess.mockResolvedValue({ role: "SUPERUSER" });

    const result = await listDeletedRowsAction("db-1");

    expect(result).toEqual({ error: "Database not found." });
    // The door closes before any read: neither the scope nor the content is
    // queried.
    expect(scopeCalls()).toHaveLength(0);
    expect(contentCalls()).toHaveLength(0);
  });

  it("gives an empty role no access at all", async () => {
    // The same fail-closed rule for a missing role: "" is not a workspace
    // role either.
    perm.getWorkspaceAccess.mockResolvedValue({ role: "" });

    const result = await listDeletedRowsAction("db-1");

    expect(result).toEqual({ error: "Database not found." });
    expect(scopeCalls()).toHaveLength(0);
    expect(contentCalls()).toHaveLength(0);
  });
});

describe("the write actions of the module — guest scope", () => {
  it("refuses a write to a database outside the scope with the same answer", async () => {
    // A guest may not write at all (`canEditContent`), but the refusal for a
    // database outside the scope is the scope's answer — it must not confirm
    // that the database exists.
    grants = {};

    const result = await updatePropertyAction("prop-1", { name: "Renamed" });

    expect(result).toEqual({ error: "Database not found." });
    expect(db.propertyUpdate).not.toHaveBeenCalled();
  });

  it("still refuses the write of a guest inside the scope with 'No permission.'", async () => {
    grants = { "db-2": ["READ"] };

    const result = await updatePropertyAction("prop-1", { name: "Renamed" });

    expect(result).toEqual({ error: "No permission." });
    expect(db.propertyUpdate).not.toHaveBeenCalled();
  });
});
