import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B88 — the MCP endpoint's read tools must honour the guest page scope.
 *
 * A guest is a member of the workspace, so the endpoint's membership check
 * passed and every read tool returned the whole workspace, content included.
 * The scope is now resolved from the caller's role (as the workspace UI does)
 * and every read path is narrowed by it: a page outside the scope answers
 * "not found" — the same answer a page that does not exist gets, so the
 * endpoint cannot be used to probe which pages exist.
 *
 * Only the transport edges are mocked: the database, the bearer token and the
 * query layer (which needs a live Postgres — its mock applies the visible-page
 * filter exactly as `searchPages` does). The scope resolution
 * (`pageScopeFor`), the role predicates (`canEditContent`, the scope ceiling)
 * and the response shaping all run for real.
 */

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

type PageRow = {
  id: string;
  workspaceId: string;
  parentId: string | null;
  teamspaceId: string | null;
  createdById: string;
  title: string;
  icon: string | null;
  type: "PAGE" | "DATABASE";
  content: unknown;
  updatedAt: Date;
  deletedAt: Date | null;
  position: number;
};

const NOW = new Date("2026-01-01T00:00:00.000Z");

const PAGES: PageRow[] = [
  {
    id: "page-a",
    workspaceId: "ws-1",
    parentId: null,
    teamspaceId: null,
    createdById: "user-owner",
    title: "Shared notes",
    icon: null,
    type: "PAGE",
    content: { type: "doc", content: [{ type: "paragraph", text: "shared notes" }] },
    updatedAt: NOW,
    deletedAt: null,
    position: 100,
  },
  {
    id: "page-b",
    workspaceId: "ws-1",
    parentId: null,
    teamspaceId: null,
    createdById: "user-owner",
    title: "Revenue plan",
    icon: null,
    type: "PAGE",
    content: { type: "doc", content: [{ type: "paragraph", text: "CONFIDENTIAL revenue" }] },
    updatedAt: NOW,
    deletedAt: null,
    position: 200,
  },
  {
    id: "db-1",
    workspaceId: "ws-1",
    parentId: null,
    teamspaceId: null,
    createdById: "user-owner",
    title: "Customers",
    icon: null,
    type: "DATABASE",
    content: null,
    updatedAt: NOW,
    deletedAt: null,
    position: 300,
  },
  {
    id: "db-2",
    workspaceId: "ws-1",
    parentId: null,
    teamspaceId: null,
    createdById: "user-owner",
    title: "Payroll",
    icon: null,
    type: "DATABASE",
    content: null,
    updatedAt: NOW,
    deletedAt: null,
    position: 400,
  },
  {
    id: "row-1",
    workspaceId: "ws-1",
    parentId: "db-1",
    teamspaceId: null,
    createdById: "user-owner",
    title: "Acme Corp",
    icon: null,
    type: "PAGE",
    content: null,
    updatedAt: NOW,
    deletedAt: null,
    position: 100,
  },
  {
    id: "row-2",
    workspaceId: "ws-1",
    parentId: "db-2",
    teamspaceId: null,
    createdById: "user-owner",
    title: "Salary",
    icon: null,
    type: "PAGE",
    content: null,
    updatedAt: NOW,
    deletedAt: null,
    position: 100,
  },
];

/** The rows the search engine would return for "revenue", before scoping. */
const SEARCH_HITS = [
  { id: "page-a", title: "Shared notes", type: "PAGE", snippet: "shared notes" },
  { id: "page-b", title: "Revenue plan", type: "PAGE", snippet: "CONFIDENTIAL revenue" },
];

const COMMENTS = [
  {
    id: "comment-1",
    pageId: "page-a",
    body: "a visible comment",
    resolved: false,
    createdAt: NOW,
    author: { id: "user-owner", name: "Owner" },
  },
];

const PROPERTIES = [
  { id: "prop-1", name: "Name", type: "TEXT", config: null, position: 100 },
];

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */

type Where = {
  id?: string | { in: string[] };
  workspaceId?: string;
  createdById?: string;
  parentId?: string | null;
  teamspaceId?: string | null;
  type?: "PAGE" | "DATABASE";
  deletedAt?: null;
};

