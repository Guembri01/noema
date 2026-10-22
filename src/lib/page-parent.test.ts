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
  assertEditableParent,
  assertScopedParent,
  INVALID_PARENT_ERROR,
  PARENT_EDIT_ERROR,
  SELF_PARENT_ERROR,
} from "./page-parent";

/** The pages that exist in the fake database, across two workspaces. */
const PAGES = [
  { id: "page-parent", workspaceId: "ws-1", deletedAt: null },
  { id: "page-read", workspaceId: "ws-1", deletedAt: null },
  { id: "page-foreign", workspaceId: "ws-2", deletedAt: null },
  // A page in the trash of the *same* workspace: it is not a usable parent.
  { id: "page-trashed", workspaceId: "ws-1", deletedAt: new Date("2026-01-02T03:04:05.000Z") },
];

/** The fake page-permission rows, keyed by page id. */
const PERMISSIONS: Record<string, { level: string }[]> = {
  "page-read": [{ level: "READ" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  // The helper's lookup is tenant-scoped in the query, so a page of another
  // workspace exists but is never returned. A trashed page is not returned
  // either — the query asks for the live rows.
  db.pageFindFirst.mockImplementation(
    async (args: { where: { id: string; workspaceId: string; deletedAt?: null } }) => {
      const row = PAGES.find(
        (page) => page.id === args.where.id && page.workspaceId === args.where.workspaceId,
      );
      if (!row) return null;
      if (args.where.deletedAt === null && row.deletedAt !== null) return null;
      return { id: row.id, permissions: PERMISSIONS[row.id] ?? [] };
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
      where: { id: "page-parent", workspaceId: "ws-1", deletedAt: null },
      select: { id: true },
    });
  });

  it("refuses a parent that is in the trash of the same workspace", async () => {
    // A trashed parent would hide the new page (the tree drops rows whose
    // parent is gone) and take it down with the parent's own purge.
    await expect(
      assertScopedParent({ workspaceId: "ws-1", parentId: "page-trashed" }),
    ).resolves.toEqual({ error: INVALID_PARENT_ERROR });
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

describe("assertEditableParent", () => {
  const base = { workspaceId: "ws-1", userId: "member-1", role: "MEMBER" as const };

  it("accepts the workspace root without a permission lookup", async () => {
    await expect(assertEditableParent(base)).resolves.toEqual({
      ok: true,
      parentId: null,
    });
    expect(db.pageFindFirst).not.toHaveBeenCalled();
  });

  it("accepts a parent with no restriction row", async () => {
    await expect(
      assertEditableParent({ ...base, parentId: "page-parent" }),
    ).resolves.toEqual({ ok: true, parentId: "page-parent" });
  });

  it("refuses a parent the member may only read", async () => {
    await expect(
      assertEditableParent({ ...base, parentId: "page-read" }),
    ).resolves.toEqual({ error: PARENT_EDIT_ERROR });
  });

  it("keeps an admin/owner immune from a READ parent row", async () => {
    await expect(
      assertEditableParent({ ...base, parentId: "page-read", role: "ADMIN" }),
    ).resolves.toEqual({ ok: true, parentId: "page-read" });
    await expect(
      assertEditableParent({ ...base, parentId: "page-read", role: "OWNER" }),
    ).resolves.toEqual({ ok: true, parentId: "page-read" });
  });

  it("still refuses a foreign parent before looking at permissions", async () => {
    await expect(
      assertEditableParent({ ...base, parentId: "page-foreign" }),
    ).resolves.toEqual({ error: INVALID_PARENT_ERROR });
  });
});
