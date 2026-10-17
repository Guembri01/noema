import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B08 — the read side of the tenant boundary for database rows.
 *
 * `Page.parentId` was unchecked before the fix, so a row of workspace A could
 * be filed under a database of workspace B. Those legacy rows are **not**
 * repaired by the deploy — every read has to filter them by the workspace of
 * the database they hang under.
 *
 * `getDatabase` is the read the database view uses, and the relation property
 * resolves the rows of a *related* database through the same filter. The fake
 * database below applies the filters the real one would, so a missing
 * `workspaceId` in the query surfaces as a foreign row in the result.
 */

const WORKSPACE_A = "ws-a";
const WORKSPACE_B = "ws-b";
const DATABASE_A = "db-a";

type FakeRow = {
  id: string;
  workspaceId: string;
  parentId: string | null;
  title: string;
  deletedAt: Date | null;
  position: number;
  propertyValues: { propertyId: string; value: unknown }[];
  createdBy: { name: string };
};

const ROWS: FakeRow[] = [
  {
    id: "row-a",
    workspaceId: WORKSPACE_A,
    parentId: DATABASE_A,
    title: "Row in A",
    deletedAt: null,
    position: 1000,
    propertyValues: [{ propertyId: "prop-1", value: { text: "A's cell value" } }],
    createdBy: { name: "Ada" },
  },
  {
    id: "row-foreign",
    workspaceId: WORKSPACE_B,
    parentId: DATABASE_A,
    title: "Row in B (legacy cross-tenant link)",
    deletedAt: null,
    position: 2000,
    propertyValues: [{ propertyId: "prop-1", value: { text: "B's secret cell value" } }],
    createdBy: { name: "Bob" },
  },
];

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  pageFindMany: vi.fn(),
  propertyFindMany: vi.fn(),
  databaseViewFindMany: vi.fn(),
  templateFindMany: vi.fn(),
  activityFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: db.pageFindUnique, findMany: db.pageFindMany },
    property: { findMany: db.propertyFindMany },
    databaseView: { findMany: db.databaseViewFindMany },
    template: { findMany: db.templateFindMany },
    activity: { findMany: db.activityFindMany },
  },
}));

import { getDatabase } from "./queries";

beforeEach(() => {
  vi.clearAllMocks();

  db.pageFindUnique.mockImplementation(async (args: { where: { id: string } }) => {
    if (args.where.id !== DATABASE_A) return null;
    return { workspaceId: WORKSPACE_A };
  });

  // The fake database applies the filters the real one would.
  db.pageFindMany.mockImplementation(
    async (args: {
      where?: { parentId?: string | null; workspaceId?: string; deletedAt?: null };
    }) => {
      const where = args.where ?? {};
      return ROWS.filter((row) => {
        if (where.parentId !== undefined && row.parentId !== where.parentId) return false;
        if (where.workspaceId !== undefined && row.workspaceId !== where.workspaceId) return false;
        if (where.deletedAt === null && row.deletedAt !== null) return false;
        return true;
      });
    },
  );

  db.propertyFindMany.mockResolvedValue([]);
  db.databaseViewFindMany.mockResolvedValue([]);
  db.templateFindMany.mockResolvedValue([]);
  db.activityFindMany.mockResolvedValue([]);
});

describe("getDatabase — row scope (B08)", () => {
  it("does not return a row of another workspace", async () => {
    const database = await getDatabase(DATABASE_A);

    expect(database.rows.map((row) => row.title)).toEqual(["Row in A"]);
  });

  it("does not return the cell values of a row of another workspace", async () => {
    const database = await getDatabase(DATABASE_A);

    expect(JSON.stringify(database.rows)).not.toContain("B's secret cell value");
  });

  it("scopes the row query to the workspace of the database", async () => {
    await getDatabase(DATABASE_A);

    const rowQuery = db.pageFindMany.mock.calls.find((args) => {
      const where = (args[0] as { where?: { parentId?: unknown } })?.where;
      return where?.parentId === DATABASE_A;
    });
    expect(rowQuery?.[0]?.where).toMatchObject({ workspaceId: WORKSPACE_A });
  });

  it("scopes an unknown database to the empty workspace, which matches no row", async () => {
    const database = await getDatabase("db-unknown");

    expect(database.rows).toEqual([]);
    const rowQuery = db.pageFindMany.mock.calls.find((args) => {
      const where = (args[0] as { where?: { parentId?: unknown } })?.where;
      return where?.parentId === "db-unknown";
    });
    expect(rowQuery?.[0]?.where).toMatchObject({ workspaceId: "" });
  });
});
