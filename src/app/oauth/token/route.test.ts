import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /oauth/token` — the authorization-code exchange.
 *
 * The property pinned here is RFC 6749 §4.1.2: an authorization code is
 * single-use. The endpoint therefore *consumes* the code with a conditional
 * update (`UPDATE ... WHERE used = false`) and issues a token only when that
 * update matched exactly one row. The mocked database below reproduces the
 * window the finding describes: two concurrent exchanges read the code while
 * it is still unused, and only one of them may consume it.
 */

const db = vi.hoisted(() => ({
  appFindUnique: vi.fn(),
  codeFindUnique: vi.fn(),
  codeUpdateMany: vi.fn(),
  codeUpdate: vi.fn(),
  tokenCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    oAuthApp: { findUnique: db.appFindUnique },
    oAuthCode: {
      findUnique: db.codeFindUnique,
      updateMany: db.codeUpdateMany,
      update: db.codeUpdate,
    },
    apiToken: { create: db.tokenCreate },
  },
}));

vi.mock("@/lib/api-guard", () => ({ rateLimit: vi.fn(() => null) }));

import { POST } from "./route";

const APP = {
  id: "app-1",
  userId: "user-1",
  name: "Demo app",
  clientId: "client-1",
  clientSecret: "secret-1",
  redirectUris: ["https://app.example.test/cb"],
  requiresPkce: false,
};

type CodeRow = {
  id: string;
  code: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  expiresAt: Date;
  used: boolean;
};

const CODE: CodeRow = {
  id: "code-1",
  code: "auth-code",
  clientId: APP.clientId,
  userId: APP.userId,
  redirectUri: "https://app.example.test/cb",
  codeChallenge: null,
  codeChallengeMethod: null,
  expiresAt: new Date(Date.now() + 5 * 60_000),
  used: false,
};

/**
 * Holds every exchange at the code read until `target` of them have read the
 * row. That is the TOCTOU window: the reads happen while the code is still
 * unused, and only afterwards do the exchanges try to consume it.
 */
function createReadBarrier(target: number) {
  let seen = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    async reach(): Promise<void> {
      seen += 1;
      if (seen >= target) open();
      await opened;
    },
  };
}

/** The barrier the next code read has to pass; open by default. */
let readBarrier: { reach: () => Promise<void> } = {
  reach: async () => undefined,
};

const post = (params: Record<string, string> = {}) =>
  POST(
    new Request("http://localhost/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: CODE.code,
        client_id: APP.clientId,
        client_secret: APP.clientSecret,
        redirect_uri: CODE.redirectUri,
        ...params,
      }).toString(),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  readBarrier = { reach: async () => undefined };

  const row: CodeRow = { ...CODE, expiresAt: new Date(Date.now() + 5 * 60_000) };

  db.appFindUnique.mockImplementation(async ({ where }: { where: { clientId: string } }) =>
    where.clientId === APP.clientId ? { ...APP } : null,
  );

  // The read returns the row as it looked when it was read — the snapshot a
  // concurrent transaction sees before the other one commits.
  db.codeFindUnique.mockImplementation(async ({ where }: { where: { code: string } }) => {
    if (where.code !== row.code) return null;
    const snapshot = { ...row };
    await readBarrier.reach();
    return snapshot;
  });

  // Postgres semantics: the row is only matched while it is still unused.
  db.codeUpdateMany.mockImplementation(
    async ({ where }: { where: { id: string; used?: boolean } }) => {
      if (where.id !== row.id) return { count: 0 };
      if (where.used !== undefined && row.used !== where.used) return { count: 0 };
      row.used = true;
      return { count: 1 };
    },
  );

  // The unguarded write the endpoint used before the fix: it ignores the
  // `used` flag, so a second exchange always "succeeds".
  db.codeUpdate.mockImplementation(async ({ where }: { where: { id: string } }) => {
    if (where.id !== row.id) throw new Error("record not found");
    row.used = true;
    return { ...row };
  });

  db.tokenCreate.mockImplementation(async () => ({ id: "token-1" }));
});

describe("POST /oauth/token — single-use authorization codes", () => {
  it("exchanges a valid code for an API token", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { access_token: string };
    expect(body.access_token).toMatch(/^noema_/);
    expect(db.tokenCreate).toHaveBeenCalledTimes(1);
  });

  it("consumes the code with a conditional update on the unused flag", async () => {
    await post();
    expect(db.codeUpdateMany).toHaveBeenCalledWith({
      where: { id: CODE.id, used: false },
      data: { used: true },
    });
    expect(db.codeUpdate).not.toHaveBeenCalled();
  });

  it("rejects a second exchange of the same code", async () => {
    const first = await post();
    expect(first.status).toBe(200);

    const second = await post();
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: "invalid_grant" });
    expect(db.tokenCreate).toHaveBeenCalledTimes(1);
  });

  it("lets only one of two concurrent exchanges win", async () => {
    // Both exchanges read the code while it is still unused.
    readBarrier = createReadBarrier(2);

    const [first, second] = await Promise.all([post(), post()]);
    expect([first.status, second.status].sort()).toEqual([200, 400]);

    const rejected = first.status === 400 ? first : second;
    expect(await rejected.json()).toEqual({ error: "invalid_grant" });
    expect(db.tokenCreate).toHaveBeenCalledTimes(1);
  });

  it("issues no token when the conditional update matches no row", async () => {
    // The code was consumed by another request between the read and the write.
    db.codeUpdateMany.mockResolvedValue({ count: 0 });

    const response = await post();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_grant" });
    expect(db.tokenCreate).not.toHaveBeenCalled();
  });

  it("does not consume the code when the PKCE verifier is wrong", async () => {
    db.codeFindUnique.mockResolvedValue({
      ...CODE,
      codeChallenge: "challenge-value",
      codeChallengeMethod: "S256",
    });

    const response = await post({
      code_verifier: "wrong-verifier-that-is-long-enough-for-pkce-checks",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_grant" });
    expect(db.codeUpdateMany).not.toHaveBeenCalled();
    expect(db.tokenCreate).not.toHaveBeenCalled();
  });
});
