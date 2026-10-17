import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B90 — the linked-database actions must honour the guest page scope.
 *
 * A guest may read a database only when it lies in their *read* scope: the
 * pages shared with them plus their whole subtree (a grant covers the page
 * itself and its descendants, never its ancestors). Both actions are reachable
 * from the editor (`components/editor/extensions/linked-database.tsx`), so
 * without the scope a guest could list every database of the workspace and
 * read its rows.
 *
 * Only the transport edges (prisma/auth/permissions/queries) are mocked — the
 * real scope computation (`lib/guest-access.ts`) and the real action logic run.
 */

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  pageFindMany: vi.fn(),
  teamspaceMemberFindMany: vi.fn(),
}));
const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
const perm = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn() }));
const queries = vi.hoisted(() => ({ getDatabase: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: db.pageFindUnique, findMany: db.pageFindMany },
    teamspaceMember: { findMany: db.teamspaceMemberFindMany },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));
vi.mock("@/lib/permissions", () => ({ getWorkspaceAccess: perm.getWorkspaceAccess }));
vi.mock("@/server/queries", () => ({ getDatabase: queries.getDatabase }));

import { getLinkedDatabaseAction, listDatabasesAction } from "./linked-database";

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
  { id: "db-3", parentId: "parent-1", type: "DATABASE", title: "Inherited" },
  { id: "db-1", parentId: null, type: "DATABASE", title: "Shared" },
  { id: "row-1", parentId: "db-1", type: "PAGE", title: "Row" },
  { id: "db-2", parentId: null, type: "DATABASE", title: "Private" },
];

/** The guest's page grants: page id → permission levels. */
let grants: Record<string, string[]>;

/** The guest's own pages / teamspace pages (empty in these fixtures). */
let ownPages: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  grants = {};
  ownPages = [];

  auth.requireUser.mockResolvedValue({ id: GUEST_ID });
  perm.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
  db.teamspaceMemberFindMany.mockResolvedValue([]);

  // The scope query: every page of the workspace with this guest's grants.
  db.pageFindMany.mockImplementation(async (args: { where?: Record<string, unknown> }) => {
    const where = args?.where ?? {};
    if (where.type === "DATABASE") {
      // The database list of `listDatabasesAction` — honour its id filter.
      const all = TREE.filter((page) => page.type === "DATABASE");
      const ids = (where.id as { in?: string[] } | undefined)?.in;
      return ids ? all.filter((page) => ids.includes(page.id)) : all;
    }
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
      workspaceId: WORKSPACE_ID,
      type: page.type,
      title: page.title,
      icon: null,
    };
  });

  queries.getDatabase.mockResolvedValue({
    properties: [{ id: "prop-1", name: "Name", type: "TEXT" }],
    views: [{ id: "view-1", name: "All", type: "TABLE" }],
    rows: [
      {
        id: "row-1",
        title: "Row",
        icon: null,
        propertyValues: [{ propertyId: "prop-1", value: { text: "value" } }],
      },
    ],
  });
});

describe("getLinkedDatabaseAction — guest scope", () => {
  it("reads the rows of a database that was shared with the guest", async () => {
    grants = { "db-1": ["READ"] };

    const result = await getLinkedDatabaseAction("db-1");

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.databasePageId).toBe("db-1");
    expect(result.rows.map((row) => row.id)).toEqual(["row-1"]);
    expect(result.properties.map((property) => property.name)).toEqual(["Name"]);
  });

  it("hides a database whose only shared page is one of its rows", async () => {
    // The core of the finding: the row was shared, the database was not. The
    // database is an *ancestor* of the grant — inheritance runs downwards, so
    // it is not readable.
    grants = { "row-1": ["READ"] };

    const result = await getLinkedDatabaseAction("db-1");

    expect(result).toEqual({ error: "Database not found." });
    expect(queries.getDatabase).not.toHaveBeenCalled();
  });

  it("hides a database the guest was never granted", async () => {
    grants = {};

    const result = await getLinkedDatabaseAction("db-1");

    expect(result).toEqual({ error: "Database not found." });
    expect(queries.getDatabase).not.toHaveBeenCalled();
  });

  it("answers an unknown id exactly like an out-of-scope database", async () => {
    grants = {};

    const unknown = await getLinkedDatabaseAction("does-not-exist");
    const outOfScope = await getLinkedDatabaseAction("db-1");

    // Byte-identical: the answer must not confirm that the database exists.
    expect(JSON.stringify(unknown)).toBe(JSON.stringify(outOfScope));
    expect(unknown).toEqual({ error: "Database not found." });
  });

  it("reads a database below a shared page (inheritance runs downwards)", async () => {
    grants = { "parent-1": ["READ"] };

    const result = await getLinkedDatabaseAction("db-3");

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.databasePageId).toBe("db-3");
  });

  it("leaves a member untouched", async () => {
    perm.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    const result = await getLinkedDatabaseAction("db-2");

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.databasePageId).toBe("db-2");
    expect(result.rows.map((row) => row.id)).toEqual(["row-1"]);
  });
});

describe("listDatabasesAction — guest scope", () => {
  it("lists the databases the guest may read", async () => {
    grants = { "db-1": ["READ"] };

    const databases = await listDatabasesAction(WORKSPACE_ID);

    expect(databases.map((database) => database.id)).toEqual(["db-1"]);
  });

  it("lists a database below a shared page (inheritance runs downwards)", async () => {
    grants = { "parent-1": ["READ"] };

    const databases = await listDatabasesAction(WORKSPACE_ID);

    expect(databases.map((database) => database.id)).toEqual(["db-3"]);
  });

  it("lists nothing when only a row of a database was shared", async () => {
    grants = { "row-1": ["READ"] };

    const databases = await listDatabasesAction(WORKSPACE_ID);

    expect(databases).toEqual([]);
  });

  it("lists nothing for a guest without any grant", async () => {
    grants = {};

    const databases = await listDatabasesAction(WORKSPACE_ID);

    expect(databases).toEqual([]);
  });

  it("lists every database for a member", async () => {
    perm.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    const databases = await listDatabasesAction(WORKSPACE_ID);

    expect(databases.map((database) => database.id)).toEqual(["db-3", "db-1", "db-2"]);
  });
});