type Select = Record<string, true | { select: Select }>;

/** Project a row the way Prisma's `select` does. */
function project(row: Record<string, unknown>, select?: Select): Record<string, unknown> {
  if (!select) return row;
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(select)) {
    const value = row[key];
    if (spec === true) {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item && typeof item === "object"
          ? project(item as Record<string, unknown>, spec.select)
          : item,
      );
      continue;
    }
    out[key] =
      value && typeof value === "object"
        ? project(value as Record<string, unknown>, spec.select)
        : value;
  }
  return out;
}

/** The subset of Prisma's `where` the MCP route uses. */
function matches(row: PageRow, where: Where): boolean {
  if (where.id !== undefined) {
    if (typeof where.id === "string") {
      if (row.id !== where.id) return false;
    } else if (!where.id.in.includes(row.id)) {
      return false;
    }
  }
  if (where.workspaceId !== undefined && row.workspaceId !== where.workspaceId) return false;
  if (where.createdById !== undefined && row.createdById !== where.createdById) return false;
  if (where.parentId !== undefined && row.parentId !== where.parentId) return false;
  if (where.teamspaceId !== undefined && row.teamspaceId !== where.teamspaceId) return false;
  if (where.type !== undefined && row.type !== where.type) return false;
  if (where.deletedAt === null && row.deletedAt !== null) return false;
  return true;
}

const db = vi.hoisted(() => ({
  apiTokenFindUnique: vi.fn(),
  pageFindFirst: vi.fn(),
  pageFindMany: vi.fn(),
  pageCreate: vi.fn(),
  pagePermissionFindMany: vi.fn(),
  teamspaceMemberFindMany: vi.fn(),
  commentFindMany: vi.fn(),
  propertyFindMany: vi.fn(),
  propertyFindFirst: vi.fn(),
  propertyValueUpsert: vi.fn(),
}));

const edge = vi.hoisted(() => ({
  authenticateApiRequest: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  searchPagesPage: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    apiToken: { findUnique: db.apiTokenFindUnique },
    page: {
      findFirst: db.pageFindFirst,
      findMany: db.pageFindMany,
      create: db.pageCreate,
    },
    pagePermission: { findMany: db.pagePermissionFindMany },
    teamspaceMember: { findMany: db.teamspaceMemberFindMany },
    comment: { findMany: db.commentFindMany },
    property: { findMany: db.propertyFindMany, findFirst: db.propertyFindFirst },
    propertyValue: { upsert: db.propertyValueUpsert },
  },
}));

vi.mock("@/lib/api-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-auth")>();
  return { ...actual, authenticateApiRequest: edge.authenticateApiRequest };
});

vi.mock("@/lib/api-guard", () => ({ rateLimit: () => null }));

vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: edge.getWorkspaceAccess };
});

// The query layer needs a live Postgres; the mock applies the visible-page
// filter exactly as `searchPages` does (`id in visiblePageIds`).
vi.mock("@/server/queries", () => ({ searchPagesPage: edge.searchPagesPage }));

import { POST } from "./route";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

type RpcBody = {
  result?: { content: { type: string; text: string }[]; isError: boolean };
  error?: { code: number; message: string; data?: unknown };
};

