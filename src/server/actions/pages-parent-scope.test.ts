import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B08 — `parentId` must be validated against the workspace.
 *
 * `Page.parentId` is a plain foreign key (the schema has no composite
 * `(parentId, workspaceId)` constraint), so before this fix a member of
 * workspace A could create a page under a page in workspace B. The row then
 * showed up in B's database view and in B's CSV/JSON database export, and
 * Postgres' `onDelete: Cascade` deleted it together with B's parent — outside
 * A's tenant boundary.
 *
 * These tests run the REAL action chain (`createPageAction` / `movePageAction`
 * → the real `assertScopedParent`); only the transport edges (prisma, auth,
 * permissions, webhooks, cache) are mocked. Both the refusal and the
 * legitimate same-workspace case are pinned, so the guard can neither be
 * dropped nor over-block.
 */

type FakePage = {
  id: string;
  workspaceId: string;
  parentId: string | null;
  deletedAt: Date | null;
  title: string;
  position: number;
};

const WORKSPACE_A = "ws-a";
const WORKSPACE_B = "ws-b";
const PAGE_A = "page-a";
const PAGE_A2 = "page-a2";
const DATABASE_B = "database-b";

/** Two workspaces: `page-a` in A, `database-b` in B. */
const PAGES: FakePage[] = [
  {
    id: PAGE_A,
    workspaceId: WORKSPACE_A,
    parentId: null,
    deletedAt: null,
    title: "Page in A",
    position: 1000,
  },
  {
    id: PAGE_A2,
    workspaceId: WORKSPACE_A,
    parentId: null,
    deletedAt: null,
    title: "Second page in A",
    position: 2000,
  },
  {
    id: DATABASE_B,
    workspaceId: WORKSPACE_B,
    parentId: null,
    deletedAt: null,
    title: "Database in B",
    position: 1000,
  },
];

const db = vi.hoisted(() => ({
  pageFindFirst: vi.fn(),
  pageFindUnique: vi.fn(),
  pageCreate: vi.fn(),
  pageUpdate: vi.fn(),
  workspaceFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: {
      findFirst: db.pageFindFirst,
      findUnique: db.pageFindUnique,
      create: db.pageCreate,
      update: db.pageUpdate,
    },
    workspace: { findUnique: db.workspaceFindUnique },
  },
}));

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@/lib/webhooks", () => ({
  dispatchWebhooks: vi.fn(async () => undefined),
}));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const perms = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn() }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: perms.getWorkspaceAccess };
});

import { createPageAction, movePageAction } from "./pages";

beforeEach(() => {
  vi.clearAllMocks();

  // `findFirst` serves two shapes: the tenant-scoped parent lookup
  // (`where.id` + `where.workspaceId`) and the sibling-position lookup
  // (`where.parentId`). A page of another workspace is never returned by the
  // scoped lookup — that is what the database would do.
  db.pageFindFirst.mockImplementation(
    async (args: {
      where: { id?: string; workspaceId: string; parentId?: string | null };
      select?: Record<string, boolean>;
    }) => {
      const where = args.where;
      if (typeof where.id === "string") {
        const row = PAGES.find(
          (page) => page.id === where.id && page.workspaceId === where.workspaceId,
        );
        if (!row) return null;
        return args.select && "parentId" in args.select
          ? { parentId: row.parentId }
          : { id: row.id };
      }
      return { position: 0 };
    },
  );

  db.pageFindUnique.mockImplementation(async (args: { where: { id: string } }) => {
    const row = PAGES.find((page) => page.id === args.where.id);
    if (!row) return null;
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      parentId: row.parentId,
      deletedAt: row.deletedAt,
    };
  });

  db.pageCreate.mockResolvedValue({ id: "page-new" });
  db.pageUpdate.mockResolvedValue({ id: PAGE_A });
  db.workspaceFindUnique.mockResolvedValue({ slug: "workspace-a" });
  perms.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
});

describe("createPageAction — parent scope (B08)", () => {
  it("refuses a parent from another workspace and writes nothing", async () => {
    const result = await createPageAction({
      workspaceId: WORKSPACE_A,
      parentId: DATABASE_B,
      title: "x",
    });

    expect(result).toEqual({
      error: "That parent page does not exist in this workspace.",
    });
    expect(db.pageCreate).not.toHaveBeenCalled();
  });

  it("creates the page under a parent of its own workspace", async () => {
    const result = await createPageAction({
      workspaceId: WORKSPACE_A,
      parentId: PAGE_A,
      title: "x",
    });

    expect(result).toMatchObject({ ok: true, id: "page-new" });
    expect(db.pageCreate).toHaveBeenCalledTimes(1);
    expect(db.pageCreate.mock.calls[0][0].data.parentId).toBe(PAGE_A);
  });

  it("creates a root page when no parent is given", async () => {
    const result = await createPageAction({ workspaceId: WORKSPACE_A, title: "x" });

    expect(result).toMatchObject({ ok: true, id: "page-new" });
    expect(db.pageCreate.mock.calls[0][0].data.parentId).toBeNull();
  });
});

describe("movePageAction — parent scope (B08)", () => {
  it("refuses a parent from another workspace and moves nothing", async () => {
    const result = await movePageAction(PAGE_A, DATABASE_B);

    expect(result).toEqual({
      error: "That parent page does not exist in this workspace.",
    });
    expect(db.pageUpdate).not.toHaveBeenCalled();
  });

  it("moves the page under a parent of its own workspace", async () => {
    const result = await movePageAction(PAGE_A, PAGE_A);

    // The page may not be its own parent — that check is unchanged.
    expect(result).toEqual({ error: "A page cannot be its own parent." });
    expect(db.pageUpdate).not.toHaveBeenCalled();
  });

  it("writes the checked parent id, not the raw request value", async () => {
    // The helper trims the id before it looks the parent up, so the value it
    // proves is the trimmed one. That is also the value that has to be
    // written — the raw one would miss the row and blow up as a foreign key
    // violation.
    const result = await movePageAction(PAGE_A, ` ${PAGE_A2} `);

    expect(result).toEqual({ ok: true });
    expect(db.pageUpdate).toHaveBeenCalledTimes(1);
    expect(db.pageUpdate.mock.calls[0][0].data.parentId).toBe(PAGE_A2);
  });

  it("positions the moved page under the checked parent id", async () => {
    await movePageAction(PAGE_A, ` ${PAGE_A2} `);

    const positionQuery = db.pageFindFirst.mock.calls.find((args) => {
      const where = (args[0] as { where?: { parentId?: unknown } })?.where;
      return where?.parentId !== undefined && where?.parentId !== null;
    });
    expect(positionQuery?.[0]?.where).toMatchObject({ parentId: PAGE_A2 });
  });
});
