import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Persisted sub-items (R89.30): the server side of the one-level tree.
 *
 * The read path carries `Page.subOfId`; this test pins the write action's
 * scope, permission and depth rules, then asserts the single persisted edge.
 */

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  pageCount: vi.fn(),
  pageUpdate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: {
      findUnique: db.pageFindUnique,
      count: db.pageCount,
      update: db.pageUpdate,
    },
  },
}));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "actor" })),
}));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return {
    ...actual,
    getWorkspaceAccess: vi.fn(async () => ({ role: "MEMBER" })),
  };
});
const logActivity = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/activity", () => ({ logActivity }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { setSubItemParentAction } from "./database";

const ROW_ID = "row-1";
const PARENT_ID = "row-2";
const DATABASE_ID = "db-1";

const row = { parentId: DATABASE_ID, workspaceId: "ws-1", permissions: [] };
const database = {
  id: DATABASE_ID,
  workspaceId: "ws-1",
  type: "DATABASE",
  schemaLocked: false,
  permissions: [],
};
const parent = {
  parentId: DATABASE_ID,
  workspaceId: "ws-1",
  subOfId: null,
  deletedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  db.pageFindUnique.mockImplementation(
    ({ where }: { where: { id: string } }) => {
      if (where.id === ROW_ID) return Promise.resolve(row);
      if (where.id === DATABASE_ID) return Promise.resolve(database);
      if (where.id === PARENT_ID) return Promise.resolve(parent);
      return Promise.resolve(null);
    },
  );
  db.pageCount.mockResolvedValue(0);
  db.pageUpdate.mockResolvedValue({ id: ROW_ID });
});

describe("setSubItemParentAction", () => {
  it("persists a one-level parent edge", async () => {
    await expect(setSubItemParentAction(ROW_ID, PARENT_ID)).resolves.toEqual({ ok: true });
    expect(db.pageUpdate).toHaveBeenCalledWith({
      where: { id: ROW_ID },
      data: { subOfId: PARENT_ID },
    });
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        actorId: "actor",
        action: "row.edited",
        targetId: ROW_ID,
      }),
    );
  });

  it("promotes a row back to the top level", async () => {
    await expect(setSubItemParentAction(ROW_ID, null)).resolves.toEqual({ ok: true });
    expect(db.pageUpdate).toHaveBeenCalledWith({
      where: { id: ROW_ID },
      data: { subOfId: null },
    });
  });

  it("refuses a row as its own parent", async () => {
    await expect(setSubItemParentAction(ROW_ID, ROW_ID)).resolves.toEqual({
      error: "A row cannot be its own parent.",
    });
    expect(db.pageUpdate).not.toHaveBeenCalled();
  });

  it("refuses a parent in another database", async () => {
    db.pageFindUnique.mockImplementation(
      ({ where }: { where: { id: string } }) => {
        if (where.id === ROW_ID) return Promise.resolve(row);
        if (where.id === DATABASE_ID) return Promise.resolve(database);
        return Promise.resolve({ ...parent, parentId: "db-other" });
      },
    );
    await expect(setSubItemParentAction(ROW_ID, PARENT_ID)).resolves.toEqual({
      error: "Parent row not found.",
    });
    expect(db.pageUpdate).not.toHaveBeenCalled();
  });

  it("keeps the tree one level deep", async () => {
    db.pageFindUnique.mockImplementation(
      ({ where }: { where: { id: string } }) => {
        if (where.id === ROW_ID) return Promise.resolve(row);
        if (where.id === DATABASE_ID) return Promise.resolve(database);
        return Promise.resolve({ ...parent, subOfId: "row-0" });
      },
    );
    await expect(setSubItemParentAction(ROW_ID, PARENT_ID)).resolves.toEqual({
      error: "Sub-items can only be one level deep.",
    });
    expect(db.pageUpdate).not.toHaveBeenCalled();
  });

  it("refuses to nest a row that already has children", async () => {
    db.pageCount.mockResolvedValue(1);
    await expect(setSubItemParentAction(ROW_ID, PARENT_ID)).resolves.toEqual({
      error: "Move this row's sub-items out first.",
    });
    expect(db.pageUpdate).not.toHaveBeenCalled();
  });
});
