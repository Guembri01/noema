import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B08 — `POST /api/v1/pages` (the REST create route).
 *
 * `Page.parentId` is a plain foreign key, so a request that names a page of
 * another tenant as the parent would file the new page in that tenant's tree:
 * it shows up in their database view and in their CSV/JSON export, and
 * Postgres' `onDelete: Cascade` deletes it together with their parent.
 *
 * The route answers **403** before it looks the parent up (the caller has to
 * be a member of the workspace), and only then calls `assertScopedParent`, so
 * a foreign parent is refused with a 400 that never names it.
 */

const WORKSPACE_A = "ws-a";
const WORKSPACE_B = "ws-b";
const PAGE_A = "page-a";
const DATABASE_B = "database-b";

const PARENT_ERROR = "That parent page does not exist in this workspace.";

const db = vi.hoisted(() => ({
  pageFindFirst: vi.fn(),
  pageCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findFirst: db.pageFindFirst, create: db.pageCreate },
  },
}));

vi.mock("@/lib/api-auth", () => ({
  // The granted scopes travel with the authenticated request — a mock that
  // leaves them out would make every call fail with "insufficient_scope".
  authenticateApiRequest: vi.fn(async () => ({ userId: "user-1", scopes: ["write:pages"] })),
  hashApiToken: vi.fn(() => "hash"),
}));
vi.mock("@/lib/api-guard", () => ({ rateLimit: vi.fn(() => null) }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: vi.fn(async () => undefined) }));
vi.mock("@/server/queries", () => ({
  getPagesPage: vi.fn(),
  getPageTree: vi.fn(),
}));

const perms = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn() }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: perms.getWorkspaceAccess };
});

import { POST } from "./route";

const post = (body: Record<string, unknown>) =>
  POST(
    new Request("http://localhost/api/v1/pages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer token",
      },
      body: JSON.stringify(body),
    }),
  );

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

  db.pageCreate.mockResolvedValue({ id: "page-new", title: "Untitled", type: "PAGE" });
  perms.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
});

describe("POST /api/v1/pages — parent scope (B08)", () => {
  it("refuses a parent from another workspace and writes nothing", async () => {
    const response = await post({
      workspaceId: WORKSPACE_A,
      parentId: DATABASE_B,
      title: "x",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: PARENT_ERROR });
    expect(db.pageCreate).not.toHaveBeenCalled();
  });

  it("creates the page under a parent of its own workspace", async () => {
    const response = await post({
      workspaceId: WORKSPACE_A,
      parentId: PAGE_A,
      title: "x",
    });

    expect(response.status).toBe(201);
    expect(db.pageCreate).toHaveBeenCalledTimes(1);
    expect(db.pageCreate.mock.calls[0][0].data.parentId).toBe(PAGE_A);
  });

  it("answers a non-member with 403 before it looks the parent up", async () => {
    perms.getWorkspaceAccess.mockResolvedValue(null);

    const response = await post({
      workspaceId: WORKSPACE_A,
      parentId: DATABASE_B,
      title: "x",
    });

    expect(response.status).toBe(403);
    expect(db.pageFindFirst).not.toHaveBeenCalled();
    expect(db.pageCreate).not.toHaveBeenCalled();
  });
});
