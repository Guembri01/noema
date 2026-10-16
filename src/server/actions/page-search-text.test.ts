import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pageSearchText } from "@/lib/search";

/**
 * Page-creation search wiring.
 *
 * `Page.searchText` is the plain-text mirror Postgres indexes for full-text
 * search (`scripts/check-search.mjs`, `src/lib/search.ts`). `updatePageAction`
 * already refreshed it on every edit, but the create paths never wrote it, so
 * a freshly created page (a normal page, a database row, a template row, an
 * import, a duplicate, the starter rows seeded with a new database) stayed
 * invisible to search until a later save, `setup:search`, or the next update.
 *
 * These tests call the REAL actions with only the transport edges mocked, and
 * assert every `page.create` / `page.createMany` payload carries a non-empty
 * `searchText` equal to what the shared helper derives — i.e. the same mirror
 * the update path writes.
 */

const db = vi.hoisted(() => ({
  workspaceFindUnique: vi.fn(),
  pageFindUnique: vi.fn(),
  pageFindUniqueOrThrow: vi.fn(),
  pageFindFirst: vi.fn(),
  pageFindMany: vi.fn(),
  pageCreate: vi.fn(),
  pageCreateMany: vi.fn(),
  propertyCreate: vi.fn(),
  propertyFindMany: vi.fn(),
  propertyCreateMany: vi.fn(),
  databaseViewCreateMany: vi.fn(),
  databaseViewFindMany: vi.fn(),
  propertyValueCreate: vi.fn(),
  propertyValueCreateMany: vi.fn(),
  propertyValueFindMany: vi.fn(),
  templateFindUnique: vi.fn(),
  templateFindMany: vi.fn(),
  templateCreateMany: vi.fn(),
  transaction: vi.fn(),
  tx: {
    page: { findFirst: vi.fn(), create: vi.fn(), createMany: vi.fn(), findUnique: vi.fn() },
    property: { findMany: vi.fn(), createMany: vi.fn() },
    propertyValue: { createMany: vi.fn() },
    databaseView: { createMany: vi.fn() },
    template: { createMany: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: { findUnique: db.workspaceFindUnique },
    page: {
      findUnique: db.pageFindUnique,
      findUniqueOrThrow: db.pageFindUniqueOrThrow,
      findFirst: db.pageFindFirst,
      findMany: db.pageFindMany,
      create: db.pageCreate,
      createMany: db.pageCreateMany,
    },
    property: {
      create: db.propertyCreate,
      findMany: db.propertyFindMany,
      createMany: db.propertyCreateMany,
    },
    databaseView: {
      createMany: db.databaseViewCreateMany,
      findMany: db.databaseViewFindMany,
    },
    propertyValue: {
      create: db.propertyValueCreate,
      createMany: db.propertyValueCreateMany,
      findMany: db.propertyValueFindMany,
    },
    template: {
      findUnique: db.templateFindUnique,
      findMany: db.templateFindMany,
      createMany: db.templateCreateMany,
    },
    $transaction: db.transaction,
  },
}));

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "user-1" })) }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: vi.fn(async () => ({ role: "OWNER" })),
  canEditContent: vi.fn(() => true),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: vi.fn(async () => {}) }));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn(async () => {}) }));

import { createPageAction } from "./pages";
import {
  createRowAction,
  createRowFromTemplateAction,
  duplicateDatabaseAction,
  importCsvAction,
} from "./database";

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

/** The `data` object of the `index`-th recorded call. */
const dataOf = (fn: { mock: { calls: unknown[][] } }, index: number) =>
  (fn.mock.calls[index][0] as { data: Record<string, unknown> }).data;

/** Every non-empty string mirror must satisfy this minimal shape. */
const expectIndexed = (data: Record<string, unknown>, expected: string) => {
  expect(typeof data.searchText).toBe("string");
  expect((data.searchText as string).length).toBeGreaterThan(0);
  expect(data.searchText).toBe(expected);
};