const call = (body: Record<string, unknown>, search = "?workspaceId=ws-1") =>
  POST(
    new Request(`http://localhost/api/mcp${search}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer noema_test",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
    }),
  );

const rpc = async (res: Response): Promise<RpcBody> => (await res.json()) as RpcBody;

/** The tool's payload, parsed out of the MCP text content. */
const payload = (body: RpcBody): Record<string, unknown> =>
  JSON.parse(body.result?.content[0]?.text ?? "null") as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();

  // The guest is a member of the workspace with the `GUEST` role.
  edge.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
  edge.authenticateApiRequest.mockResolvedValue({
    userId: "user-guest",
    scopes: ["read:pages", "read:databases", "read:comments", "write:pages", "admin:workspace"],
  });
  // A guest mints their own token and hands themselves the strongest read
  // scope there is — the attack.
  db.apiTokenFindUnique.mockResolvedValue({
    scopes: ["read:pages", "read:databases", "read:comments", "write:pages", "admin:workspace"],
  });

  // The guest was shared "page-a" and the database "db-1" — nothing else.
  db.pagePermissionFindMany.mockResolvedValue([{ pageId: "page-a" }, { pageId: "db-1" }]);
  db.teamspaceMemberFindMany.mockResolvedValue([]);

  db.pageFindFirst.mockImplementation(async ({ where, select }: { where: Where; select?: Select }) => {
    const row = PAGES.find((page) => matches(page, where));
    return row ? project({ ...row }, select) : null;
  });

  db.pageFindMany.mockImplementation(
    async ({ where, select, take }: { where: Where; select?: Select; take?: number }) => {
      const rows = PAGES.filter((page) => matches(page, where)).map((page) =>
        project({ ...page }, select),
      );
      return typeof take === "number" ? rows.slice(0, take) : rows;
    },
  );

  db.commentFindMany.mockResolvedValue(COMMENTS);
  db.propertyFindMany.mockResolvedValue(PROPERTIES);
  db.propertyFindFirst.mockResolvedValue(null);
  db.propertyValueUpsert.mockResolvedValue({
    id: "pv-1",
    propertyId: "prop-1",
    pageId: "row-1",
    value: 42,
  });
  db.pageCreate.mockResolvedValue({ id: "new-page", title: "New", type: "PAGE" });

  edge.searchPagesPage.mockImplementation(
    async (
      _workspaceId: string,
      _query: string,
      visiblePageIds: Set<string> | null,
    ): Promise<{ items: typeof SEARCH_HITS; hasMore: boolean; nextCursor: null }> => ({
      items: SEARCH_HITS.filter((hit) => !visiblePageIds || visiblePageIds.has(hit.id)),
      hasMore: false,
      nextCursor: null,
    }),
  );
});

/* ------------------------------------------------------------------ */
/* The attack: a guest reads the workspace through MCP                 */
/* ------------------------------------------------------------------ */

describe("MCP read tools — a guest only sees the pages shared with them", () => {
  it("get_page on a page outside the guest scope answers 'not found'", async () => {
    const res = await call({
      method: "tools/call",
      params: { name: "get_page", arguments: { pageId: "page-b" } },
    });
    const body = await rpc(res);
    expect(body.result?.isError).toBe(true);
    expect(payload(body)).toEqual({ error: "Page not found." });
    // The hidden page's content never reaches the caller.
    expect(JSON.stringify(body)).not.toContain("CONFIDENTIAL");
  });

  it("get_page answers the same for a page that does not exist (no existence oracle)", async () => {
    const res = await call({
      method: "tools/call",
      params: { name: "get_page", arguments: { pageId: "page-does-not-exist" } },
    });
    const body = await rpc(res);
    expect(body.result?.isError).toBe(true);
    expect(payload(body)).toEqual({ error: "Page not found." });
  });

  it("get_page on a shared page still returns it", async () => {
    const res = await call({
      method: "tools/call",
      params: { name: "get_page", arguments: { pageId: "page-a" } },
    });
    const body = await rpc(res);
    expect(body.result?.isError).toBe(false);
    expect(payload(body)).toMatchObject({ id: "page-a", title: "Shared notes" });
    expect(JSON.stringify(body)).toContain("shared notes");
  });

  it("search_pages does not return the pages outside the guest scope", async () => {
    const res = await call({
      method: "tools/call",
      params: { name: "search_pages", arguments: { query: "revenue" } },
    });
    const body = await rpc(res);
    const pages = payload(body).pages as { id: string }[];
    expect(pages.map((page) => page.id)).toEqual(["page-a"]);
    expect(JSON.stringify(body)).not.toContain("CONFIDENTIAL");
    // The scope is handed to the query layer, not filtered afterwards.
    const scope = edge.searchPagesPage.mock.calls[0]?.[2] as Set<string> | null;
    expect(scope).toBeInstanceOf(Set);
    expect(scope?.has("page-a")).toBe(true);
    expect(scope?.has("page-b")).toBe(false);
  });

  it("list_databases only lists the databases in the guest scope", async () => {
    const res = await call({
      method: "tools/call",
      params: { name: "list_databases", arguments: {} },
    });
    const body = await rpc(res);
    const databases = payload(body).databases as { id: string }[];
    expect(databases.map((database) => database.id)).toEqual(["db-1"]);
  });

  it("query_database_rows on a database outside the guest scope answers 'not found'", async () => {
    const res = await call({
      method: "tools/call",
      params: { name: "query_database_rows", arguments: { databaseId: "db-2" } },
    });
    const body = await rpc(res);
    expect(body.result?.isError).toBe(true);
    expect(payload(body)).toEqual({ error: "Database not found." });
    expect(JSON.stringify(body)).not.toContain("Salary");
  });

  it("query_database_rows on a shared database returns its rows", async () => {
    const res = await call({
      method: "tools/call",
      params: { name: "query_database_rows", arguments: { databaseId: "db-1" } },
    });
    const body = await rpc(res);
    const rows = payload(body).rows as { id: string }[];
    expect(rows.map((row) => row.id)).toEqual(["row-1"]);
  });

  it("get_comments on a page outside the guest scope answers 'not found'", async () => {
    const res = await call({
      method: "tools/call",
      params: { name: "get_comments", arguments: { pageId: "page-b" } },
    });
    const body = await rpc(res);
    expect(body.result?.isError).toBe(true);
    expect(payload(body)).toEqual({ error: "Page not found." });
  });

  it("get_comments on a shared page still returns them", async () => {
    const res = await call({
      method: "tools/call",
      params: { name: "get_comments", arguments: { pageId: "page-a" } },
    });
    const body = await rpc(res);
    const comments = payload(body).comments as { id: string }[];
    expect(comments.map((comment) => comment.id)).toEqual(["comment-1"]);
  });
});

/* ------------------------------------------------------------------ */
/* The resource templates read the same pages                          */
/* ------------------------------------------------------------------ */

describe("MCP resource templates — a guest only sees the pages shared with them", () => {
  it("notion://pages/{pageId} refuses a page outside the guest scope", async () => {
    const res = await call({
      method: "resources/read",
      params: { uri: "notion://pages/page-b" },
    });
    const body = await rpc(res);
    expect(body.error?.code).toBe(-32000);
    expect(body.error?.message).toBe("Page not found.");
    expect(JSON.stringify(body)).not.toContain("CONFIDENTIAL");
  });

  it("notion://pages/{pageId} still serves a shared page", async () => {
    const res = await call({
      method: "resources/read",
      params: { uri: "notion://pages/page-a" },
    });
    const body = await rpc(res);
    expect(body.error).toBeUndefined();
    expect(JSON.stringify(body)).toContain("shared notes");
  });

  it("notion://pages/{pageId}/comments refuses a page outside the guest scope", async () => {
    const res = await call({
      method: "resources/read",
      params: { uri: "notion://pages/page-b/comments" },
    });
    const body = await rpc(res);
    expect(body.error?.message).toBe("Page not found.");
  });

  it("notion://databases/{databaseId} refuses a database outside the guest scope", async () => {
    const res = await call({
      method: "resources/read",
      params: { uri: "notion://databases/db-2" },
    });
    const body = await rpc(res);
    expect(body.error?.code).toBe(-32000);
    expect(body.error?.message).toBe("Database not found.");
    expect(JSON.stringify(body)).not.toContain("Payroll");
  });

  it("notion://databases/{databaseId}/rows refuses a database outside the guest scope", async () => {
    const res = await call({
      method: "resources/read",
      params: { uri: "notion://databases/db-2/rows" },
    });
    const body = await rpc(res);
    expect(body.error?.message).toBe("Database not found.");
    expect(JSON.stringify(body)).not.toContain("Salary");
  });
});

/* ------------------------------------------------------------------ */
/* A token may not widen the role that owns it                         */
/* ------------------------------------------------------------------ */

describe("MCP — a token cannot widen the caller's role", () => {
  it("a guest's token cannot satisfy a write tool's scope", async () => {
    const res = await call(
      {
        method: "tools/call",
        params: { name: "create_page", arguments: { title: "Sneaky" } },
      },
      "?workspaceId=ws-1&allowWrite=true",
    );
    const body = await rpc(res);
    expect(body.error?.code).toBe(-32003);
    expect(body.error?.message).toBe("Insufficient scope.");
    expect(body.error?.data).toMatchObject({ missing: ["write:pages"] });
    expect(db.pageCreate).not.toHaveBeenCalled();
  });

  it("a member's token still reaches the write tools", async () => {
    edge.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
    const res = await call(
      {
        method: "tools/call",
        params: { name: "create_page", arguments: { title: "Legitimate" } },
      },
      "?workspaceId=ws-1&allowWrite=true",
    );
    const body = await rpc(res);
    expect(body.error).toBeUndefined();
    expect(db.pageCreate).toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* A property belongs to the row's own database                        */
/* ------------------------------------------------------------------ */

describe("MCP write tools — a property is tied to the row's own database", () => {
  beforeEach(() => {
    // Writes are role-gated, so this path is never a guest's — it is a
    // correctness rule, not a guest-facing one.
    edge.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
  });

  it("refuses a property that belongs to another database of the workspace", async () => {
    // "prop-of-db-2" belongs to the database "db-2"; the row "row-1" lives in
    // "db-1". Both databases are in the same workspace, so a lookup that only
    // asks for the workspace finds the property.
    let propertyWhere: {
      id?: string;
      databasePageId?: string;
      databasePage?: { workspaceId: string };
    } | null = null;
    db.propertyFindFirst.mockImplementation(
      async ({
        where,
      }: {
        where: {
          id?: string;
          databasePageId?: string;
          databasePage?: { workspaceId: string };
        };
      }) => {
        propertyWhere = where;
        if (where.id !== "prop-of-db-2") return null;
        // The database honours whichever predicate the query binds: pinned to
        // a database it does not own, the property is not found; constrained by
        // the workspace only, it is.
        if (where.databasePageId !== undefined) {
          return where.databasePageId === "db-2" ? { id: "prop-of-db-2" } : null;
        }
        return { id: "prop-of-db-2" };
      },
    );

    const res = await call(
      {
        method: "tools/call",
        params: {
          name: "update_property_value",
          arguments: { pageId: "row-1", property: "prop-of-db-2", value: "42" },
        },
      },
      "?workspaceId=ws-1&allowWrite=true",
    );
    const body = await rpc(res);
    expect(body.result?.isError).toBe(true);
    expect(payload(body)).toEqual({ error: "Property not found." });
    // The property is looked up in the row's own database, not in the workspace.
    expect(propertyWhere).toMatchObject({ id: "prop-of-db-2", databasePageId: "db-1" });
    expect(db.propertyValueUpsert).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* The control: a member still sees the whole workspace                */
/* ------------------------------------------------------------------ */

describe("MCP read tools — a member still sees the whole workspace", () => {
  beforeEach(() => {
    edge.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
  });

  it("get_page on any page of the workspace returns it", async () => {
    const res = await call({
      method: "tools/call",
      params: { name: "get_page", arguments: { pageId: "page-b" } },
    });
    const body = await rpc(res);
    expect(body.result?.isError).toBe(false);
    expect(payload(body)).toMatchObject({ id: "page-b", title: "Revenue plan" });
  });

  it("search_pages returns every match of the workspace", async () => {
    const res = await call({
      method: "tools/call",
      params: { name: "search_pages", arguments: { query: "revenue" } },
    });
    const body = await rpc(res);
    const pages = payload(body).pages as { id: string }[];
    expect(pages.map((page) => page.id)).toEqual(["page-a", "page-b"]);
    expect(edge.searchPagesPage.mock.calls[0]?.[2]).toBeNull();
  });

  it("list_databases lists every database of the workspace", async () => {
    const res = await call({
      method: "tools/call",
      params: { name: "list_databases", arguments: {} },
    });
    const body = await rpc(res);
    const databases = payload(body).databases as { id: string }[];
    expect(databases.map((database) => database.id)).toEqual(["db-1", "db-2"]);
  });
});
