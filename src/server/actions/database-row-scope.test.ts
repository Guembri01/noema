import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B96 — the **write side** of the tenant boundary for database rows.
 *
 * A row that was linked across the workspace boundary before the check existed
 * still carries the `workspaceId` of the foreign workspace, while the database
 * it hangs under belongs to the caller's workspace. The read paths filter such
 * a row out of every view, so it is invisible — but the write paths
 * (`setPropertyValueAction`, `deleteRowAction`) authorised against the
 * *database* and wrote into that foreign row anyway, filing the activity
 * entry under the foreign workspace.
 *
 * The rule the read side already uses: a row belongs to the workspace of the
 * database it hangs under. A row whose own `workspaceId` differs is a legacy
 * row — it must not be written either, and the answer must be the same as for
 * a row that does not exist (no existence oracle).
 *
 * Only the transport edges are mocked (`@/lib/db`, `@/lib/auth`,
 * `getWorkspaceAccess`, `next/cache`); the action logic runs for real. The
 * fake database applies the filters the real one would apply — a `where` with
 * a `workspaceId` filters by it, and the `select` is applied faithfully — so
 * a missing check in the action shows up here instead of passing silently.
 */

const WORKSPACE_A = "ws-a";
const WORKSPACE_B = "ws-b";
const DATABASE_A = "db-a";

/** The columns of the fake database — `prop-1` belongs to `db-a`. */
const PROPERTIES = [{ id: "prop-1", databasePageId: DATABASE_A }];

type FakePage = {
  id: string;
  workspaceId: string;
  parentId: string | null;
  type: string;
  schemaLocked: boolean;
};

/**
 * The pages of the fake database:
 *
 *   - `row-a` — a normal row of the database in workspace A,
 *   - `row-legacy` — the legacy row of the finding: it hangs under the
 *     database of workspace A but still carries the `workspaceId` of
 *     workspace B (it was linked across the boundary before the workspace
 *     check existed).
 *
 * `row-missing` does not exist — it is the reference for "Row not found.".
 */
const PAGES: FakePage[] = [
  {
    id: DATABASE_A,
    workspaceId: WORKSPACE_A,
    parentId: null,
    type: "DATABASE",
    schemaLocked: false,
  },
  {
    id: "row-a",
    workspaceId: WORKSPACE_A,
    parentId: DATABASE_A,
    type: "PAGE",
    schemaLocked: false,
  },
  {
    id: "row-legacy",
    workspaceId: WORKSPACE_B,
    parentId: DATABASE_A,
    type: "PAGE",
    schemaLocked: false,
  },
];

const h = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  pageUpdate: vi.fn(),
  propertyFindFirst: vi.fn(),
  propertyValueUpsert: vi.fn(),
  activityCreate: vi.fn(),
  requireUser: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: {
      findUnique: h.pageFindUnique,
      update: h.pageUpdate,
    },
    property: { findFirst: h.propertyFindFirst },
    propertyValue: { upsert: h.propertyValueUpsert },
    activity: { create: h.activityCreate },
  },
}));

vi.mock("@/lib/auth", () => ({ requireUser: h.requireUser }));

// Only the membership lookup is mocked — the role check (`canEditContent`)
// stays the real one.
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: h.getWorkspaceAccess };
});

vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));

import { deleteRowAction, setPropertyValueAction } from "./database";

/** The `data` of the activity entries the action wrote. */
function activityWorkspaces(): string[] {
  return h.activityCreate.mock.calls.map(
    (call) => (call[0] as { data: { workspaceId: string } }).data.workspaceId,
  );
}

/** The error message of a result, or `null` when the action succeeded. */
function errorOf(result: unknown): string | null {
  return result && typeof result === "object" && "error" in result
    ? String((result as { error: string }).error)
    : null;
}

