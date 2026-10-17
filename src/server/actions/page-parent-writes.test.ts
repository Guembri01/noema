import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B08 — the remaining `Page.parentId` write paths that carry a parent from an
 * already-read page row.
 *
 * `createPageAction` / `movePageAction` / the API routes / the importers are
 * covered by `pages-parent-scope.test.ts`; the PDF text-layer import has its
 * own file (`import-pdf-parent-scope.test.ts`). This file covers the paths
 * where the parent is not a request value but the *parent of a page that was
 * just read*:
 *
 *   - `saveChatAnswerAction`         — the discussion's own page,
 *   - `duplicatePageAction`           — the duplicated page's parent,
 *   - `duplicatePageSubtreeAction`    — the copied subtree's root parent,
 *   - `duplicateDatabaseAction`       — the cloned database's parent.
 *
 * The source row proves that the *source* lives in the caller's workspace; it
 * does not prove that the source's own parent does. A row that was linked
 * across workspaces before the fix (the B08 hole) would otherwise be copied
 * into a second cross-tenant link — and Postgres' `onDelete: Cascade` would
 * then delete the copy together with the foreign parent.
 *
 * Only the transport edges (prisma, auth, permissions, webhooks, cache) are
 * mocked; the actions and `assertScopedParent` are the real ones.
 */

const WORKSPACE_A = "ws-a";
const WORKSPACE_B = "ws-b";
const FOREIGN_PARENT = "page-in-b";

/** The pages the fake database holds. `page-a` carries a foreign parent. */
const PAGE_ROWS: Record<string, Record<string, unknown>> = {
  "page-a": {
    id: "page-a",
    workspaceId: WORKSPACE_A,
    parentId: FOREIGN_PARENT,
    type: "PAGE",
    title: "Page in A",
    icon: null,
    coverUrl: null,
    teamspaceId: null,
    projectId: null,
    fullWidth: false,
    smallText: false,
    font: "",
    lineSpacing: "",
    locked: false,
    schemaLocked: false,
    deletedAt: null,
    content: null,
    position: 1000,
    workspace: { slug: "workspace-a" },
  },
  "db-a": {
    id: "db-a",
    workspaceId: WORKSPACE_A,
    parentId: FOREIGN_PARENT,
    type: "DATABASE",
    title: "Database in A",
    icon: null,
    coverUrl: null,
    teamspaceId: null,
    projectId: null,
    fullWidth: false,
    smallText: false,
    font: "",
    lineSpacing: "",
    locked: false,
    schemaLocked: false,
    deletedAt: null,
    content: null,
    position: 1000,
    workspace: { slug: "workspace-a" },
  },
  [FOREIGN_PARENT]: {
    id: FOREIGN_PARENT,
    workspaceId: WORKSPACE_B,
    parentId: null,
    type: "PAGE",
    title: "Page in B",
    icon: null,
    deletedAt: null,
    position: 1000,
  },
};

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  pageFindFirst: vi.fn(),
  pageFindMany: vi.fn(),
  pageCreate: vi.fn(),
  pageCreateMany: vi.fn(),
  pageUpdate: vi.fn(),
  chatMessageFindUnique: vi.fn(),
  propertyFindMany: vi.fn(),
  databaseViewFindMany: vi.fn(),
  templateFindMany: vi.fn(),
  workspaceFindUnique: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const tx = {
    page: {
      findFirst: db.pageFindFirst,
      create: db.pageCreate,
      createMany: db.pageCreateMany,
    },
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
      chatMessage: { findUnique: db.chatMessageFindUnique },
      property: { findMany: db.propertyFindMany },
      databaseView: { findMany: db.databaseViewFindMany },
      template: { findMany: db.templateFindMany },
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
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { saveChatAnswerAction } from "./chat";
import { duplicatePageAction } from "./page-menu";
import { duplicatePageSubtreeAction } from "./page-duplicate";
import { duplicateDatabaseAction } from "./database";

const PARENT_ERROR = "That parent page does not exist in this workspace.";

beforeEach(() => {
  vi.clearAllMocks();

  db.pageFindUnique.mockImplementation(async (args: { where: { id: string } }) => {
    const row = PAGE_ROWS[args.where.id];
    return row ? { ...row } : null;
  });

  // The helper's lookup is tenant-scoped in the query, so the foreign parent
  // exists but is never returned for workspace A.
  db.pageFindFirst.mockImplementation(
    async (args: { where: { id?: string; workspaceId?: string } }) => {
      if (typeof args.where.id !== "string") return { position: 0 };
      const row = PAGE_ROWS[args.where.id];
      if (!row || row.workspaceId !== args.where.workspaceId) return null;
      return { id: row.id };
    },
  );

  db.pageFindMany.mockResolvedValue([]);
  db.pageCreate.mockResolvedValue({ id: "page-new" });
  db.pageUpdate.mockResolvedValue({ id: "page-new" });
  db.propertyFindMany.mockResolvedValue([]);
  db.databaseViewFindMany.mockResolvedValue([]);
  db.templateFindMany.mockResolvedValue([]);
  db.workspaceFindUnique.mockResolvedValue({ slug: "workspace-a" });
  db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      page: { findFirst: db.pageFindFirst, create: db.pageCreate, createMany: db.pageCreateMany },
    }),
  );

  db.chatMessageFindUnique.mockResolvedValue({
    id: "msg-1",
    role: "assistant",
    body: "The answer.",
    meta: null,
    thread: {
      id: "thread-1",
      workspaceId: WORKSPACE_A,
      pageId: FOREIGN_PARENT,
      title: "Discussion",
    },
  });
});

describe("saveChatAnswerAction — parent scope (B08)", () => {
  it("refuses a discussion whose page lives in another workspace and writes nothing", async () => {
    const result = await saveChatAnswerAction("msg-1");

    expect(result).toEqual({ error: PARENT_ERROR });
    expect(db.pageCreate).not.toHaveBeenCalled();
  });
});

describe("duplicatePageAction — parent scope (B08)", () => {
  it("refuses a page whose parent lives in another workspace and copies nothing", async () => {
    const result = await duplicatePageAction("page-a");

    expect(result).toEqual({ error: PARENT_ERROR });
    expect(db.pageCreate).not.toHaveBeenCalled();
  });
});

describe("duplicatePageSubtreeAction — parent scope (B08)", () => {
  it("refuses a page whose parent lives in another workspace and copies nothing", async () => {
    db.pageFindMany.mockResolvedValue([{ ...PAGE_ROWS["page-a"] }]);

    const result = await duplicatePageSubtreeAction("page-a");

    expect(result).toEqual({ error: PARENT_ERROR });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.pageCreate).not.toHaveBeenCalled();
  });
});

describe("duplicateDatabaseAction — parent scope (B08)", () => {
  it("refuses a database whose parent lives in another workspace and clones nothing", async () => {
    const result = await duplicateDatabaseAction("db-a");

    expect(result).toEqual({ error: PARENT_ERROR });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.pageCreate).not.toHaveBeenCalled();
  });
});
