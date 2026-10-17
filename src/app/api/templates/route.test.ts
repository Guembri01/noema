import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B08 — `POST /api/templates` (the template route).
 *
 * Two properties are pinned here:
 *
 *   1. **The parent is scoped to the workspace.** `Page.parentId` is a plain
 *      foreign key, so a parent from another tenant would link the new page
 *      into that tenant's tree. The route delegates to the template actions,
 *      and every one of them calls `assertScopedParent` — so the route must
 *      not need a second copy of the check.
 *
 *   2. **The membership check comes first.** The route-level parent check used
 *      to run *before* the actions' workspace-membership check, so a caller
 *      who is not a member of the workspace could tell "that page id exists in
 *      that workspace" from "that page id does not exist" by the error
 *      message — an existence oracle across the tenant boundary. The parent
 *      check may only run once the caller's access to the workspace is
 *      established.
 */

const WORKSPACE_A = "ws-a";
const WORKSPACE_B = "ws-b";
const PAGE_A = "page-a";
const DATABASE_B = "database-b";

const PARENT_ERROR = "That parent page does not exist in this workspace.";
const MEMBERSHIP_ERROR = "You do not have permission to create pages.";

const db = vi.hoisted(() => ({
  pageFindFirst: vi.fn(),
  pageFindUnique: vi.fn(),
  pageCreate: vi.fn(),
  propertyCreate: vi.fn(),
  databaseViewCreate: vi.fn(),
  workspaceFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: {
      findFirst: db.pageFindFirst,
      findUnique: db.pageFindUnique,
      create: db.pageCreate,
    },
    property: { create: db.propertyCreate },
    databaseView: { create: db.databaseViewCreate },
    workspace: { findUnique: db.workspaceFindUnique },
  },
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: vi.fn(async () => ({ id: "user-1" })),
  requireUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@/lib/api-guard", () => ({ rateLimit: vi.fn(() => null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const perms = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn() }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: perms.getWorkspaceAccess };
});

import { POST } from "./route";

const post = (body: Record<string, unknown>) =>
  POST(
    new Request("http://localhost/api/templates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

/** The parent lookup the helper performs — scoped to the workspace. */
function parentLookups(): { id: string; workspaceId: string }[] {
  return db.pageFindFirst.mock.calls
    .map((args) => (args[0] as { where?: { id?: string; workspaceId?: string } })?.where)
    .filter((where): where is { id: string; workspaceId: string } =>
      Boolean(where && typeof where.id === "string" && typeof where.workspaceId === "string"),
    );
}

beforeEach(() => {
  vi.clearAllMocks();

  // The tenant-scoped parent lookup: a page of another workspace exists but is
  // never returned for this workspace.
  db.pageFindFirst.mockImplementation(
    async (args: {
      where: { id?: string; workspaceId?: string; parentId?: string | null };
      select?: Record<string, boolean>;
    }) => {
      const where = args.where;
      if (typeof where.id === "string") {
        if (where.id === PAGE_A && where.workspaceId === WORKSPACE_A) {
          return { id: PAGE_A };
        }
        return null;
      }
      return { position: 0 };
    },
  );

  db.pageCreate.mockResolvedValue({ id: "page-new" });
  db.propertyCreate.mockResolvedValue({ id: "prop-1" });
  db.databaseViewCreate.mockResolvedValue({ id: "view-1" });
  db.workspaceFindUnique.mockResolvedValue({ slug: "workspace-a" });
  perms.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
});

describe("POST /api/templates — parent scope (B08)", () => {
  it("refuses a parent from another workspace and writes nothing", async () => {
    const response = await post({
      action: "quickstart",
      workspaceId: WORKSPACE_A,
      kind: "page",
      parentId: DATABASE_B,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: PARENT_ERROR });
    expect(db.pageCreate).not.toHaveBeenCalled();
  });

  it("creates the page under a parent of its own workspace", async () => {
    const response = await post({
      action: "quickstart",
      workspaceId: WORKSPACE_A,
      kind: "page",
      parentId: PAGE_A,
    });

    expect(response.status).toBe(200);
    expect(db.pageCreate).toHaveBeenCalledTimes(1);
    expect(db.pageCreate.mock.calls[0][0].data.parentId).toBe(PAGE_A);
  });
});

describe("POST /api/templates — order of the checks (B08)", () => {
  it("answers a non-member with the membership error, not the parent error", async () => {
    perms.getWorkspaceAccess.mockResolvedValue(null);

    const response = await post({
      action: "quickstart",
      workspaceId: WORKSPACE_A,
      kind: "page",
      parentId: DATABASE_B,
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(MEMBERSHIP_ERROR);
    expect(body.error).not.toBe(PARENT_ERROR);
  });

  it("does not look the parent up before the membership is established", async () => {
    perms.getWorkspaceAccess.mockResolvedValue(null);

    await post({
      action: "quickstart",
      workspaceId: WORKSPACE_A,
      kind: "page",
      parentId: DATABASE_B,
    });

    expect(parentLookups()).toEqual([]);
  });
});
