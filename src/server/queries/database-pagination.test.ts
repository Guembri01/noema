import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Database row keyset pagination: the initial window returns at most
 * `rowLimit` rows plus an opaque cursor, and the next window uses the
 * `(position, id)` tuple so it neither repeats nor skips a row.
 */

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  pageFindMany: vi.fn(),
  propertyFindMany: vi.fn(),
  viewFindMany: vi.fn(),
  templateFindMany: vi.fn(),
  dependencyFindMany: vi.fn(),
  activityFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: db.pageFindUnique, findMany: db.pageFindMany },
    property: { findMany: db.propertyFindMany },
    databaseView: { findMany: db.viewFindMany },
    template: { findMany: db.templateFindMany },
    rowDependency: { findMany: db.dependencyFindMany },
    activity: { findMany: db.activityFindMany },
  },
}));

import { decodeCursor } from "@/lib/cursor-pagination";
import { getDatabase } from "./database";

function row(index: number) {
  return {
    id: `row-${String(index).padStart(3, "0")}`,
    title: `Row ${index}`,
    icon: null,
    subOfId: null,
    position: index * 1000,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    createdBy: { name: "Ada" },
    propertyValues: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.pageFindUnique.mockResolvedValue({ workspaceId: "ws-1" });
  db.propertyFindMany.mockResolvedValue([]);
  db.viewFindMany.mockResolvedValue([]);
  db.templateFindMany.mockResolvedValue([]);
  db.dependencyFindMany.mockResolvedValue([]);
  db.activityFindMany.mockResolvedValue([]);
});

describe("getDatabase row pagination", () => {
  it("returns the first window and a (position, id) cursor", async () => {
    db.pageFindMany.mockResolvedValueOnce(
      Array.from({ length: 101 }, (_, index) => row(index)),
    );

    const page = await getDatabase("db-1", null, { rowLimit: 100 });

    expect(page.rows).toHaveLength(100);
    expect(page.rows[0].id).toBe("row-000");
    expect(page.rows[99].id).toBe("row-099");
    expect(page.nextRowCursor).toBeTruthy();
    expect(decodeCursor(page.nextRowCursor!)).toEqual({
      key: 99_000,
      tiebreaker: "row-099",
    });

    const args = db.pageFindMany.mock.calls[0][0];
    expect(args.take).toBe(101);
    expect(args.orderBy).toEqual([{ position: "asc" }, { id: "asc" }]);
    expect(args.where).toMatchObject({
      parentId: "db-1",
      workspaceId: "ws-1",
      deletedAt: null,
    });
  });

  it("feeds the cursor into the strict (position, id) boundary", async () => {
    db.pageFindMany.mockResolvedValueOnce(
      Array.from({ length: 101 }, (_, index) => row(index)),
    );
    const first = await getDatabase("db-1", null, { rowLimit: 100 });
    db.pageFindMany.mockResolvedValueOnce([row(100)]);

    const next = await getDatabase("db-1", null, {
      rowLimit: 100,
      rowCursor: first.nextRowCursor,
    });

    expect(next.nextRowCursor).toBeNull();
    expect(next.rows.map((entry) => entry.id)).toEqual(["row-100"]);
    const args = db.pageFindMany.mock.calls[1][0];
    expect(args.where.OR).toEqual([
      { position: { gt: 99_000 } },
      { position: 99_000, id: { gt: "row-099" } },
    ]);
  });

  it("keeps the historical unbounded read when no limit is supplied", async () => {
    db.pageFindMany.mockResolvedValueOnce([row(0), row(1)]);
    const page = await getDatabase("db-1");
    expect(page.rows).toHaveLength(2);
    expect(page.nextRowCursor).toBeNull();
    expect(db.pageFindMany.mock.calls[0][0].take).toBeUndefined();
  });
});
