import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B08 — the parent-page scope guard (`src/lib/page-parent.ts`).
 *
 * `Page.parentId` is a plain foreign key, so the application is the only
 * thing that keeps a page inside its own workspace. These tests pin the one
 * helper every write path uses for that: a parent is only accepted when it
 * lives in the caller's workspace, and the rejection never names a foreign
 * page.
 */

const db = vi.hoisted(() => ({ pageFindFirst: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { page: { findFirst: db.pageFindFirst } },
}));

import {
  assertScopedParent,
  INVALID_PARENT_ERROR,
  SELF_PARENT_ERROR,
} from "./page-parent";

/** The pages that exist in the fake database, across two workspaces. */
const PAGES = [
  { id: "page-parent", workspaceId: "ws-1" },
  { id: "page-foreign", workspaceId: "ws-2" },
];

beforeEach(() => {
  vi.clearAllMocks();
  // The helper's lookup is tenant-scoped in the query, so a page of another
  // workspace exists but is never returned.
  db.pageFindFirst.mockImplementation(
    async (args: { where: { id: string; workspaceId: string } }) => {
      const row = PAGES.find(
        (page) => page.id === args.where.id && page.workspaceId === args.where.workspaceId,
      );
      return row ? { id: row.id } : null;
    },
  );
});

describe("assertScopedParent", () => {
  it("accepts no parent — the workspace root is always allowed", async () => {
    await expect(assertScopedParent({ workspaceId: "ws-1" })).resolves.toEqual({
      ok: true,
      parentId: null,
    });
    await expect(
      assertScopedParent({ workspaceId: "ws-1", parentId: null }),
    ).resolves.toEqual({ ok: true, parentId: null });
    await expect(
      assertScopedParent({ workspaceId: "ws-1", parentId: "  " }),
    ).resolves.toEqual({ ok: true, parentId: null });
    expect(db.pageFindFirst).not.toHaveBeenCalled();
  });

  it("accepts a parent that lives in the same workspace", async () => {
    await expect(
      assertScopedParent({ workspaceId: "ws-1", parentId: "page-parent" }),
    ).resolves.toEqual({ ok: true, parentId: "page-parent" });
    expect(db.pageFindFirst).toHaveBeenCalledWith({
      where: { id: "page-parent", workspaceId: "ws-1" },
      select: { id: true },
    });
  });

  it("refuses a parent from another workspace", async () => {
    await expect(
      assertScopedParent({ workspaceId: "ws-1", parentId: "page-foreign" }),
    ).resolves.toEqual({ error: INVALID_PARENT_ERROR });
  });

  it("refuses a parent that does not exist", async () => {
    await expect(
      assertScopedParent({ workspaceId: "ws-1", parentId: "page-missing" }),
    ).resolves.toEqual({ error: INVALID_PARENT_ERROR });
  });

  it("refuses the page itself as its own parent", async () => {
    await expect(
      assertScopedParent({ workspaceId: "ws-1", parentId: "page-parent", pageId: "page-parent" }),
    ).resolves.toEqual({ error: SELF_PARENT_ERROR });
    expect(db.pageFindFirst).not.toHaveBeenCalled();
  });

  it("fails closed on a blank workspace id", async () => {
    await expect(
      assertScopedParent({ workspaceId: "", parentId: "page-parent" }),
    ).resolves.toEqual({ error: INVALID_PARENT_ERROR });
  });

  it("never leaks the foreign workspace in the rejection", async () => {
    const result = await assertScopedParent({
      workspaceId: "ws-1",
      parentId: "page-foreign",
    });
    expect("error" in result ? result.error : "").not.toContain("ws-2");
    expect("error" in result ? result.error : "").not.toContain("page-foreign");
  });
});