beforeEach(() => {
  vi.clearAllMocks();
  db.transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === "function"
      ? (arg as (tx: typeof db.tx) => Promise<unknown>)(db.tx)
      : Promise.all(arg as Promise<unknown>[]),
  );
  db.pageCreate.mockResolvedValue({ id: "created" });
  db.pageCreateMany.mockResolvedValue({ count: 0 });
  db.tx.page.create.mockResolvedValue({ id: "created" });
  db.tx.page.createMany.mockResolvedValue({ count: 0 });
  db.tx.page.findFirst.mockResolvedValue(null);
  db.tx.property.findMany.mockResolvedValue([]);
  db.propertyCreate.mockResolvedValue({ id: "prop" });
  db.propertyValueCreate.mockResolvedValue({});
  db.propertyValueCreateMany.mockResolvedValue({ count: 0 });
  db.propertyFindMany.mockResolvedValue([]);
  db.databaseViewFindMany.mockResolvedValue([]);
  db.templateFindMany.mockResolvedValue([]);
  db.pageFindMany.mockResolvedValue([]);
  db.pageFindFirst.mockResolvedValue(null);
  db.pageFindUniqueOrThrow.mockResolvedValue({ workspaceId: "ws-1", createdById: "user-1" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("pages.ts create paths", () => {
  it("createPageAction indexes a new database page and its seeded starter rows", async () => {
    db.workspaceFindUnique.mockResolvedValue({ slug: "demo-workspace" });
    db.pageCreate
      .mockResolvedValueOnce({ id: "db-1" })
      .mockResolvedValue({ id: "seed-row" });

    const result = await createPageAction({ workspaceId: "ws-1", type: "DATABASE" });
    expect(result).toMatchObject({ ok: true, id: "db-1" });

    // One database page + two starter rows, from the same create path.
    expect(db.pageCreate).toHaveBeenCalledTimes(3);
    const expectedTitles = ["New database", "Draft the project brief", "Collect requirements"];
    expectedTitles.forEach((title, index) => {
      expectIndexed(dataOf(db.pageCreate, index), pageSearchText(title, null));
    });
  });
});

describe("database.ts create paths", () => {
  it("createRowAction indexes a new row from its title", async () => {
    db.pageFindUnique.mockResolvedValue({
      id: "db-1",
      workspaceId: "ws-1",
      type: "DATABASE",
      schemaLocked: false,
    });
    db.tx.page.findFirst.mockResolvedValue({ position: 1000 });

    const result = await createRowAction("db-1", "Quixotic draft");
    expect(result).toMatchObject({ ok: true, id: "created" });

    expect(db.tx.page.create).toHaveBeenCalledTimes(1);
    expectIndexed(dataOf(db.tx.page.create, 0), pageSearchText("Quixotic draft", null));
  });

  it("createRowFromTemplateAction indexes the template name and body", async () => {
    db.pageFindUnique.mockResolvedValue({
      id: "db-1",
      workspaceId: "ws-1",
      type: "DATABASE",
      schemaLocked: false,
    });
    db.templateFindUnique.mockResolvedValue({
      name: "Weekly review",
      icon: null,
      content: doc("body from the template"),
      config: { values: [] },
    });
    db.pageFindFirst.mockResolvedValue({ position: 1000 });

    const result = await createRowFromTemplateAction("db-1", "t-1");
    expect(result).toMatchObject({ ok: true, id: "created" });

    expect(db.pageCreate).toHaveBeenCalledTimes(1);
    expectIndexed(
      dataOf(db.pageCreate, 0),
      pageSearchText("Weekly review", doc("body from the template")),
    );
  });

  it("importCsvAction indexes every imported row from its title", async () => {
    db.pageFindUnique.mockResolvedValue({
      id: "db-1",
      workspaceId: "ws-1",
      type: "DATABASE",
      schemaLocked: false,
    });
    db.propertyFindMany.mockResolvedValue([
      { id: "p-name", name: "Name", type: "TEXT", position: 1000, config: { primary: true } },
    ]);

    const result = await importCsvAction("db-1", "Name\nQuixotic import\n");
    expect(result).toMatchObject({ ok: true, created: 1 });

    expect(db.tx.page.create).toHaveBeenCalledTimes(1);
    expectIndexed(dataOf(db.tx.page.create, 0), pageSearchText("Quixotic import", null));
  });

  it("duplicateDatabaseAction indexes the copied database page and every copied row", async () => {
    db.pageFindUnique
      .mockResolvedValueOnce({
        id: "db-1",
        workspaceId: "ws-1",
        type: "DATABASE",
        schemaLocked: false,
      })
      .mockResolvedValueOnce({ parentId: null, title: "Roadmap", icon: "🗂️" });
    db.propertyFindMany.mockResolvedValue([
      { id: "p1", name: "Name", type: "TEXT", position: 1000, config: { primary: true } },
    ]);
    db.pageFindMany.mockResolvedValue([
      {
        id: "r1",
        title: "Row one",
        icon: null,
        content: doc("copied row body"),
        position: 1000,
        propertyValues: [{ propertyId: "p1", value: { text: "Row one" } }],
      },
    ]);

    const result = await duplicateDatabaseAction("db-1");
    expect(result).toMatchObject({ ok: true });

    // The fresh database page.
    expect(db.tx.page.create).toHaveBeenCalledTimes(1);
    expectIndexed(dataOf(db.tx.page.create, 0), pageSearchText("Roadmap copy", null));

    // The copied rows, in one createMany.
    expect(db.tx.page.createMany).toHaveBeenCalledTimes(1);
    const rows = (db.tx.page.createMany.mock.calls[0][0] as {
      data: { title: string; searchText?: string }[];
    }).data;
    expect(rows).toHaveLength(1);
    expectIndexed(
      rows[0] as unknown as Record<string, unknown>,
      pageSearchText("Row one", doc("copied row body")),
    );
  });
});
