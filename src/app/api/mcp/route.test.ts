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
const PAGE_B = "page-b";
const DATABASE_A = "database-a";
const DATABASE_B = "database-b";

const PARENT_ERROR = "That parent page does not exist in this workspace.";

const db = vi.hoisted(() => ({
  apiTokenFindUnique: vi.fn(),
  pageFindFirst: vi.fn(),
  pageFindMany: vi.fn(),
  pageCreate: vi.fn(),
  pageUpdate: vi.fn(),
  pagePermissionFindMany: vi.fn(),
  teamspaceMemberFindMany: vi.fn(),
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
    pagePermission: { findMany: db.pagePermissionFindMany },
    teamspaceMember: { findMany: db.teamspaceMemberFindMany },
    comment: { findMany: db.commentFindMany },
    property: { findMany: db.propertyFindMany },
  },
}));

const edge = vi.hoisted(() => ({ authenticateApiRequest: vi.fn() }));

vi.mock("@/lib/api-auth", () => ({
  // The granted scopes travel with the authenticated request (the token row is
  // read once, by the authenticator) — a mock that leaves them out would make
  // every tool call fail with "Insufficient scope".
  authenticateApiRequest: edge.authenticateApiRequest,
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

const call = (args: Record<string, unknown>, name = "create_page") =>
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
        params: { name, arguments: args },
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

  edge.authenticateApiRequest.mockResolvedValue({ userId: "user-1", scopes: ["write:pages"] });
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

/* ------------------------------------------------------------------ */
/* B89 — the resource path asks the token's scope                      */
/* ------------------------------------------------------------------ */

/**
 * B89 — `resources/read` must ask the token what it may read.
 *
 * `tools/call` is gated by `authCheck(tool, { scopes: effectiveScopes })`:
 * a tool whose scope the token does not hold is refused with `-32003
 * "Insufficient scope."`. The resource path asked nothing — it validated the
 * URI, called `runResource` and returned the content, so a token with *no*
 * scope at all could read pages, page comments, databases and database rows
 * through the `notion://` templates.
 *
 * A resource is a read path like a tool, so it needs the scope of the read
 * tool it mirrors: `notion://pages/{pageId}` → `read:pages`,
 * `notion://pages/{pageId}/comments` → `read:comments`, the two database
 * templates → `read:databases`. The check happens *before* the read, so a
 * missing scope costs no database round trip at all.
 */

type RpcBody = {
  result?: { contents?: { uri: string; mimeType: string; text: string }[] };
  error?: { code: number; message: string; data?: { missing?: string[] } };
};

/** A `resources/read` call with the token's granted scopes in place. */
const readResource = (uri: string, scopes: string[]) => {
  edge.authenticateApiRequest.mockResolvedValue({ userId: "user-1", scopes });
  return POST(
    new Request("http://localhost/api/mcp?workspaceId=ws-a", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "resources/read",
        params: { uri },
      }),
    }),
  );
};

