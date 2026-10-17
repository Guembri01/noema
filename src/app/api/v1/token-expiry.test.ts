import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B29 — an API token had neither an expiry nor a revoke flag.
 *
 * The `ApiToken` row carried no deadline: a token that leaked (a CI log, a
 * screenshot, the laptop of a former employee) kept working until somebody
 * happened to delete it by hand. The finding asks for a deadline on the token
 * and for the bearer resolver to honour it.
 *
 * This test drives the real creation action, the real resolver and the real v1
 * route over one mocked database, so the whole chain is pinned:
 * action → stored row → resolver → route decision. Only the database and the
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
  expiresAt: Date | null;
};

/** The token rows the mocked database holds. */
const store = vi.hoisted(() => ({ tokens: [] as StoredToken[] }));

const db = vi.hoisted(() => ({
  apiTokenCreate: vi.fn(),
  apiTokenFindUnique: vi.fn(),
  apiTokenFindMany: vi.fn(),
  apiTokenUpdate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    apiToken: {
      create: db.apiTokenCreate,
      findUnique: db.apiTokenFindUnique,
      findMany: db.apiTokenFindMany,
      update: db.apiTokenUpdate,
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "user-1", email: "ci@example.test", name: "CI" })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/api-guard", () => ({ rateLimit: vi.fn(() => null) }));

vi.mock("@/server/queries", () => ({
  getWorkspacesPage: vi.fn(async () => ({ items: [], hasMore: false, nextCursor: null })),
}));

import { API_TOKEN_LIFETIME_MS, authenticateApiRequest, hashApiToken } from "@/lib/api-auth";
import { createApiTokenAction, listApiTokensAction } from "@/server/actions/api-tokens";
import { GET as listWorkspaces } from "./workspaces/route";

const DAY = 24 * 60 * 60 * 1000;

/** The plaintext of a created token, or "" when the action refused. */
const plaintext = (result: { token: string } | { error: string }): string =>
  "token" in result ? result.token : "";

const bearer = (token: string) =>
  new Request("http://localhost/api/v1/workspaces", {
    headers: { authorization: `Bearer ${token}` },
  });

/** Put a token row into the mocked database. */
function seedToken(over: Partial<StoredToken> = {}): StoredToken {
  const row: StoredToken = {
    id: `token-${store.tokens.length + 1}`,
    userId: "user-1",
    name: "CI token",
    tokenHash: hashApiToken("noema_seeded_token"),
    scopes: ["read:pages"],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    lastUsedAt: null,
    expiresAt: null,
    ...over,
  };
  store.tokens.push(row);
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  store.tokens.length = 0;

  db.apiTokenCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    const row: StoredToken = {
      id: `token-${store.tokens.length + 1}`,
      userId: String(data.userId),
      name: String(data.name),
      tokenHash: String(data.tokenHash),
      scopes: Array.isArray(data.scopes) ? (data.scopes as string[]) : [],
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      lastUsedAt: null,
      // The deadline the action wrote on the row — `null` when it wrote none.
      expiresAt: data.expiresAt instanceof Date ? data.expiresAt : null,
    };
    store.tokens.push(row);
    return row;
  });

  db.apiTokenFindUnique.mockImplementation(
    async ({ where }: { where: { tokenHash: string } }) =>
      store.tokens.find((row) => row.tokenHash === where.tokenHash) ?? null,
  );

  db.apiTokenFindMany.mockImplementation(async () => [...store.tokens]);

  db.apiTokenUpdate.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const row = store.tokens.find((entry) => entry.id === where.id);
    if (row) row.lastUsedAt = new Date("2026-01-02T00:00:00.000Z");
    return row ?? null;
  });
});

describe("authenticateApiRequest — the deadline of the token", () => {
  it("refuses a token whose deadline has passed", async () => {
    seedToken({
      tokenHash: hashApiToken("noema_expired_token"),
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(authenticateApiRequest(bearer("noema_expired_token"))).resolves.toBeNull();
  });

  it("accepts a token whose deadline is still ahead", async () => {
    seedToken({
      tokenHash: hashApiToken("noema_live_token"),
      expiresAt: new Date(Date.now() + DAY),
    });

    await expect(authenticateApiRequest(bearer("noema_live_token"))).resolves.toEqual({
      userId: "user-1",
      scopes: ["read:pages"],
    });
  });

  it("accepts a token without a deadline", async () => {
    seedToken({ tokenHash: hashApiToken("noema_undated_token"), expiresAt: null });

    await expect(authenticateApiRequest(bearer("noema_undated_token"))).resolves.toEqual({
      userId: "user-1",
      scopes: ["read:pages"],
    });
  });

  it("reads the deadline in the query that verifies the token", async () => {
    seedToken({ tokenHash: hashApiToken("noema_live_token") });

    await authenticateApiRequest(bearer("noema_live_token"));

    expect(db.apiTokenFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ expiresAt: true }),
      }),
    );
  });

  it("does not bump lastUsedAt for a token it refused", async () => {
    seedToken({
      tokenHash: hashApiToken("noema_expired_token"),
      expiresAt: new Date(Date.now() - 1000),
    });

    await authenticateApiRequest(bearer("noema_expired_token"));

    expect(db.apiTokenUpdate).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/workspaces — an expired token", () => {
  it("answers 401 and runs no query", async () => {
    seedToken({
      tokenHash: hashApiToken("noema_expired_token"),
      expiresAt: new Date(Date.now() - 1000),
    });

    const response = await listWorkspaces(bearer("noema_expired_token"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("answers 200 for a token that is still alive", async () => {
    seedToken({
      tokenHash: hashApiToken("noema_live_token"),
      expiresAt: new Date(Date.now() + DAY),
    });

    const response = await listWorkspaces(bearer("noema_live_token"));

    expect(response.status).toBe(200);
  });
});

describe("createApiTokenAction — the deadline it mints", () => {
  it("stores the default lifetime on the new row", async () => {
    const before = Date.now();

    await createApiTokenAction("CI token", ["read:pages"]);

    const expiresAt = store.tokens[0].expiresAt;
    expect(expiresAt).toBeInstanceOf(Date);
    const deadline = (expiresAt as Date).getTime();
    expect(deadline).toBeGreaterThanOrEqual(before + API_TOKEN_LIFETIME_MS);
    expect(deadline).toBeLessThanOrEqual(Date.now() + API_TOKEN_LIFETIME_MS);
  });

  it("mints a token that authenticates right away", async () => {
    const created = await createApiTokenAction("CI token", ["read:pages"]);

    await expect(authenticateApiRequest(bearer(plaintext(created)))).resolves.toEqual({
      userId: "user-1",
      scopes: ["read:pages"],
    });
  });
});

describe("listApiTokensAction — the deadline in the list", () => {
  it("hands the deadline to the settings list", async () => {
    const expiresAt = new Date("2026-04-01T00:00:00.000Z");
    seedToken({ expiresAt });

    const tokens = await listApiTokensAction();

    expect(tokens[0].expiresAt).toBe(expiresAt.toISOString());
  });

  it("reports no deadline for a token that carries none", async () => {
    seedToken({ expiresAt: null });

    const tokens = await listApiTokensAction();

    expect(tokens[0].expiresAt).toBeNull();
  });
});
