import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B08 — the **read side** of the tenant boundary for database rows.
 *
 * `Page.parentId` was unchecked before the fix, so a row of workspace A could
 * be filed under a database of workspace B. Those legacy rows are **not**
 * repaired by the deploy — the application has to filter them on every read.
 *
 * Three reads were still unfiltered:
 *
 *   - `duplicateDatabaseAction` read the rows of the database **without** a
 *     workspace filter and copied them **with their content** (title, body and
 *     cell values) into the clone — the biggest cross-tenant leak of the
 *     finding, because the copy carries the foreign row's *content*,
 *   - `listDeletedRowsAction` (the "Deleted rows" panel) listed the **title**
 *     of a foreign row,
 *   - `gatherChatIntel` (the chat context) put the foreign row's **title and
 *     cell values** into the AI prompt.
 *
 * The fake database below applies the same filters the real one would, so a
 * missing `workspaceId` in the query surfaces as a foreign row in the result.
 */

const WORKSPACE_A = "ws-a";
const WORKSPACE_B = "ws-b";
const DATABASE_A = "db-a";

type FakeRow = {
  id: string;
  workspaceId: string;
  parentId: string | null;
  title: string;
  content: unknown;
  deletedAt: Date | null;
  position: number;
  propertyValues: { propertyId: string; value: unknown }[];
};

/** One row of the caller's workspace and one legacy row of another one. */
const ROWS: FakeRow[] = [
  {
    id: "row-a",
    workspaceId: WORKSPACE_A,
    parentId: DATABASE_A,
    title: "Row in A",
    content: { type: "doc", content: [] },
    deletedAt: null,
    position: 1000,
    propertyValues: [{ propertyId: "prop-1", value: { text: "A's cell value" } }],
  },
  {
    id: "row-foreign",
    workspaceId: WORKSPACE_B,
    parentId: DATABASE_A,
    title: "Row in B (legacy cross-tenant link)",
    content: { type: "doc", content: [{ text: "B's secret row body" }] },
    deletedAt: null,
    position: 2000,
    propertyValues: [{ propertyId: "prop-1", value: { text: "B's secret cell value" } }],
  },
  {
    id: "row-foreign-deleted",
    workspaceId: WORKSPACE_B,
    parentId: DATABASE_A,
    title: "Deleted row in B (legacy cross-tenant link)",
    content: null,
    deletedAt: new Date("2026-01-02T03:04:05.000Z"),
    position: 3000,
    propertyValues: [],
  },
];

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  pageFindFirst: vi.fn(),
  pageFindMany: vi.fn(),
  pageCreate: vi.fn(),
  pageCreateMany: vi.fn(),
  pageUpdate: vi.fn(),
  propertyFindMany: vi.fn(),
  propertyCreateMany: vi.fn(),
  propertyValueCreateMany: vi.fn(),
  databaseViewFindMany: vi.fn(),
  databaseViewCreateMany: vi.fn(),
  templateFindMany: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const tx = {
    page: {
      findFirst: db.pageFindFirst,
      create: db.pageCreate,
      createMany: db.pageCreateMany,
    },
    property: { createMany: db.propertyCreateMany },
    propertyValue: { createMany: db.propertyValueCreateMany },
    databaseView: { createMany: db.databaseViewCreateMany },
  };
  return {
    prisma: {
      page: {
        findUnique: db.pageFindUnique,
        findFirst: db.pageFindFirst,
        findMany: db.pageFindMany,
        create: db.pageCreate,
        createMany: db.pageCreateMany,
        update: db.pageUpdate,
      },
      property: { findMany: db.propertyFindMany },
      databaseView: { findMany: db.databaseViewFindMany },
      template: { findMany: db.templateFindMany },
      $transaction: db.transaction,
    },
  };
});

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: vi.fn(async () => ({ role: "MEMBER" })),
  canEditContent: vi.fn(() => true),
}));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { duplicateDatabaseAction, listDeletedRowsAction, reorderRowsAction } from "./database";

/** The row payloads the clone wrote (`tx.page.createMany({ data: rowPages })`). */
function clonedRows(): { title: string; content?: unknown }[] {
  const call = db.pageCreateMany.mock.calls.find(
    (args) => Array.isArray((args[0] as { data?: unknown[] })?.data),
  );
  return ((call?.[0] as { data: { title: string; content?: unknown }[] })?.data ?? []);
}

