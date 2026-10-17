import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B08 — the PDF text-layer import path (`src/server/actions/import-pdf.ts`).
 *
 * `POST /api/import/pdf` takes `parentId` straight from the request body and
 * hands it to `importPdfTextAction`, which used to write it into
 * `prisma.page.create` unchecked. `Page.parentId` is a plain foreign key, so a
 * member of workspace A could file the imported page under a page in
 * workspace B: the row then shows up in B's database view and in B's CSV/JSON
 * database export, and Postgres' `onDelete: Cascade` deletes it together with
 * B's parent — outside A's tenant boundary.
 *
 * These tests run the REAL action (the real `assertScopedParent`); only the
 * transport edges (prisma, auth, permissions, cache) are mocked. Both the
 * refusal and the legitimate same-workspace case are pinned, so the guard can
 * neither be dropped nor over-block.
 */

const WORKSPACE_A = "ws-a";
const WORKSPACE_B = "ws-b";
const PAGE_A = "page-a";
const DATABASE_B = "database-b";

/** Two workspaces: `page-a` in A, `database-b` in B. */
const PAGES = [
  { id: PAGE_A, workspaceId: WORKSPACE_A },
  { id: DATABASE_B, workspaceId: WORKSPACE_B },
];

const db = vi.hoisted(() => ({
  pageFindFirst: vi.fn(),
  pageCreate: vi.fn(),
  workspaceFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findFirst: db.pageFindFirst, create: db.pageCreate },
    workspace: { findUnique: db.workspaceFindUnique },
  },
}));

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: vi.fn(async () => ({ role: "MEMBER" })),
  canEditContent: vi.fn(() => true),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { importPdfTextAction } from "./import-pdf";

/** A text layer the engine turns into at least one block. */
const TEXT = "Hello from a PDF text layer.";

beforeEach(() => {
  vi.clearAllMocks();

  // `findFirst` serves two shapes: the tenant-scoped parent lookup
  // (`where.id` + `where.workspaceId`) and the sibling-position lookup
  // (`where.parentId`). A page of another workspace is never returned by the
  // scoped lookup — that is what the database would do.
  db.pageFindFirst.mockImplementation(
    async (args: {
      where: { id?: string; workspaceId?: string; parentId?: string | null };
      select?: Record<string, boolean>;
    }) => {
      const where = args.where;
      if (typeof where.id === "string") {
        const row = PAGES.find(
          (page) => page.id === where.id && page.workspaceId === where.workspaceId,
        );
        return row ? { id: row.id } : null;
      }
      return { position: 0 };
    },
  );

  db.pageCreate.mockResolvedValue({ id: "page-new" });
  db.workspaceFindUnique.mockResolvedValue({ slug: "workspace-a" });
});

describe("importPdfTextAction — parent scope (B08)", () => {
  it("refuses a parent from another workspace and writes nothing", async () => {
    const result = await importPdfTextAction({
      workspaceId: WORKSPACE_A,
      parentId: DATABASE_B,
      filename: "notes.pdf",
      text: TEXT,
    });

    expect(result).toEqual({
      error: "That parent page does not exist in this workspace.",
    });
    expect(db.pageCreate).not.toHaveBeenCalled();
  });

  it("imports the page under a parent of its own workspace", async () => {
    const result = await importPdfTextAction({
      workspaceId: WORKSPACE_A,
      parentId: PAGE_A,
      filename: "notes.pdf",
      text: TEXT,
    });

    expect(result).toMatchObject({ ok: true, id: "page-new" });
    expect(db.pageCreate).toHaveBeenCalledTimes(1);
    expect(db.pageCreate.mock.calls[0][0].data.parentId).toBe(PAGE_A);
  });

  it("imports the page at the workspace root when no parent is given", async () => {
    const result = await importPdfTextAction({
      workspaceId: WORKSPACE_A,
      filename: "notes.pdf",
      text: TEXT,
    });

    expect(result).toMatchObject({ ok: true, id: "page-new" });
    expect(db.pageCreate.mock.calls[0][0].data.parentId).toBeNull();
  });

  it("never names the foreign page in the rejection", async () => {
    const result = await importPdfTextAction({
      workspaceId: WORKSPACE_A,
      parentId: DATABASE_B,
      text: TEXT,
    });

    const message = "error" in result ? result.error : "";
    expect(message).not.toContain(DATABASE_B);
    expect(message).not.toContain(WORKSPACE_B);
  });
});
