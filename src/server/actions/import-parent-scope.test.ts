import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B08 — the importer family: the parent of an imported page.
 *
 * Every importer takes the parent of the page it is about to create from the
 * request (a form field, a JSON body). `Page.parentId` is a plain foreign
 * key, so a parent from another tenant files the imported page in that
 * tenant's tree: it shows up in their database view and in their CSV/JSON
 * export, and Postgres' `onDelete: Cascade` deletes it together with their
 * parent.
 *
 * One test per importer family — Docx, Trello, Zip, Markdown, CSV, HTML, PDF
 * and Notion — so a later refactor of one importer cannot silently drop the
 * check. The real actions and the real `assertScopedParent` run; only the
 * transport edges (prisma, auth, permissions, cache) are mocked.
 */

const WORKSPACE_A = "ws-a";
const WORKSPACE_B = "ws-b";
const PAGE_A = "page-a";
const DATABASE_B = "database-b";

const PARENT_ERROR = "That parent page does not exist in this workspace.";

const db = vi.hoisted(() => ({
  pageFindFirst: vi.fn(),
  pageFindMany: vi.fn(),
  pageCreate: vi.fn(),
  pageCreateMany: vi.fn(),
  pageDelete: vi.fn(),
  pageDeleteMany: vi.fn(),
  propertyFindMany: vi.fn(),
  propertyCreate: vi.fn(),
  propertyCreateMany: vi.fn(),
  propertyValueCreate: vi.fn(),
  propertyValueCreateMany: vi.fn(),
  databaseViewFindMany: vi.fn(),
  databaseViewCreate: vi.fn(),
  databaseViewCreateMany: vi.fn(),
  workspaceFindUnique: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const tx = {
    page: {
      findFirst: db.pageFindFirst,
      findMany: db.pageFindMany,
      create: db.pageCreate,
      createMany: db.pageCreateMany,
      delete: db.pageDelete,
      deleteMany: db.pageDeleteMany,
    },
    property: {
      findMany: db.propertyFindMany,
      create: db.propertyCreate,
      createMany: db.propertyCreateMany,
    },
    propertyValue: { create: db.propertyValueCreate, createMany: db.propertyValueCreateMany },
    databaseView: {
      findMany: db.databaseViewFindMany,
      create: db.databaseViewCreate,
      createMany: db.databaseViewCreateMany,
    },
  };
  return {
    prisma: {
      ...tx,
      workspace: { findUnique: db.workspaceFindUnique },
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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  importCsvDatabaseAction,
  importDocxAction,
  importMarkdownAction,
  importTrelloAction,
  importZipAction,
} from "./import";
import { importHtmlAction, importPdfAction } from "./import-formats";
import { importNotionPageAction } from "./notion-import";

/** A form the Docx / Zip importers accept. */
function uploadForm(name: string): FormData {
  const form = new FormData();
  form.set("workspaceId", WORKSPACE_A);
  form.set("file", new File(["payload"], name, { type: "application/octet-stream" }));
  return form;
}

const TRELLO_BOARD = JSON.stringify({
  name: "Board",
  lists: [{ id: "list-1", name: "To do" }],
  cards: [{ id: "card-1", idList: "list-1", name: "Card", desc: "" }],
});

beforeEach(() => {
  vi.clearAllMocks();

  // The Notion importer has to refuse the foreign parent *before* it talks to
  // the API — the test must never depend on the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("the importer must not reach the network");
    }),
  );

  // The tenant-scoped parent lookup — a page of another workspace exists but
  // is never returned for this workspace.
  db.pageFindFirst.mockImplementation(
    async (args: {
      where: { id?: string; workspaceId?: string; parentId?: string | null };
      select?: Record<string, boolean>;
    }) => {
      const where = args.where;
      if (typeof where.id === "string") {
        if (where.id === PAGE_A && where.workspaceId === WORKSPACE_A) return { id: PAGE_A };
        return null;
      }
      return { position: 0 };
    },
  );

  db.pageFindMany.mockResolvedValue([]);
  db.pageCreate.mockResolvedValue({ id: "page-new" });
  db.pageCreateMany.mockResolvedValue({ count: 0 });
  db.pageDelete.mockResolvedValue({ id: "page-new" });
  db.pageDeleteMany.mockResolvedValue({ count: 0 });
  db.propertyFindMany.mockResolvedValue([]);
  db.propertyCreate.mockResolvedValue({ id: "prop-1" });
  db.propertyCreateMany.mockResolvedValue({ count: 0 });
  db.propertyValueCreate.mockResolvedValue({ id: "value-1" });
  db.propertyValueCreateMany.mockResolvedValue({ count: 0 });
  db.databaseViewFindMany.mockResolvedValue([]);
  db.databaseViewCreate.mockResolvedValue({ id: "view-1" });
  db.databaseViewCreateMany.mockResolvedValue({ count: 0 });
  db.workspaceFindUnique.mockResolvedValue({ slug: "workspace-a" });
  db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      page: {
        findFirst: db.pageFindFirst,
        findMany: db.pageFindMany,
        create: db.pageCreate,
        createMany: db.pageCreateMany,
        delete: db.pageDelete,
        deleteMany: db.pageDeleteMany,
      },
      property: {
        findMany: db.propertyFindMany,
        create: db.propertyCreate,
        createMany: db.propertyCreateMany,
      },
      propertyValue: { create: db.propertyValueCreate, createMany: db.propertyValueCreateMany },
      databaseView: {
        findMany: db.databaseViewFindMany,
        create: db.databaseViewCreate,
        createMany: db.databaseViewCreateMany,
      },
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("importDocxAction — parent scope (B08)", () => {
  it("refuses a parent from another workspace and imports nothing", async () => {
    const form = uploadForm("notes.docx");
    form.set("parentId", DATABASE_B);

    const result = await importDocxAction(form);

    expect(result).toEqual({ error: PARENT_ERROR });
    expect(db.pageCreate).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe("importTrelloAction — parent scope (B08)", () => {
  it("refuses a parent from another workspace and imports nothing", async () => {
    const result = await importTrelloAction({
      workspaceId: WORKSPACE_A,
      parentId: DATABASE_B,
      json: TRELLO_BOARD,
    });

    expect(result).toEqual({ error: PARENT_ERROR });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.pageCreate).not.toHaveBeenCalled();
  });

  it("imports the board under a parent of its own workspace", async () => {
    const result = await importTrelloAction({
      workspaceId: WORKSPACE_A,
      parentId: PAGE_A,
      json: TRELLO_BOARD,
    });

    expect(result).toMatchObject({ ok: true });
    expect(db.pageCreate.mock.calls[0][0].data.parentId).toBe(PAGE_A);
  });
});

describe("importZipAction — parent scope (B08)", () => {
  it("refuses a parent from another workspace and imports nothing", async () => {
    const form = uploadForm("notes.zip");
    form.set("parentId", DATABASE_B);

    const result = await importZipAction(form);

    expect(result).toEqual({ error: PARENT_ERROR });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.pageCreate).not.toHaveBeenCalled();
  });
});

describe("importMarkdownAction — parent scope (B08)", () => {
  it("refuses a parent from another workspace and imports nothing", async () => {
    const result = await importMarkdownAction({
      workspaceId: WORKSPACE_A,
      parentId: DATABASE_B,
      filename: "notes.md",
      markdown: "# Title",
    });

    expect(result).toEqual({ error: PARENT_ERROR });
    expect(db.pageCreate).not.toHaveBeenCalled();
  });

  it("imports the page under a parent of its own workspace", async () => {
    const result = await importMarkdownAction({
      workspaceId: WORKSPACE_A,
      parentId: PAGE_A,
      filename: "notes.md",
      markdown: "# Title",
    });

    expect(result).toMatchObject({ ok: true });
    expect(db.pageCreate.mock.calls[0][0].data.parentId).toBe(PAGE_A);
  });
});

describe("importCsvDatabaseAction — parent scope (B08)", () => {
  it("refuses a parent from another workspace and imports nothing", async () => {
    const result = await importCsvDatabaseAction({
      workspaceId: WORKSPACE_A,
      parentId: DATABASE_B,
      title: "Imported",
      properties: [{ id: "name", name: "Name", type: "TEXT" }],
      csv: "Name\nA\n",
    });

    expect(result).toEqual({ error: PARENT_ERROR });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.pageCreate).not.toHaveBeenCalled();
  });
});

describe("importHtmlAction — parent scope (B08)", () => {
  it("refuses a parent from another workspace and imports nothing", async () => {
    const result = await importHtmlAction({
      workspaceId: WORKSPACE_A,
      parentId: DATABASE_B,
      html: "<p>Hello</p>",
      filename: "page.html",
    });

    expect(result).toEqual({ error: PARENT_ERROR });
    expect(db.pageCreate).not.toHaveBeenCalled();
  });

  it("imports the page under a parent of its own workspace", async () => {
    const result = await importHtmlAction({
      workspaceId: WORKSPACE_A,
      parentId: PAGE_A,
      html: "<p>Hello</p>",
      filename: "page.html",
    });

    expect(result).toMatchObject({ ok: true });
    expect(db.pageCreate.mock.calls[0][0].data.parentId).toBe(PAGE_A);
  });
});

describe("importPdfAction — parent scope (B08)", () => {
  it("refuses a parent from another workspace and imports nothing", async () => {
    const result = await importPdfAction({
      workspaceId: WORKSPACE_A,
      parentId: DATABASE_B,
      data: Buffer.from("%PDF-1.4\n").toString("base64"),
      filename: "notes.pdf",
    });

    expect(result).toEqual({ error: PARENT_ERROR });
    expect(db.pageCreate).not.toHaveBeenCalled();
  });
});

describe("importNotionPageAction — parent scope (B08)", () => {
  it("refuses a parent from another workspace and imports nothing", async () => {
    const result = await importNotionPageAction({
      workspaceId: WORKSPACE_A,
      parentId: DATABASE_B,
      token: "secret-token",
      pageId: "notion-page",
    });

    expect(result).toEqual({ error: PARENT_ERROR });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.pageCreate).not.toHaveBeenCalled();
  });
});
