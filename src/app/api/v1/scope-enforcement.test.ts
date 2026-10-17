import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B04 — API token scopes are not enforced on the REST API.
 *
 * A token carries a granted scope list (`ApiToken.scopes`); the v1 routes must
 * enforce it. The reproduction from the issue: a token created in the settings
 * UI with the single scope `read:pages` could still create a page through
 * `POST /api/v1/pages` — while the same token was correctly refused by the
 * MCP server. The two API surfaces disagreed about the same token.
 *
 * The test drives the real `authenticateApiRequest` (the bearer token is
 * resolved through the mocked Prisma row) so the whole chain is pinned:
 * token hash → token row → granted scopes → route decision. Only the database
 * and the transport edges around it are mocked; the scope hierarchy
 * (`hasScope` from `@/lib/api-token-scope`) runs for real, which is what
 * makes `write:pages` satisfy a `read:pages` requirement and an unknown scope
 * fail closed.
 */

const db = vi.hoisted(() => ({
  apiTokenFindUnique: vi.fn(),
  apiTokenUpdate: vi.fn(),
  pageFindFirst: vi.fn(),
  pageFindUnique: vi.fn(),
  pageCreate: vi.fn(),
}));
const queries = vi.hoisted(() => ({
  getPagesPage: vi.fn(),
  getPageTree: vi.fn(),
  searchPagesPage: vi.fn(),
  getWorkspacesPage: vi.fn(),
}));
const edge = vi.hoisted(() => ({
  getWorkspaceAccess: vi.fn(),
  canEditContent: vi.fn(),
  dispatchWebhooks: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    apiToken: { findUnique: db.apiTokenFindUnique, update: db.apiTokenUpdate },
    page: {
      findFirst: db.pageFindFirst,
      findUnique: db.pageFindUnique,
      create: db.pageCreate,
    },
  },
}));
vi.mock("@/lib/api-guard", () => ({ rateLimit: vi.fn(() => null) }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: edge.getWorkspaceAccess,
  canEditContent: edge.canEditContent,
}));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: edge.dispatchWebhooks }));
vi.mock("@/server/queries", () => queries);

import { hashApiToken } from "@/lib/api-auth";
import { GET as listPages, POST as createPage } from "./pages/route";
import { GET as readPage } from "./pages/[pageId]/route";
import { GET as search } from "./search/route";
import { GET as listWorkspaces } from "./workspaces/route";

const TOKEN = "noema_scope_test_token";
const TOKEN_HASH = hashApiToken(TOKEN);

/** The scopes the mocked token row currently grants. */
let grantedScopes: string[] = [];

const authed = (url: string, init: RequestInit = {}) =>
  new Request(url, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });

const listPagesCall = () => listPages(authed("http://localhost/api/v1/pages?workspaceId=ws-1"));

const createPageCall = () =>
  createPage(
    authed("http://localhost/api/v1/pages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws-1", title: "created despite read-only scope" }),
    }),
  );

const readPageCall = () =>
  readPage(authed("http://localhost/api/v1/pages/page-1"), {
    params: Promise.resolve({ pageId: "page-1" }),
  });

const searchCall = () => search(authed("http://localhost/api/v1/search?workspaceId=ws-1&q=roadmap"));

const listWorkspacesCall = () => listWorkspaces(authed("http://localhost/api/v1/workspaces"));

beforeEach(() => {
  vi.clearAllMocks();
  grantedScopes = ["read:pages"];
  db.apiTokenFindUnique.mockImplementation(async () => ({
    id: "token-1",
    userId: "user-1",
    tokenHash: TOKEN_HASH,
    scopes: grantedScopes,
  }));
  db.apiTokenUpdate.mockResolvedValue({ id: "token-1" });
  db.pageFindFirst.mockResolvedValue({ position: 0 });
  db.pageCreate.mockResolvedValue({ id: "page-1", title: "Untitled", type: "PAGE" });
  db.pageFindUnique.mockResolvedValue({
    id: "page-1",
    workspaceId: "ws-1",
    parentId: null,
    title: "Roadmap",
    icon: null,
    type: "PAGE",
    content: { type: "doc", content: [] },
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
  });
  queries.getPagesPage.mockResolvedValue({ items: [], hasMore: false, nextCursor: null });
  queries.getPageTree.mockResolvedValue([]);
  queries.searchPagesPage.mockResolvedValue({ items: [], hasMore: false, nextCursor: null });
  queries.getWorkspacesPage.mockResolvedValue({ items: [], hasMore: false, nextCursor: null });
  edge.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
  edge.canEditContent.mockReturnValue(true);
});

