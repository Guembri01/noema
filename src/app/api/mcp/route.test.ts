import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B08 — the MCP write tool `create_page` (`POST /api/mcp`).
 *
 * `Page.parentId` is a plain foreign key, so a tool call that names a page of
 * another tenant as the parent would file the new page in that tenant's tree:
 * it shows up in their database view and in their CSV/JSON export, and
 * Postgres' `onDelete: Cascade` deletes it together with their parent.
 *
 * The tool checks the workspace membership first (`authCheck` + the workspace
 * role) and only then the parent — so a caller without access to the
 * workspace learns nothing about the page ids of that workspace.
 */

const WORKSPACE_A = "ws-a";
const WORKSPACE_B = "ws-b";
const PAGE_A = "page-a";
const DATABASE_B = "database-b";

const PARENT_ERROR = "That parent page does not exist in this workspace.";

const db = vi.hoisted(() => ({
  apiTokenFindUnique: vi.fn(),
  pageFindFirst: vi.fn(),
  pageFindMany: vi.fn(),
  pageCreate: vi.fn(),
  pageUpdate: vi.fn(),
  commentFindMany: vi.fn(),
  propertyFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    apiToken: { findUnique: db.apiTokenFindUnique },
    page: {
      findFirst: db.pageFindFirst,
      findMany: db.pageFindMany,
      create: db.pageCreate,
      update: db.pageUpdate,
    },
    comment: { findMany: db.commentFindMany },
    property: { findMany: db.propertyFindMany },
  },
}));

vi.mock("@/lib/api-auth", () => ({
  // The granted scopes travel with the authenticated request (the token row is
  // read once, by the authenticator) — a mock that leaves them out would make
  // every tool call fail with "Insufficient scope".
  authenticateApiRequest: vi.fn(async () => ({ userId: "user-1", scopes: ["write:pages"] })),
  hashApiToken: vi.fn(() => "hash"),
}));
vi.mock("@/lib/api-guard", () => ({ rateLimit: vi.fn(() => null) }));
vi.mock("@/server/queries", () => ({ searchPagesPage: vi.fn() }));

const perms = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn() }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: perms.getWorkspaceAccess };
});

import { POST } from "./route";

const call = (args: Record<string, unknown>) =>
  POST(
    new Request("http://localhost/api/mcp?workspaceId=ws-a&allowWrite=true", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_page", arguments: args },
      }),
    }),
  );

/** The JSON-RPC result of the call (the tool's text payload parsed). */
async function toolResult(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as {
    result?: { content?: { text?: string }[] };
  };
  return JSON.parse(body.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();

  db.apiTokenFindUnique.mockResolvedValue({ scopes: ["write:pages"] });

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

  db.pageFindMany.mockResolvedValue([]);
  db.pageCreate.mockResolvedValue({ id: "page-new", title: "Untitled", type: "PAGE" });
  perms.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
});

describe("POST /api/mcp — create_page parent scope (B08)", () => {
  it("refuses a parent from another workspace and writes nothing", async () => {
    const response = await call({ title: "x", parentId: DATABASE_B });

    expect(response.status).toBe(200);
    const result = await toolResult(response);
    expect(result).toEqual({ error: PARENT_ERROR });
    expect(db.pageCreate).not.toHaveBeenCalled();
  });

  it("creates the page under a parent of its own workspace", async () => {
    const response = await call({ title: "x", parentId: PAGE_A });

    expect(response.status).toBe(200);
    const result = await toolResult(response);
    expect(result).toMatchObject({ page: { id: "page-new" } });
    expect(db.pageCreate).toHaveBeenCalledTimes(1);
    expect(db.pageCreate.mock.calls[0][0].data.parentId).toBe(PAGE_A);
  });

  it("never names the foreign page in the rejection", async () => {
    const response = await call({ title: "x", parentId: DATABASE_B });
    const result = await toolResult(response);

    const message = String(result.error ?? "");
    expect(message).not.toContain(DATABASE_B);
    expect(message).not.toContain(WORKSPACE_B);
  });
});