/** A `tools/call` with the token's granted scopes in place. */
const callTool = (name: string, args: Record<string, unknown>, scopes: string[]) => {
  edge.authenticateApiRequest.mockResolvedValue({ userId: "user-1", scopes });
  return POST(
    new Request("http://localhost/api/mcp?workspaceId=ws-a", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
};

const rpc = async (res: Response): Promise<RpcBody> => (await res.json()) as RpcBody;

describe("POST /api/mcp — resources/read needs the token's scope (B89)", () => {
  beforeEach(() => {
    // The page and the database the resource templates read.
    db.pageFindFirst.mockImplementation(
      async (args: { where: { id?: string; workspaceId?: string; type?: string } }) => {
        const where = args.where;
        if (where.id === PAGE_A && where.workspaceId === WORKSPACE_A) {
          return {
            id: PAGE_A,
            title: "Notes",
            icon: null,
            type: "PAGE",
            content: { type: "doc" },
            updatedAt: new Date(0),
          };
        }
        if (where.id === DATABASE_A && where.workspaceId === WORKSPACE_A) {
          return { id: DATABASE_A, title: "Customers", icon: null, updatedAt: new Date(0) };
        }
        return null;
      },
    );
    db.pageFindMany.mockResolvedValue([]);
    db.commentFindMany.mockResolvedValue([
      {
        id: "comment-1",
        body: "a comment",
        resolved: false,
        createdAt: new Date(0),
        author: { id: "user-1", name: "User" },
      },
    ]);
    db.propertyFindMany.mockResolvedValue([]);
  });

  it("lets a token with read:pages read the page resource", async () => {
    const body = await rpc(await readResource(`notion://pages/${PAGE_A}`, ["read:pages"]));

    expect(body.error).toBeUndefined();
    expect(JSON.stringify(body)).toContain("Notes");
  });

  it("refuses the database rows for a token with read:pages", async () => {
    const body = await rpc(
      await readResource(`notion://databases/${DATABASE_A}/rows`, ["read:pages"]),
    );

    expect(body.error?.code).toBe(-32003);
    expect(body.error?.message).toBe("Insufficient scope.");
    expect(body.error?.data).toMatchObject({ missing: ["read:databases"] });
    // The scope is checked before the read: no database round trip at all.
    expect(db.pageFindFirst).not.toHaveBeenCalled();
    expect(db.pageFindMany).not.toHaveBeenCalled();
  });

  it("refuses every resource for a token without scopes", async () => {
    const uris = [
      `notion://pages/${PAGE_A}`,
      `notion://pages/${PAGE_A}/comments`,
      `notion://databases/${DATABASE_A}`,
      `notion://databases/${DATABASE_A}/rows`,
    ];

    for (const uri of uris) {
      const body = await rpc(await readResource(uri, []));
      expect(body.error?.code, uri).toBe(-32003);
      expect(body.error?.message, uri).toBe("Insufficient scope.");
      expect(body.error?.data?.missing?.length, uri).toBeGreaterThan(0);
    }

    // Nothing was read: the pages, the comments and the schema stay untouched.
    expect(db.pageFindFirst).not.toHaveBeenCalled();
    expect(db.pageFindMany).not.toHaveBeenCalled();
    expect(db.commentFindMany).not.toHaveBeenCalled();
    expect(db.propertyFindMany).not.toHaveBeenCalled();
  });

  it("treats a write scope as implying the matching read scope", async () => {
    const body = await rpc(await readResource(`notion://pages/${PAGE_A}`, ["write:pages"]));

    expect(body.error).toBeUndefined();
    expect(JSON.stringify(body)).toContain("Notes");
  });

  it("lets a token with read:databases read the rows but not the comments", async () => {
    const rows = await rpc(
      await readResource(`notion://databases/${DATABASE_A}/rows`, ["read:databases"]),
    );
    expect(rows.error).toBeUndefined();

    const comments = await rpc(
      await readResource(`notion://pages/${PAGE_A}/comments`, ["read:databases"]),
    );
    expect(comments.error?.code).toBe(-32003);
    expect(comments.error?.data).toMatchObject({ missing: ["read:comments"] });
  });

  it("answers exactly like the tool that misses the same scope", async () => {
    const resource = await rpc(
      await readResource(`notion://pages/${PAGE_A}/comments`, ["read:pages"]),
    );
    const tool = await rpc(
      await callTool("get_comments", { pageId: PAGE_A }, ["read:pages"]),
    );

    expect(resource.error?.code).toBe(-32003);
    expect(resource.error?.message).toBe("Insufficient scope.");
    // Byte-equal to the `tools/call` answer — no new error code, no new wording.
    expect(resource.error).toEqual(tool.error);
  });

  it("refuses a URI that matches no template before it asks the scope", async () => {
    const body = await rpc(await readResource("notion://secrets/abc", ["read:pages"]));

    expect(body.error?.code).toBe(-32602);
    expect(db.pageFindFirst).not.toHaveBeenCalled();
  });

  it("keeps the guest scope: a guest reads only the pages shared with them", async () => {
    perms.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
    db.pagePermissionFindMany.mockResolvedValue([{ pageId: PAGE_A }]);
    db.teamspaceMemberFindMany.mockResolvedValue([]);

    // The shared page is served…
    const shared = await rpc(await readResource(`notion://pages/${PAGE_A}`, ["read:pages"]));
    expect(shared.error).toBeUndefined();
    expect(JSON.stringify(shared)).toContain("Notes");

    // …the other one answers "not found" — the guest scope still holds.
    const hidden = await rpc(await readResource(`notion://pages/${PAGE_B}`, ["read:pages"]));
    expect(hidden.error?.message).toBe("Page not found.");
    expect(JSON.stringify(hidden)).not.toContain("Notes");
  });

  it("refuses a guest a resource its token does not carry", async () => {
    perms.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
    db.pagePermissionFindMany.mockResolvedValue([{ pageId: PAGE_A }]);
    db.teamspaceMemberFindMany.mockResolvedValue([]);

    const body = await rpc(
      await readResource(`notion://databases/${DATABASE_A}/rows`, ["read:pages"]),
    );

    expect(body.error?.code).toBe(-32003);
    expect(body.error?.data).toMatchObject({ missing: ["read:databases"] });
    expect(db.pageFindFirst).not.toHaveBeenCalled();
  });
});

describe("POST /api/mcp — append_blocks validates the blocks (B137)", () => {
  it("stores a block whose href is outside the allowlist without the href", async () => {
    // B137: the tool writes the blocks it is given. The editor's save path
    // (and the import, B110) put the document through the allowlist — an
    // `attrs.href` with a scheme outside it loses its value there. Here it
    // would be stored verbatim.
    const response = await call(
      {
        pageId: PAGE_A,
        blocks: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "click",
                marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
              },
            ],
          },
        ],
      },
      "append_blocks",
    );

    expect(response.status).toBe(200);
    expect(db.pageUpdate).toHaveBeenCalledTimes(1);
    const written = db.pageUpdate.mock.calls[0][0].data.content as {
      content: { content?: { marks?: { attrs?: Record<string, unknown> }[] }[] }[];
    };
    const mark = written.content[0].content?.[0].marks?.[0];
    expect(mark?.attrs?.href).toBeUndefined();
  });

  it("refuses a document that is bigger than the editor's limit", async () => {
    const response = await call(
      {
        pageId: PAGE_A,
        blocks: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(2_100_000) }] }],
      },
      "append_blocks",
    );

    expect(response.status).toBe(200);
    const result = await toolResult(response);
    expect(String(result.error ?? "")).toContain("too large");
    expect(db.pageUpdate).not.toHaveBeenCalled();
  });
});