describe("POST /api/v1/pages — write scope", () => {
  it("refuses a read-only token and creates nothing", async () => {
    grantedScopes = ["read:pages"];
    const response = await createPageCall();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "insufficient_scope",
      required: "write:pages",
    });
    expect(db.pageCreate).not.toHaveBeenCalled();
    // The refusal happens before the workspace is even looked up.
    expect(edge.getWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("lets a write token create the page", async () => {
    grantedScopes = ["write:pages"];
    const response = await createPageCall();

    expect(response.status).toBe(201);
    expect(db.pageCreate).toHaveBeenCalledTimes(1);
  });

  it("refuses a token whose only scope is an unrelated read scope", async () => {
    grantedScopes = ["read:tickets"];
    const response = await createPageCall();

    expect(response.status).toBe(403);
    expect(db.pageCreate).not.toHaveBeenCalled();
  });
});

describe("read routes — read scope", () => {
  it("lists pages for a read-only token", async () => {
    grantedScopes = ["read:pages"];
    const response = await listPagesCall();

    expect(response.status).toBe(200);
    expect(queries.getPagesPage).toHaveBeenCalledTimes(1);
  });

  it("reads a single page for a read-only token", async () => {
    grantedScopes = ["read:pages"];
    const response = await readPageCall();

    expect(response.status).toBe(200);
  });

  it("searches for a read-only token", async () => {
    grantedScopes = ["read:pages"];
    const response = await searchCall();

    expect(response.status).toBe(200);
    expect(queries.searchPagesPage).toHaveBeenCalledTimes(1);
  });

  it("lists the caller's workspaces for a read-only token", async () => {
    grantedScopes = ["read:pages"];
    const response = await listWorkspacesCall();

    expect(response.status).toBe(200);
    expect(queries.getWorkspacesPage).toHaveBeenCalledTimes(1);
  });

  it("refuses every read route for a token without any scope", async () => {
    grantedScopes = [];

    for (const call of [listPagesCall, readPageCall, searchCall, listWorkspacesCall]) {
      const response = await call();
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "insufficient_scope",
        required: "read:pages",
      });
    }
    expect(queries.getPagesPage).not.toHaveBeenCalled();
    expect(queries.searchPagesPage).not.toHaveBeenCalled();
    expect(queries.getWorkspacesPage).not.toHaveBeenCalled();
  });

  it("refuses every read route for an unknown scope (fails closed)", async () => {
    grantedScopes = ["read:everything"];

    for (const call of [listPagesCall, readPageCall, searchCall, listWorkspacesCall]) {
      const response = await call();
      expect(response.status).toBe(403);
    }
  });
});

describe("scope hierarchy", () => {
  it("lets a write token read pages (write implies read)", async () => {
    grantedScopes = ["write:pages"];

    expect((await listPagesCall()).status).toBe(200);
    expect((await readPageCall()).status).toBe(200);
    expect((await searchCall()).status).toBe(200);
  });

  it("lets an admin token do everything", async () => {
    grantedScopes = ["admin:workspace"];

    expect((await listPagesCall()).status).toBe(200);
    expect((await readPageCall()).status).toBe(200);
    expect((await searchCall()).status).toBe(200);
    expect((await listWorkspacesCall()).status).toBe(200);
    expect((await createPageCall()).status).toBe(201);
  });
});

describe("unauthenticated callers", () => {
  it("answers 401 without a bearer token", async () => {
    const response = await listPages(new Request("http://localhost/api/v1/pages?workspaceId=ws-1"));

    expect(response.status).toBe(401);
    expect(queries.getPagesPage).not.toHaveBeenCalled();
  });
});
