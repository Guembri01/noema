import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B08 — the template actions: the parent of the page they create.
 *
 * `Page.parentId` is a plain foreign key, so a parent from another tenant
 * files the new page in that tenant's tree: it shows up in their database view
 * and in their CSV/JSON export, and Postgres' `onDelete: Cascade` deletes it
 * together with their parent.
 *
 * The three actions are the ones behind `POST /api/templates` (the gallery
 * workflow, the block template and the quick-start cards). Each of them checks
 * the workspace membership **first** and the parent **second** — so a caller
 * without access to the workspace learns nothing about the page ids of that
 * workspace.
 */

const WORKSPACE_A = "ws-a";
const WORKSPACE_B = "ws-b";
const PAGE_A = "page-a";
const DATABASE_B = "database-b";

const PARENT_ERROR = "That parent page does not exist in this workspace.";
const MEMBERSHIP_ERROR = "You do not have permission to create pages.";

const db = vi.hoisted(() => ({
  pageFindFirst: vi.fn(),
  pageCreate: vi.fn(),
  propertyCreate: vi.fn(),
  propertyValueCreateMany: vi.fn(),
  databaseViewCreate: vi.fn(),
  databaseViewCreateMany: vi.fn(),
  workspaceFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findFirst: db.pageFindFirst, create: db.pageCreate },
    property: { create: db.propertyCreate },
    propertyValue: { createMany: db.propertyValueCreateMany },
    databaseView: { create: db.databaseViewCreate, createMany: db.databaseViewCreateMany },
    workspace: { findUnique: db.workspaceFindUnique },
  },
}));

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const perms = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn() }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: perms.getWorkspaceAccess };
});

import {
  createBlockTemplateAction,
  createGalleryTemplateAction,
  createQuickStartAction,
} from "./home-templates";

beforeEach(() => {
  vi.clearAllMocks();

  // The tenant-scoped parent lookup — a page of another workspace exists but
  // is never returned for this workspace.
  db.pageFindFirst.mockImplementation(
    async (args: {
      where: { id?: string; workspaceId?: string; parentId?: string | null };
      select?: Record<string, boolean>;
    }) => {
      const where = args.where;
      if (typeof where.id === "string") {
        if (where.id === PAGE_A && where.workspaceId === WORKSPACE_A) return { id: PAGE_A };
        return null;
      }
      return { position: 0 };
    },
  );

  db.pageCreate.mockResolvedValue({ id: "page-new" });
  db.propertyCreate.mockResolvedValue({ id: "prop-1" });
  db.propertyValueCreateMany.mockResolvedValue({ count: 0 });
  db.databaseViewCreate.mockResolvedValue({ id: "view-1" });
  db.databaseViewCreateMany.mockResolvedValue({ count: 0 });
  db.workspaceFindUnique.mockResolvedValue({ slug: "workspace-a" });
  perms.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
});

describe("createGalleryTemplateAction — parent scope (B08)", () => {
  it("refuses a parent from another workspace and writes nothing", async () => {
    const result = await createGalleryTemplateAction({
      workspaceId: WORKSPACE_A,
      templateId: "task-tracking",
      parentId: DATABASE_B,
    });

    expect(result).toEqual({ error: PARENT_ERROR });
    expect(db.pageCreate).not.toHaveBeenCalled();
  });

  it("creates the database under a parent of its own workspace", async () => {
    const result = await createGalleryTemplateAction({
      workspaceId: WORKSPACE_A,
      templateId: "task-tracking",
      parentId: PAGE_A,
    });

    expect(result).toMatchObject({ ok: true });
    expect(db.pageCreate.mock.calls[0][0].data.parentId).toBe(PAGE_A);
  });

  it("answers a non-member with the membership error, not the parent error", async () => {
    perms.getWorkspaceAccess.mockResolvedValue(null);

    const result = await createGalleryTemplateAction({
      workspaceId: WORKSPACE_A,
      templateId: "task-tracking",
      parentId: DATABASE_B,
    });

    expect(result).toEqual({ error: MEMBERSHIP_ERROR });
    expect(db.pageCreate).not.toHaveBeenCalled();
  });
});

describe("createBlockTemplateAction — parent scope (B08)", () => {
  it("refuses a parent from another workspace and writes nothing", async () => {
    const result = await createBlockTemplateAction({
      workspaceId: WORKSPACE_A,
      templateId: "meeting",
      parentId: DATABASE_B,
    });

    expect(result).toEqual({ error: PARENT_ERROR });
    expect(db.pageCreate).not.toHaveBeenCalled();
  });

  it("creates the page under a parent of its own workspace", async () => {
    const result = await createBlockTemplateAction({
      workspaceId: WORKSPACE_A,
      templateId: "meeting",
      parentId: PAGE_A,
    });

    expect(result).toMatchObject({ ok: true });
    expect(db.pageCreate.mock.calls[0][0].data.parentId).toBe(PAGE_A);
  });
});

describe("createQuickStartAction — parent scope (B08)", () => {
  it("refuses a parent from another workspace and writes nothing", async () => {
    const result = await createQuickStartAction({
      workspaceId: WORKSPACE_A,
      kind: "page",
      parentId: DATABASE_B,
    });

    expect(result).toEqual({ error: PARENT_ERROR });
    expect(db.pageCreate).not.toHaveBeenCalled();
  });

  it("creates the page under a parent of its own workspace", async () => {
    const result = await createQuickStartAction({
      workspaceId: WORKSPACE_A,
      kind: "page",
      parentId: PAGE_A,
    });

    expect(result).toMatchObject({ ok: true });
    expect(db.pageCreate.mock.calls[0][0].data.parentId).toBe(PAGE_A);
  });
});