beforeEach(() => {
  vi.clearAllMocks();

  db.pageFindUnique.mockImplementation(async (args: { where: { id: string } }) => {
    // The anchor row of a reorder: only its parent is read.
    if (args.where.id === "row-a") return { parentId: DATABASE_A };
    if (args.where.id !== DATABASE_A) return null;
    return {
      id: DATABASE_A,
      workspaceId: WORKSPACE_A,
      type: "DATABASE",
      schemaLocked: false,
      parentId: null,
      title: "Database in A",
      icon: null,
    };
  });

  // The tenant-scoped parent lookup and the sibling-position lookup.
  db.pageFindFirst.mockImplementation(
    async (args: { where: { id?: string; workspaceId?: string; parentId?: string | null } }) => {
      if (typeof args.where.id === "string") return null;
      return { position: 0 };
    },
  );

  // The fake database applies the filters the real one would — so a query
  // without `workspaceId` returns the foreign rows as well.
  db.pageFindMany.mockImplementation(
    async (args: {
      where?: {
        parentId?: string | null;
        workspaceId?: string;
        deletedAt?: null | { not: null };
      };
    }) => {
      const where = args.where ?? {};
      return ROWS.filter((row) => {
        if (where.parentId !== undefined && row.parentId !== where.parentId) return false;
        if (where.workspaceId !== undefined && row.workspaceId !== where.workspaceId) return false;
        if (where.deletedAt === null && row.deletedAt !== null) return false;
        if (
          where.deletedAt &&
          typeof where.deletedAt === "object" &&
          where.deletedAt.not !== null &&
          row.deletedAt === null
        ) {
          return false;
        }
        return true;
      });
    },
  );

  db.pageCreate.mockResolvedValue({ id: "clone-page" });
  db.pageCreateMany.mockResolvedValue({ count: 0 });
  db.pageUpdate.mockResolvedValue({ id: "row-a" });
  db.propertyFindMany.mockResolvedValue([
    { id: "prop-1", name: "Name", type: "TEXT", config: { primary: true }, position: 1000 },
  ]);
  db.propertyCreateMany.mockResolvedValue({ count: 0 });
  db.propertyValueCreateMany.mockResolvedValue({ count: 0 });
  db.databaseViewFindMany.mockResolvedValue([]);
  db.databaseViewCreateMany.mockResolvedValue({ count: 0 });
  db.templateFindMany.mockResolvedValue([]);
  db.transaction.mockImplementation(async (arg: unknown) => {
    // `$transaction` takes either a list of promises or a callback.
    if (Array.isArray(arg)) return Promise.all(arg);
    const fn = arg as (tx: unknown) => Promise<unknown>;
    return fn({
      page: { findFirst: db.pageFindFirst, create: db.pageCreate, createMany: db.pageCreateMany },
      property: { createMany: db.propertyCreateMany },
      propertyValue: { createMany: db.propertyValueCreateMany },
      databaseView: { createMany: db.databaseViewCreateMany },
    });
  });
});

describe("duplicateDatabaseAction — row scope (B08)", () => {
  it("does not clone a row of another workspace", async () => {
    const result = await duplicateDatabaseAction(DATABASE_A);

    expect(result).toMatchObject({ ok: true });
    const titles = clonedRows().map((row) => row.title);
    expect(titles).toEqual(["Row in A"]);
    expect(titles).not.toContain("Row in B (legacy cross-tenant link)");
  });

  it("copies no content of a row of another workspace", async () => {
    const result = await duplicateDatabaseAction(DATABASE_A);

    expect(result).toMatchObject({ ok: true });
    const serialized = JSON.stringify(clonedRows());
    expect(serialized).not.toContain("B's secret row body");
    expect(serialized).not.toContain("B's secret cell value");
  });

  it("scopes the row query to the workspace of the database", async () => {
    await duplicateDatabaseAction(DATABASE_A);

    const rowQuery = db.pageFindMany.mock.calls.find((args) => {
      const where = (args[0] as { where?: { parentId?: unknown } })?.where;
      return where?.parentId === DATABASE_A;
    });
    expect(rowQuery?.[0]?.where).toMatchObject({ workspaceId: WORKSPACE_A });
  });
});

describe("listDeletedRowsAction — row scope (B08)", () => {
  it("does not list a deleted row of another workspace", async () => {
    const result = await listDeletedRowsAction(DATABASE_A);

    expect(result).toMatchObject({ ok: true });
    const titles = (result as { rows: { title: string }[] }).rows.map((row) => row.title);
    expect(titles).not.toContain("Deleted row in B (legacy cross-tenant link)");
  });

  it("scopes the deleted-row query to the workspace of the database", async () => {
    await listDeletedRowsAction(DATABASE_A);

    const rowQuery = db.pageFindMany.mock.calls.find((args) => {
      const where = (args[0] as { where?: { deletedAt?: unknown } })?.where;
      return where?.deletedAt !== undefined && where?.deletedAt !== null;
    });
    expect(rowQuery?.[0]?.where).toMatchObject({ workspaceId: WORKSPACE_A });
  });
});

describe("reorderRowsAction — row scope (B08)", () => {
  it("does not write the position of a row of another workspace", async () => {
    const result = await reorderRowsAction("row-a", ["row-a", "row-foreign"]);

    expect(result).toMatchObject({ ok: true });
    const updated = db.pageUpdate.mock.calls.map(
      (call) => (call[0] as { where: { id: string } }).where.id,
    );
    expect(updated).toContain("row-a");
    expect(updated).not.toContain("row-foreign");
  });

  it("scopes the row query to the workspace of the database", async () => {
    await reorderRowsAction("row-a", ["row-a"]);

    const rowQuery = db.pageFindMany.mock.calls.find((args) => {
      const where = (args[0] as { where?: { parentId?: unknown } })?.where;
      return where?.parentId === DATABASE_A;
    });
    expect(rowQuery?.[0]?.where).toMatchObject({ workspaceId: WORKSPACE_A });
  });
});
