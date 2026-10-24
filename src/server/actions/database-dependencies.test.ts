import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Row dependencies (R89.31): the write action behind the timeline arrows and
 * the row-peek blocker editor.
 *
 * The read path (`getDatabase`) projects the persisted edges; this suite pins
 * the write invariants: same live database rows, edit rights on both rows,
 * no self-edge, no cycle, the 500-edge cap, and idempotent add/remove.
 */

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  pageFindMany: vi.fn(),
  rowDependencyFindMany: vi.fn(),
  rowDependencyUpsert: vi.fn(),
  rowDependencyDeleteMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: {
      findUnique: db.pageFindUnique,
      findMany: db.pageFindMany,
    },
    rowDependency: {
      findMany: db.rowDependencyFindMany,
      upsert: db.rowDependencyUpsert,
      deleteMany: db.rowDependencyDeleteMany,
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

import { setRowDependencyAction } from "./database";

const DATABASE_ID = "db-1";
const BLOCKER_ID = "row-a";
const BLOCKED_ID = "row-b";

const database = {
  id: DATABASE_ID,
  workspaceId: "ws-1",
  type: "DATABASE",
  schemaLocked: false,
  permissions: [],
};

function row(id: string, level?: "READ" | "COMMENT" | "EDIT" | "FULL") {
  return { id, permissions: level ? [{ level }] : [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.pageFindUnique.mockResolvedValue(database);
  db.pageFindMany.mockResolvedValue([row(BLOCKER_ID), row(BLOCKED_ID)]);
  db.rowDependencyFindMany.mockResolvedValue([]);
  db.rowDependencyUpsert.mockResolvedValue({ id: "dep-1" });
  db.rowDependencyDeleteMany.mockResolvedValue({ count: 1 });
});

describe("setRowDependencyAction", () => {
  it("persists a blocking edge scoped to the two rows", async () => {
    await expect(
      setRowDependencyAction(DATABASE_ID, BLOCKER_ID, BLOCKED_ID, true),
    ).resolves.toEqual({ ok: true });

    expect(db.pageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          parentId: DATABASE_ID,
          workspaceId: "ws-1",
          deletedAt: null,
        },
      }),
    );
    expect(db.rowDependencyUpsert).toHaveBeenCalledWith({
      where: {
        blockerId_blockedId: {
          blockerId: BLOCKER_ID,
          blockedId: BLOCKED_ID,
        },
      },
      create: { blockerId: BLOCKER_ID, blockedId: BLOCKED_ID },
      update: {},
    });
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        actorId: "actor",
        action: "row.edited",
        targetId: BLOCKED_ID,
        meta: { dependency: "added", blockerId: BLOCKER_ID },
      }),
    );
  });

  it("removes an existing edge idempotently", async () => {
    await expect(
      setRowDependencyAction(DATABASE_ID, BLOCKER_ID, BLOCKED_ID, false),
    ).resolves.toEqual({ ok: true });

    expect(db.rowDependencyDeleteMany).toHaveBeenCalledWith({
      where: { blockerId: BLOCKER_ID, blockedId: BLOCKED_ID },
    });
    expect(db.rowDependencyUpsert).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: { dependency: "removed", blockerId: BLOCKER_ID },
      }),
    );
  });

  it("replays an already-linked edge without hitting the cap", async () => {
    db.rowDependencyFindMany.mockResolvedValue(
      Array.from({ length: 500 }, (_, index) => ({
        blockerId: index === 0 ? BLOCKER_ID : `row-${index}`,
        blockedId: index === 0 ? BLOCKED_ID : `row-${index + 1}`,
      })),
    );

    await expect(
      setRowDependencyAction(DATABASE_ID, BLOCKER_ID, BLOCKED_ID, true),
    ).resolves.toEqual({ ok: true });
    expect(db.rowDependencyUpsert).toHaveBeenCalled();
    // A replay is not an edit: it must not move the blocked row's editor.
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("does not log a removal that removed nothing", async () => {
    db.rowDependencyDeleteMany.mockResolvedValue({ count: 0 });
    await expect(
      setRowDependencyAction(DATABASE_ID, BLOCKER_ID, BLOCKED_ID, false),
    ).resolves.toEqual({ ok: true });
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("refuses a row as its own blocker", async () => {
    await expect(
      setRowDependencyAction(DATABASE_ID, BLOCKER_ID, BLOCKER_ID, true),
    ).resolves.toEqual({ error: "A row cannot depend on itself." });
    expect(db.pageFindMany).not.toHaveBeenCalled();
    expect(db.rowDependencyUpsert).not.toHaveBeenCalled();
  });

  it("refuses a row from another database or a deleted row", async () => {
    db.pageFindMany.mockResolvedValue([row(BLOCKER_ID)]);
    await expect(
      setRowDependencyAction(DATABASE_ID, BLOCKER_ID, BLOCKED_ID, true),
    ).resolves.toEqual({ error: "Row not found." });
    expect(db.rowDependencyUpsert).not.toHaveBeenCalled();
  });

  it("requires edit rights on both rows", async () => {
    db.pageFindMany.mockResolvedValue([row(BLOCKER_ID, "READ"), row(BLOCKED_ID)]);
    await expect(
      setRowDependencyAction(DATABASE_ID, BLOCKER_ID, BLOCKED_ID, true),
    ).resolves.toEqual({ error: "No permission." });
    expect(db.rowDependencyUpsert).not.toHaveBeenCalled();
  });

  it("refuses an edge that would close a dependency cycle", async () => {
    db.rowDependencyFindMany.mockResolvedValue([
      { blockerId: BLOCKED_ID, blockedId: BLOCKER_ID },
    ]);
    await expect(
      setRowDependencyAction(DATABASE_ID, BLOCKER_ID, BLOCKED_ID, true),
    ).resolves.toEqual({ error: "That would create a dependency cycle." });
    expect(db.rowDependencyUpsert).not.toHaveBeenCalled();
  });

  it("caps a database at 500 blocking edges", async () => {
    db.rowDependencyFindMany.mockResolvedValue(
      Array.from({ length: 500 }, (_, index) => ({
        blockerId: `row-${index}`,
        blockedId: `row-${index + 1}`,
      })),
    );
    await expect(
      setRowDependencyAction(DATABASE_ID, BLOCKER_ID, BLOCKED_ID, true),
    ).resolves.toEqual({ error: "This database has too many dependencies." });
    expect(db.rowDependencyUpsert).not.toHaveBeenCalled();
  });
});
