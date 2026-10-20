import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B88 (nach-verify) — the blank-query window of `search_pages` must be drawn
 * from the guest's visible page set.
 *
 * `guest-scope.test.ts` mocks the query layer, and that mock filtered the
 * hits unconditionally — stricter than the shipped `searchPages`, which
 * filtered only a *non-empty* query. A guest could therefore enumerate the id,
 * title, type and update time of every page of the workspace with
 * `query: ""` and the suite stayed green.
 *
 * This file therefore runs the **real** `src/server/queries.ts`: only the
 * transport edges are mocked (the database, the bearer token, the rate
 * limiter and the workspace lookup). The scope resolution (`pageScopeFor`),
 * the query layer and the response shaping all run for real.
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

const NEWEST = new Date("2026-01-03T00:00:00.000Z");
const MIDDLE = new Date("2026-01-02T00:00:00.000Z");
const OLDEST = new Date("2026-01-01T00:00:00.000Z");

/**
 * The workspace holds three pages; only `page-a` was shared with the guest.
 * The rows are listed in an order that is *not* the order the search returns
 * them in, so a passing order assertion means the sort was really applied.
 */
const PAGES: PageRow[] = [
  {
    id: "page-b",
    workspaceId: "ws-1",
    parentId: null,
    teamspaceId: null,
    createdById: "user-owner",
    title: "CONFIDENTIAL revenue",
    icon: null,
    type: "PAGE",
    content: { type: "doc", content: [{ type: "paragraph", text: "CONFIDENTIAL revenue" }] },
    updatedAt: MIDDLE,
    deletedAt: null,
    position: 200,
  },
  {
    id: "page-c",
    workspaceId: "ws-1",
    parentId: null,
    teamspaceId: null,
    createdById: "user-owner",
    title: "Salary plan",
    icon: null,
    type: "PAGE",
    content: { type: "doc", content: [{ type: "paragraph", text: "salary plan" }] },
    updatedAt: OLDEST,
    deletedAt: null,
    position: 300,
  },
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
    updatedAt: NEWEST,
    deletedAt: null,
    position: 100,
  },
];

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */

type Where = {
  id?: string | { in: string[] };
  workspaceId?: string;
  createdById?: string;
  deletedAt?: null;
};

type Select = Record<string, true>;

type OrderSpec = { id?: "asc" | "desc"; updatedAt?: "asc" | "desc" };

type FindManyArgs = {
  where: Where;
  select?: Select;
  orderBy?: OrderSpec | OrderSpec[];
  take?: number;
  skip?: number;
};

/** Project a row the way Prisma's `select` does. */
function project(row: Record<string, unknown>, select?: Select): Record<string, unknown> {
  if (!select) return row;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) out[key] = row[key];
  return out;
}

/** The subset of Prisma's `where` the search and the scope resolution use. */
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
  if (where.deletedAt === null && row.deletedAt !== null) return false;
  return true;
}

/** Order the rows the way the query's `orderBy` does. */
function sortRows(rows: PageRow[], orderBy: OrderSpec | OrderSpec[] | undefined): PageRow[] {
  if (!orderBy) return rows;
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      if (spec.updatedAt) {
        const diff = a.updatedAt.getTime() - b.updatedAt.getTime();
        if (diff !== 0) return spec.updatedAt === "desc" ? -diff : diff;
      }
      if (spec.id) {
        const diff = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        if (diff !== 0) return spec.id === "desc" ? -diff : diff;
      }
    }
    return 0;
  });
}

const db = vi.hoisted(() => ({
  apiTokenFindUnique: vi.fn(),
  pageFindMany: vi.fn(),
  pagePermissionFindMany: vi.fn(),
  teamspaceMemberFindMany: vi.fn(),
}));

const edge = vi.hoisted(() => ({
  authenticateApiRequest: vi.fn(),
  getWorkspaceAccess: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    apiToken: { findUnique: db.apiTokenFindUnique },
    page: { findMany: db.pageFindMany },
    pagePermission: { findMany: db.pagePermissionFindMany },
    teamspaceMember: { findMany: db.teamspaceMemberFindMany },
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
  edge.authenticateApiRequest.mockResolvedValue({ userId: "user-guest" });
  db.apiTokenFindUnique.mockResolvedValue({ scopes: ["read:pages", "admin:workspace"] });

  // The guest was shared "page-a" — nothing else.
  db.pagePermissionFindMany.mockResolvedValue([{ pageId: "page-a" }]);
  db.teamspaceMemberFindMany.mockResolvedValue([]);

  db.pageFindMany.mockImplementation(async ({ where, select, orderBy, take, skip }: FindManyArgs) => {
    const rows = sortRows(
      PAGES.filter((page) => matches(page, where)),
      orderBy,
    ).map((page) => project({ ...page }, select));
    const offset = skip ?? 0;
    return typeof take === "number" ? rows.slice(offset, offset + take) : rows.slice(offset);
  });
});

/* ------------------------------------------------------------------ */
/* The leak: a blank query enumerates the workspace                    */
/* ------------------------------------------------------------------ */

describe("MCP search_pages — the blank-query window is drawn from the visible set", () => {
  it("shows a guest only the pages shared with them for an empty query", async () => {
    const res = await call({
      method: "tools/call",
      params: { name: "search_pages", arguments: { query: "" } },
    });
    const body = await rpc(res);
    expect(body.error).toBeUndefined();
    const pages = payload(body).pages as { id: string }[];
    expect(pages.map((page) => page.id)).toEqual(["page-a"]);
    // The hidden pages' titles never reach the caller.
    expect(JSON.stringify(body)).not.toContain("CONFIDENTIAL");
    expect(JSON.stringify(body)).not.toContain("Salary");
  });

  it("shows a guest only the pages shared with them for a whitespace-only query", async () => {
    const res = await call({
      method: "tools/call",
      params: { name: "search_pages", arguments: { query: "   " } },
    });
    const body = await rpc(res);
    expect(body.error).toBeUndefined();
    const pages = payload(body).pages as { id: string }[];
    expect(pages.map((page) => page.id)).toEqual(["page-a"]);
    expect(JSON.stringify(body)).not.toContain("CONFIDENTIAL");
    expect(JSON.stringify(body)).not.toContain("Salary");
  });
});

/* ------------------------------------------------------------------ */
/* The control: a member still sees the whole workspace                */
/* ------------------------------------------------------------------ */

describe("MCP search_pages — an unscoped caller still sees the whole workspace", () => {
  beforeEach(() => {
    edge.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
  });

  it("lists every page of the workspace for a blank query", async () => {
    const res = await call({
      method: "tools/call",
      params: { name: "search_pages", arguments: { query: "" } },
    });
    const body = await rpc(res);
    const pages = payload(body).pages as { id: string }[];
    // Newest first, the id as the tie-break — the blank query still works.
    expect(pages.map((page) => page.id)).toEqual(["page-a", "page-b", "page-c"]);
  });
});
