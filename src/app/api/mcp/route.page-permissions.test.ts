import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Page-level `PagePermission` enforcement on the MCP write tools.
 *
 * A workspace role is not enough: a `MEMBER` with a `READ`/`COMMENT` row on a
 * page must not use the API token surface to bypass the editor's restriction.
 * The write tools therefore apply the same capability matrix as the server
 * actions, on the page, on the parent of `create_page`, and on both the row and
 * its database for `update_property_value`.
 */

const db = vi.hoisted(() => ({
  pageFindFirst: vi.fn(),
  pageCreate: vi.fn(),
  pageUpdate: vi.fn(),
  propertyFindFirst: vi.fn(),
  propertyValueUpsert: vi.fn(),
}));

const auth = vi.hoisted(() => ({ authenticateApiRequest: vi.fn() }));
const perms = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: {
      findFirst: db.pageFindFirst,
      create: db.pageCreate,
      update: db.pageUpdate,
    },
    property: { findFirst: db.propertyFindFirst },
    propertyValue: { upsert: db.propertyValueUpsert },
  },
}));

vi.mock("@/lib/api-auth", () => ({
  authenticateApiRequest: auth.authenticateApiRequest,
}));

vi.mock("@/lib/api-guard", () => ({ rateLimit: () => null }));

vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: perms.getWorkspaceAccess };
});

vi.mock("@/server/queries", () => ({ searchPagesPage: vi.fn() }));

import { POST } from "./route";

const call = (name: string, args: Record<string, unknown>) =>
  POST(
    new Request("http://localhost/api/mcp?workspaceId=ws1&allowWrite=true", {
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

async function toolResult(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as {
    result?: { content?: { text?: string }[] };
  };
  return JSON.parse(body.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

/** A page row the mocked `loadPageForWrite` reads. */
const pageRow = (overrides: Record<string, unknown> = {}) => ({
  id: "page-1",
  parentId: null,
  type: "PAGE",
  content: { type: "doc", content: [] },
  permissions: [] as { level: string }[],
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.authenticateApiRequest.mockResolvedValue({
    userId: "user-1",
    scopes: ["write:pages", "write:databases"],
  });
  perms.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
  db.pageCreate.mockResolvedValue({ id: "page-new", title: "Untitled", type: "PAGE" });
  db.pageUpdate.mockResolvedValue({});
  db.propertyFindFirst.mockResolvedValue({ id: "property-1" });
  db.propertyValueUpsert.mockResolvedValue({ id: "value-1" });
});

describe("MCP create_page honours the parent's page-level restriction", () => {
  it("refuses a READ parent and writes nothing", async () => {
    db.pageFindFirst.mockImplementation(
      async (args: { where: { id?: string }; select?: Record<string, unknown> }) => {
        if (args.where.id !== "parent-1") return null;
        // assertScopedParent proves the tenant with `{ id: true }`; the
        // assertEditableParent lookup asks for the caller's permission row.
        if (args.select?.permissions) return { permissions: [{ level: "READ" }] };
        return { id: "parent-1" };
      },
    );

    const result = await toolResult(
      await call("create_page", { title: "x", parentId: "parent-1" }),
    );

    expect(result).toEqual({
      error: "You do not have permission to add a page here.",
    });
    expect(db.pageCreate).not.toHaveBeenCalled();
  });

  it("creates under an editable parent", async () => {
    db.pageFindFirst.mockImplementation(
      async (args: { where: { id?: string }; select?: Record<string, unknown> }) => {
        if (args.where.id === "parent-1") {
          if (args.select?.permissions) return { permissions: [] };
          return { id: "parent-1" };
        }
        return { position: 0 };
      },
    );

    const result = await toolResult(
      await call("create_page", { title: "x", parentId: "parent-1" }),
    );

    expect(result).toMatchObject({ page: { id: "page-new" } });
    expect(db.pageCreate).toHaveBeenCalledTimes(1);
  });
});

describe("MCP append_blocks honours the page restriction", () => {
  it("refuses to append to a READ page", async () => {
    db.pageFindFirst.mockResolvedValue(
      pageRow({ permissions: [{ level: "READ" }] }),
    );

    const result = await toolResult(
      await call("append_blocks", {
        pageId: "page-1",
        blocks: [{ type: "paragraph", text: "x" }],
      }),
    );

    expect(result).toEqual({ error: "Page not found." });
    expect(db.pageUpdate).not.toHaveBeenCalled();
  });

  it("refuses to append to a locked page even when it is editable", async () => {
    db.pageFindFirst.mockResolvedValue(pageRow({ locked: true }));

    const result = await toolResult(
      await call("append_blocks", {
        pageId: "page-1",
        blocks: [{ type: "paragraph", text: "x" }],
      }),
    );

    expect(result).toEqual({
      error: "This page is locked. Unlock it to edit its content.",
    });
    expect(db.pageUpdate).not.toHaveBeenCalled();
  });
});

describe("MCP update_property_value honours the row and database restrictions", () => {
  it("refuses a READ row even when the database is editable", async () => {
    db.pageFindFirst.mockResolvedValueOnce(
      pageRow({ parentId: "db-1", type: "PAGE", permissions: [{ level: "READ" }] }),
    );

    const result = await toolResult(
      await call("update_property_value", {
        pageId: "page-1",
        property: "property-1",
        value: '"x"',
      }),
    );

    expect(result).toEqual({ error: "Row not found." });
    expect(db.propertyValueUpsert).not.toHaveBeenCalled();
  });

  it("refuses a READ database even when the row is editable", async () => {
    db.pageFindFirst
      .mockResolvedValueOnce(pageRow({ parentId: "db-1", type: "PAGE", permissions: [] }))
      .mockResolvedValueOnce(
        pageRow({
          id: "db-1",
          parentId: null,
          type: "DATABASE",
          content: null,
          permissions: [{ level: "READ" }],
        }),
      );

    const result = await toolResult(
      await call("update_property_value", {
        pageId: "page-1",
        property: "property-1",
        value: '"x"',
      }),
    );

    expect(result).toEqual({ error: "Property not found." });
    expect(db.propertyValueUpsert).not.toHaveBeenCalled();
  });

  it("writes the cell when both the row and the database are editable", async () => {
    db.pageFindFirst
      .mockResolvedValueOnce(pageRow({ parentId: "db-1", type: "PAGE", permissions: [] }))
      .mockResolvedValueOnce(
        pageRow({
          id: "db-1",
          parentId: null,
          type: "DATABASE",
          content: null,
          permissions: [],
        }),
      );

    const result = await toolResult(
      await call("update_property_value", {
        pageId: "page-1",
        property: "property-1",
        value: '"x"',
      }),
    );

    expect(result).toMatchObject({ value: { id: "value-1" } });
    expect(db.propertyValueUpsert).toHaveBeenCalledTimes(1);
  });
});
