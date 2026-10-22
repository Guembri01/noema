import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for the page-level permission bypass: a workspace
 * MEMBER with a page `READ` or `COMMENT` row used to be able to call every
 * page/database mutation directly, because the actions only checked the
 * workspace role. Each action below is called the way a crafted request would
 * call it; the expected result is a refusal and no write.
 */
const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  pageFindFirst: vi.fn(),
  pageFindMany: vi.fn(),
  pageUpdate: vi.fn(),
  pageDeleteMany: vi.fn(),
  pageCreate: vi.fn(),
  pageVersionFindUnique: vi.fn(),
  pageVersionCreate: vi.fn(),
  propertyCreate: vi.fn(),
  propertyFindFirst: vi.fn(),
  propertyValueUpsert: vi.fn(),
  commentFindUnique: vi.fn(),
  commentCreate: vi.fn(),
  projectFindUnique: vi.fn(),
  teamspaceFindUnique: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: {
      findUnique: db.pageFindUnique,
      findFirst: db.pageFindFirst,
      findMany: db.pageFindMany,
      update: db.pageUpdate,
      deleteMany: db.pageDeleteMany,
      create: db.pageCreate,
    },
    pageVersion: {
      findUnique: db.pageVersionFindUnique,
      create: db.pageVersionCreate,
    },
    property: { create: db.propertyCreate, findFirst: db.propertyFindFirst },
    propertyValue: { upsert: db.propertyValueUpsert },
    comment: { findUnique: db.commentFindUnique, create: db.commentCreate },
    workspaceMember: { findFirst: vi.fn() },
    workspace: { findUnique: vi.fn() },
    pagePermission: { findMany: vi.fn(), upsert: vi.fn() },
    pageFollow: { deleteMany: vi.fn() },
    project: { findUnique: db.projectFindUnique },
    teamspace: { findUnique: db.teamspaceFindUnique },
    $transaction: db.transaction,
  },
}));

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "member-1", email: "member@example.test" })),
}));

vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: vi.fn(async () => ({ role: "MEMBER" })),
  canEditContent: vi.fn(() => true),
  canManageMembers: vi.fn(() => true),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn() }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: vi.fn() }));

import {
  archivePageAction,
  deletePageAction,
  movePageAction,
  restorePageAction,
  toggleSchemaLockAction,
  transferPageAction,
  updatePageAction,
} from "./pages";
import { createPropertyAction, deleteRowAction, setPropertyValueAction } from "./database";
import { addCommentAction } from "./comments";
import { duplicatePageAction } from "./page-menu";
import { duplicatePageSubtreeAction } from "./page-duplicate";
import { restorePageVersionAction } from "./page-versions";
import { createQuickStartAction } from "./home-templates";
import { setPageProjectAction } from "./projects";
import { setPageTeamspaceAction } from "./teamspaces";

