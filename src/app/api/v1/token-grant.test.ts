import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B04 — a token created through the settings home must carry its grant.
 *
 * The settings home (`/w/[slug]/settings`) renders the inline
 * `ApiTokenManager`; its create action lives in
 * `src/server/actions/tokens.ts`. That action used to persist the token
 * *without* scopes — the `scopes` column kept its schema default `[]` — even
 * though the scope picker in the very same UI handed the picked scopes to the
 * action and the action dropped them on the floor.
 *
 * As soon as the `/api/v1/*` routes enforce the grant, such a token is refused
 * with `403 insufficient_scope` on every call: a silent break for everyone who
 * mints a token on the main settings page. This test drives the real action
 * and the real route over one mocked database, so the whole chain is pinned:
 * picker → action → stored row → route decision. Only the database and the
 * transport edges around it are mocked.
 */

type StoredToken = {
  id: string;
  userId: string;
  name: string;
  tokenHash: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
};

/** The token rows the mocked database holds. */
const store = vi.hoisted(() => ({ tokens: [] as StoredToken[] }));

const db = vi.hoisted(() => ({
  apiTokenCreate: vi.fn(),
  apiTokenFindUnique: vi.fn(),
  apiTokenUpdate: vi.fn(),
  pageFindFirst: vi.fn(),
  pageCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    apiToken: {
      create: db.apiTokenCreate,
      findUnique: db.apiTokenFindUnique,
      update: db.apiTokenUpdate,
    },
    page: {
      findFirst: db.pageFindFirst,
      create: db.pageCreate,
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "user-1", email: "ci@example.test", name: "CI" })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/api-guard", () => ({ rateLimit: vi.fn(() => null) }));

vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: vi.fn(async () => ({ role: "MEMBER" })),
  canEditContent: vi.fn(() => true),
}));

vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: vi.fn(async () => undefined) }));

vi.mock("@/server/queries", () => ({
  getPagesPage: vi.fn(async () => ({ items: [], hasMore: false, nextCursor: null })),
  getPageTree: vi.fn(async () => []),
}));

import { createApiTokenAction } from "@/server/actions/tokens";
import { GET as listPages, POST as createPage } from "./pages/route";

const authed = (token: string, url: string, init: RequestInit = {}) =>
  new Request(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });

/** The plaintext of a created token, or "" when the action refused. */
const plaintext = (result: { token: string } | { error: string }): string =>
  "token" in result ? result.token : "";

beforeEach(() => {
  vi.clearAllMocks();
  store.tokens.length = 0;

  db.apiTokenCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    const row: StoredToken = {
      id: `token-${store.tokens.length + 1}`,
      userId: String(data.userId),
      name: String(data.name),
      tokenHash: String(data.tokenHash),
      // The schema default is an empty grant, so a create call that passes no
      // scopes must end up with exactly that — the old behaviour.
      scopes: Array.isArray(data.scopes) ? (data.scopes as string[]) : [],
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      lastUsedAt: null,
    };
    store.tokens.push(row);
    return row;
  });

  db.apiTokenFindUnique.mockImplementation(
    async ({ where }: { where: { tokenHash: string } }) =>
      store.tokens.find((row) => row.tokenHash === where.tokenHash) ?? null,
  );

  db.apiTokenUpdate.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const row = store.tokens.find((entry) => entry.id === where.id);
    if (row) row.lastUsedAt = new Date("2026-01-02T00:00:00.000Z");
    return row ?? null;
  });

  db.pageFindFirst.mockResolvedValue({ position: 0 });
  db.pageCreate.mockResolvedValue({ id: "page-1", title: "Untitled", type: "PAGE" });
});

describe("a token created through the settings home", () => {
  it("stores the picked scopes on the row", async () => {
    const created = await createApiTokenAction("CI token", ["read:pages"]);

    expect(plaintext(created)).toMatch(/^noema_/);
    expect(store.tokens).toHaveLength(1);
    expect(store.tokens[0].scopes).toEqual(["read:pages"]);
  });

  it("is accepted by a v1 read route instead of being refused with 403", async () => {
    const created = await createApiTokenAction("CI token", ["read:pages"]);

    // The row carries the grant — without it the route refuses the token.
    expect(store.tokens[0].scopes).toEqual(["read:pages"]);

    const response = await listPages(
      authed(plaintext(created), "http://localhost/api/v1/pages?workspaceId=ws-1"),
    );

    expect(response.status).toBe(200);
  });

  it("is accepted by a v1 write route when it carries the write scope", async () => {
    const created = await createApiTokenAction("CI token", ["write:pages"]);

    expect(store.tokens[0].scopes).toEqual(["read:pages", "write:pages"]);

    const response = await createPage(
      authed(plaintext(created), "http://localhost/api/v1/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "ws-1", title: "created from CI" }),
      }),
    );

    expect(response.status).toBe(201);
    expect(db.pageCreate).toHaveBeenCalledTimes(1);
  });

  it("stores the expanded grant, so a write scope also carries the read scope", async () => {
    await createApiTokenAction("CI token", ["write:pages"]);

    expect(store.tokens[0].scopes).toEqual(["read:pages", "write:pages"]);
  });

  it("refuses an invalid scope list instead of storing a partial grant", async () => {
    const created = await createApiTokenAction("CI token", ["read:everything"]);

    expect(created).toEqual({ error: "Invalid scopes." });
    expect(store.tokens).toHaveLength(0);
  });
});

describe("a token created without any scope", () => {
  it("keeps the empty grant and is refused with 403 — it has to be re-created", async () => {
    const created = await createApiTokenAction("Legacy token");

    expect(store.tokens[0].scopes).toEqual([]);

    const response = await listPages(
      authed(plaintext(created), "http://localhost/api/v1/pages?workspaceId=ws-1"),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "insufficient_scope",
      required: "read:pages",
    });
  });
});