beforeEach(() => {
  vi.clearAllMocks();

  h.requireUser.mockResolvedValue({
    id: "user-1",
    email: "member@example.test",
    name: "Member",
    avatarUrl: null,
    theme: "system",
    locale: "en",
  });
  h.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

  // The fake database applies the filters the real one would: the `where`
  // clause is honoured (including a `workspaceId`, when the action asks for
  // one) and the `select` decides which fields come back. The row lookup in
  // the action carries **no** workspace filter — exactly like the production
  // query — so the legacy row is returned, as it is in the database.
  h.pageFindUnique.mockImplementation(
    async (args: {
      where: { id?: string; workspaceId?: string };
      select?: Record<string, boolean>;
    }) => {
      const where = args.where ?? {};
      const page = PAGES.find((candidate) => {
        if (where.id !== undefined && candidate.id !== where.id) return false;
        if (
          where.workspaceId !== undefined &&
          candidate.workspaceId !== where.workspaceId
        ) {
          return false;
        }
        return true;
      });
      if (!page) return null;
      if (!args.select) return { ...page };
      const selected: Record<string, unknown> = {};
      for (const [field, wanted] of Object.entries(args.select)) {
        if (wanted) selected[field] = page[field as keyof FakePage];
      }
      return selected;
    },
  );

  h.pageUpdate.mockResolvedValue({ id: "row-a" });
  h.propertyValueUpsert.mockResolvedValue({ id: "cell-1" });
  h.activityCreate.mockResolvedValue({ id: "activity-1" });

  // The columns of the fake database: `prop-1` is a column of the database
  // `db-a`. A column of another database is not found — the fake applies the
  // filter the real database applies (the property binding of B99).
  h.propertyFindFirst.mockImplementation(
    async (args: { where: { id?: string; databasePageId?: string } }) => {
      const where = args.where ?? {};
      const property = PROPERTIES.find(
        (candidate) =>
          (where.id === undefined || candidate.id === where.id) &&
          (where.databasePageId === undefined ||
            candidate.databasePageId === where.databasePageId),
      );
      return property ? { id: property.id } : null;
    },
  );
});

describe("setPropertyValueAction — row scope (B96)", () => {
  it("does not write a cell value into a legacy row of another workspace", async () => {
    const result = await setPropertyValueAction("row-legacy", "prop-1", {
      text: "written from A",
    });

    expect(result).toEqual({ error: "Row not found." });
    expect(h.propertyValueUpsert).not.toHaveBeenCalled();
    expect(h.activityCreate).not.toHaveBeenCalled();
  });

  it("answers a legacy row exactly like a row that does not exist", async () => {
    const legacy = await setPropertyValueAction("row-legacy", "prop-1", {
      text: "written from A",
    });
    const missing = await setPropertyValueAction("row-missing", "prop-1", {
      text: "written from A",
    });

    expect(errorOf(missing)).toBe("Row not found.");
    expect(errorOf(legacy)).toBe(errorOf(missing));
    expect(h.propertyValueUpsert).not.toHaveBeenCalled();
  });

  it("writes the value of a row of the caller's own workspace", async () => {
    const result = await setPropertyValueAction("row-a", "prop-1", {
      text: "A's value",
    });

    expect(result).toEqual({ ok: true });
    expect(h.propertyValueUpsert).toHaveBeenCalledTimes(1);
    expect(h.propertyValueUpsert.mock.calls[0][0]).toMatchObject({
      where: { propertyId_pageId: { propertyId: "prop-1", pageId: "row-a" } },
      create: { propertyId: "prop-1", pageId: "row-a", value: { text: "A's value" } },
    });
  });

  it("files the activity entry in the workspace of the row", async () => {
    await setPropertyValueAction("row-a", "prop-1", { text: "A's value" });

    expect(h.activityCreate).toHaveBeenCalledTimes(1);
    expect(activityWorkspaces()).toEqual([WORKSPACE_A]);
  });

  it("never names a foreign workspace in an activity entry", async () => {
    await setPropertyValueAction("row-a", "prop-1", { text: "A's value" });
    await setPropertyValueAction("row-legacy", "prop-1", { text: "written from A" });

    expect(activityWorkspaces()).not.toContain(WORKSPACE_B);
    expect(activityWorkspaces().every((id) => id === WORKSPACE_A)).toBe(true);
  });
});

describe("deleteRowAction — row scope (B96)", () => {
  it("does not soft-delete a legacy row of another workspace", async () => {
    const result = await deleteRowAction("row-legacy");

    expect(result).toEqual({ error: "Row not found." });
    expect(h.pageUpdate).not.toHaveBeenCalled();
  });

  it("answers a legacy row exactly like a row that does not exist", async () => {
    const legacy = await deleteRowAction("row-legacy");
    const missing = await deleteRowAction("row-missing");

    expect(errorOf(missing)).toBe("Row not found.");
    expect(errorOf(legacy)).toBe(errorOf(missing));
    expect(h.pageUpdate).not.toHaveBeenCalled();
  });

  it("soft-deletes a row of the caller's own workspace", async () => {
    const result = await deleteRowAction("row-a");

    expect(result).toEqual({ ok: true });
    expect(h.pageUpdate).toHaveBeenCalledTimes(1);
    const update = h.pageUpdate.mock.calls[0][0] as {
      where: { id: string };
      data: { deletedAt: Date; isArchived: boolean };
    };
    expect(update.where.id).toBe("row-a");
    expect(update.data.deletedAt).toBeInstanceOf(Date);
    expect(update.data.isArchived).toBe(true);
  });
});