const READ_PAGE = {
  id: "page-1",
  workspaceId: "ws-1",
  parentId: null,
  deletedAt: null,
  type: "PAGE",
  schemaLocked: false,
  permissions: [{ level: "READ" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  db.pageFindUnique.mockResolvedValue(READ_PAGE);
  db.pageFindFirst.mockResolvedValue(null);
  db.pageFindMany.mockResolvedValue([]);
  db.pageUpdate.mockResolvedValue({});
  db.pageDeleteMany.mockResolvedValue({ count: 1 });
  db.pageVersionCreate.mockResolvedValue({});
  db.propertyCreate.mockResolvedValue({ id: "property-1" });
  db.propertyFindFirst.mockResolvedValue({ position: 0 });
  db.commentCreate.mockResolvedValue({ id: "comment-1" });
  db.projectFindUnique.mockResolvedValue({ workspaceId: "ws-1" });
  db.teamspaceFindUnique.mockResolvedValue({ workspaceId: "ws-1" });
  db.transaction.mockImplementation(async (operations: unknown[]) => operations);
});

describe("a READ page row blocks every content mutation", () => {
  it("updatePageAction", async () => {
    const result = await updatePageAction("page-1", { title: "Changed" });
    expect(result).toEqual({
      error: "You do not have permission to edit this page.",
    });
    expect(db.pageUpdate).not.toHaveBeenCalled();
  });

  it("movePageAction", async () => {
    const result = await movePageAction("page-1", null);
    expect(result).toEqual({
      error: "You do not have permission to move this page.",
    });
    expect(db.pageUpdate).not.toHaveBeenCalled();
  });

  it("archivePageAction", async () => {
    const result = await archivePageAction("page-1");
    expect(result).toEqual({
      error: "You do not have permission to delete this page.",
    });
    expect(db.pageUpdate).not.toHaveBeenCalled();
  });

  it("restorePageAction", async () => {
    const result = await restorePageAction("page-1");
    expect(result).toEqual({
      error: "You do not have permission to restore this page.",
    });
    expect(db.pageUpdate).not.toHaveBeenCalled();
  });

  it("deletePageAction", async () => {
    const result = await deletePageAction("page-1", "ws-1");
    expect(result).toEqual({
      error: "You do not have permission to delete this page.",
    });
    expect(db.pageDeleteMany).not.toHaveBeenCalled();
  });

  it("transferPageAction", async () => {
    const result = await transferPageAction("page-1", "ws-2");
    expect(result).toEqual({
      error: "You do not have permission to move this page.",
    });
    expect(db.pageUpdate).not.toHaveBeenCalled();
  });

  it("toggleSchemaLockAction", async () => {
    db.pageFindUnique.mockResolvedValue({ ...READ_PAGE, type: "DATABASE" });
    const result = await toggleSchemaLockAction("page-1", true);
    expect(result).toEqual({
      error: "You do not have permission to change this database's lock.",
    });
    expect(db.pageUpdate).not.toHaveBeenCalled();
  });
});

describe("a READ page row blocks project and teamspace assignment", () => {
  it("setPageProjectAction", async () => {
    const result = await setPageProjectAction("page-1", null);
    expect(result).toEqual({
      error: "You do not have permission to move this page.",
    });
    expect(db.pageUpdate).not.toHaveBeenCalled();
  });

  it("setPageTeamspaceAction", async () => {
    const result = await setPageTeamspaceAction("page-1", null);
    expect(result).toEqual({
      error: "You do not have permission to move this page.",
    });
    expect(db.pageUpdate).not.toHaveBeenCalled();
  });

  it("setPageTeamspaceAction refuses a teamspace of another workspace", async () => {
    db.pageFindUnique.mockResolvedValue({ ...READ_PAGE, permissions: [] });
    db.teamspaceFindUnique.mockResolvedValue({ workspaceId: "ws-2" });
    const result = await setPageTeamspaceAction("page-1", "teamspace-2");
    expect(result).toEqual({
      error: "That teamspace belongs to another workspace.",
    });
    expect(db.pageUpdate).not.toHaveBeenCalled();
  });
});

describe("a READ page row blocks the page-menu, duplicate and version paths", () => {
  it("duplicatePageAction", async () => {
    const result = await duplicatePageAction("page-1");
    expect(result).toEqual({
      error: "You do not have permission to duplicate this page.",
    });
    expect(db.pageFindMany).not.toHaveBeenCalled();
  });

  it("duplicatePageSubtreeAction", async () => {
    const result = await duplicatePageSubtreeAction("page-1");
    expect(result).toEqual({
      error: "You do not have permission to duplicate this page.",
    });
    expect(db.pageFindMany).not.toHaveBeenCalled();
  });


  it("restorePageVersionAction", async () => {
    db.pageVersionFindUnique.mockResolvedValue({
      id: "version-1",
      pageId: "page-1",
      title: "Old",
      content: null,
      createdAt: new Date(),
      page: { ...READ_PAGE, title: "Now", content: null, locked: false },
    });
    const result = await restorePageVersionAction("version-1");
    expect(result).toEqual({
      error: "You do not have permission to restore this page.",
    });
    expect(db.pageVersionCreate).not.toHaveBeenCalled();
    expect(db.pageUpdate).not.toHaveBeenCalled();
  });

  it("createQuickStartAction refuses a READ parent", async () => {
    db.pageFindFirst
      .mockResolvedValueOnce({ id: "parent-1" })
      .mockResolvedValueOnce({ permissions: [{ level: "READ" }] });
    const result = await createQuickStartAction({
      workspaceId: "ws-1",
      kind: "page",
      parentId: "parent-1",
    });
    expect(result).toEqual({
      error: "You do not have permission to add a page here.",
    });
    expect(db.pageCreate).not.toHaveBeenCalled();
  });
});

describe("a READ page row blocks comments and database writes", () => {
  it("addCommentAction", async () => {
    const result = await addCommentAction({
      pageId: "clx1234567890abcdefghijkl",
      body: "A crafted comment",
    });
    expect(result).toEqual({
      error: "You do not have permission to comment.",
    });
    expect(db.commentCreate).not.toHaveBeenCalled();
  });

  it("createPropertyAction", async () => {
    db.pageFindUnique.mockResolvedValue({ ...READ_PAGE, type: "DATABASE" });
    const result = await createPropertyAction("page-1", "Priority", "TEXT");
    expect(result).toEqual({ error: "No permission." });
    expect(db.propertyCreate).not.toHaveBeenCalled();
  });

  it("setPropertyValueAction refuses a READ row even when the database is editable", async () => {
    db.pageFindUnique
      .mockResolvedValueOnce({
        workspaceId: "ws-1",
        parentId: "database-1",
        permissions: [{ userId: "member-1", level: "READ" }],
      })
      .mockResolvedValueOnce({
        ...READ_PAGE,
        id: "database-1",
        type: "DATABASE",
        permissions: [],
      });
    const result = await setPropertyValueAction("row-1", "property-1", {
      text: "x",
    });
    expect(result).toEqual({ error: "No permission." });
    expect(db.propertyValueUpsert).not.toHaveBeenCalled();
  });

  it("deleteRowAction refuses a READ row even when the database is editable", async () => {
    db.pageFindUnique
      .mockResolvedValueOnce({
        workspaceId: "ws-1",
        parentId: "database-1",
        permissions: [{ userId: "member-1", level: "READ" }],
      })
      .mockResolvedValueOnce({
        ...READ_PAGE,
        id: "database-1",
        type: "DATABASE",
        permissions: [],
      });
    const result = await deleteRowAction("row-1");
    expect(result).toEqual({ error: "No permission." });
    expect(db.pageUpdate).not.toHaveBeenCalled();
  });
});
