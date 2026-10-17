import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

/**
 * `src/app/oauth/token/route.ts` — the token endpoint must verify a client
 * secret against its **digest** and redeem an authorization code by its
 * **digest**.
 *
 * The mocked app row carries `clientSecretHash` and nothing else, so the
 * happy path only passes when the route compares the presented secret against
 * the stored hash. The code is looked up by `codeHash`, so a database dump
 * holds no redeemable code.
 *
 * The mocked database below also reproduces the race the endpoint has to
 * survive: two exchanges of the *same* code read the row while it is still
 * unused, and only one of them may consume it. The mock mirrors the Postgres
 * semantics of the conditional update — `UPDATE … WHERE used = false` matches
 * a row only while it is unused, so the second writer gets `count: 0`.
 */

const db = vi.hoisted(() => ({
  oAuthAppFindUnique: vi.fn(),
  oAuthCodeFindUnique: vi.fn(),
  oAuthCodeUpdateMany: vi.fn(),
  oAuthCodeUpdate: vi.fn(),
  apiTokenCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    oAuthApp: { findUnique: db.oAuthAppFindUnique },
    oAuthCode: {
      findUnique: db.oAuthCodeFindUnique,
      updateMany: db.oAuthCodeUpdateMany,
      update: db.oAuthCodeUpdate,
    },
    apiToken: { create: db.apiTokenCreate },
  },
}));

// The rate limiter is not what this test is about; keep the window open.
vi.mock("@/lib/api-guard", () => ({ rateLimit: vi.fn(() => null) }));

import { POST } from "./route";

const CLIENT_ID = "noema_client123";
const CLIENT_SECRET = "client-secret-plaintext";
const CODE = "authorization-code-plaintext";
const REDIRECT_URI = "https://app.example.test/cb";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

type CodeRow = {
  id: string;
  codeHash: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  expiresAt: Date;
  used: boolean;
};

/** The row the mocked database holds; `used` is the state the race turns on. */
let codeRow: CodeRow;

/**
 * Holds every exchange at the code read until `target` of them have read the
 * row. That is the window in which two parallel exchanges both see an unused
 * code — the read-then-write window the conditional update has to close.
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
let readBarrier: { reach: () => Promise<void> } = { reach: async () => undefined };

function tokenRequest(fields: Record<string, string>): Request {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  return new Request("http://localhost/oauth/token", { method: "POST", body });
}

function validGrant(overrides: Record<string, string> = {}): Request {
  return tokenRequest({
    grant_type: "authorization_code",
    code: CODE,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  readBarrier = { reach: async () => undefined };

  codeRow = {
    id: "code-1",
    codeHash: sha256(CODE),
    clientId: CLIENT_ID,
    userId: "user-1",
    redirectUri: REDIRECT_URI,
    codeChallenge: null,
    codeChallengeMethod: null,
    expiresAt: new Date(Date.now() + 60_000),
    used: false,
  };

  db.oAuthAppFindUnique.mockResolvedValue({
    id: "app-1",
    name: "Test app",
    clientId: CLIENT_ID,
    clientSecretHash: sha256(CLIENT_SECRET),
    redirectUris: [REDIRECT_URI],
    requiresPkce: false,
  });

  // The read answers with the row as it looked when it was read — the
  // snapshot a concurrent exchange sees before the other one writes.
  db.oAuthCodeFindUnique.mockImplementation(async () => {
    const snapshot = { ...codeRow };
    await readBarrier.reach();
    return snapshot;
  });

  // Postgres semantics of the conditional update: the row is matched only
  // while it is still unused.
  db.oAuthCodeUpdateMany.mockImplementation(
    async ({ where }: { where: { id: string; used?: boolean } }) => {
      if (where.id !== codeRow.id) return { count: 0 };
      if (where.used !== undefined && codeRow.used !== where.used) return { count: 0 };
      codeRow.used = true;
      return { count: 1 };
    },
  );

  // The unguarded write the endpoint used before the fix: it ignores the
  // `used` flag, so a second exchange always "succeeds".
  db.oAuthCodeUpdate.mockImplementation(async ({ where }: { where: { id: string } }) => {
    if (where.id !== codeRow.id) throw new Error("record not found");
    codeRow.used = true;
    return { ...codeRow };
  });

  db.apiTokenCreate.mockResolvedValue({ id: "token-1" });
});

describe("POST /oauth/token", () => {
  it("exchanges a code for an access token when the client presents its secret", async () => {
    const res = await POST(validGrant());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; token_type: string };
    expect(body.access_token).toMatch(/^noema_/);
    expect(body.token_type).toBe("Bearer");
  });

  it("looks the authorization code up by its digest, never by the plaintext", async () => {
    await POST(validGrant());

    expect(db.oAuthCodeFindUnique).toHaveBeenCalledWith({
      where: { codeHash: sha256(CODE) },
    });
    const where = db.oAuthCodeFindUnique.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.code).toBeUndefined();
    expect(where.codeHash).not.toBe(CODE);
  });

  it("verifies the client secret against the stored digest", async () => {
    await POST(validGrant());

    const app = db.oAuthAppFindUnique.mock.results[0].value as Promise<{
      clientSecretHash: string;
    }>;
    await expect(app).resolves.toMatchObject({ clientSecretHash: sha256(CLIENT_SECRET) });
  });

  it("refuses a wrong client secret without redeeming the code", async () => {
    const res = await POST(validGrant({ client_secret: "wrong-secret" }));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "invalid_client" });
    expect(db.oAuthCodeFindUnique).not.toHaveBeenCalled();
    expect(db.apiTokenCreate).not.toHaveBeenCalled();
  });

  it("refuses a secret of the same length but different content", async () => {
    const res = await POST(validGrant({ client_secret: "client-secret-plaintexT" }));

    expect(res.status).toBe(401);
    expect(db.apiTokenCreate).not.toHaveBeenCalled();
  });

  it("refuses an unknown authorization code", async () => {
    db.oAuthCodeFindUnique.mockResolvedValue(null);

    const res = await POST(validGrant());

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid_grant" });
    expect(db.apiTokenCreate).not.toHaveBeenCalled();
  });

  it("refuses a replayed code", async () => {
    db.oAuthCodeFindUnique.mockResolvedValue({
      ...codeRow,
      used: true,
    });

    const res = await POST(validGrant());

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid_grant" });
  });

  it("refuses an unknown client", async () => {
    db.oAuthAppFindUnique.mockResolvedValue(null);

    const res = await POST(validGrant());

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "invalid_client" });
  });

  it("marks the code used and stores the access token hashed", async () => {
    const res = await POST(validGrant());
    const body = (await res.json()) as { access_token: string };

    // The code is consumed with a conditional update, not with a blind write:
    // the `used = false` in the predicate is what makes the exchange
    // single-use under concurrency.
    expect(db.oAuthCodeUpdateMany).toHaveBeenCalledWith({
      where: { id: "code-1", used: false },
      data: { used: true },
    });
    expect(db.oAuthCodeUpdate).not.toHaveBeenCalled();
    const data = db.apiTokenCreate.mock.calls[0][0].data as Record<string, unknown>;
    // The minted access token is stored as a digest, like every other token.
    expect(data.tokenHash).toBe(sha256(body.access_token));
    expect(data.tokenHash).not.toBe(body.access_token);
  });

  it("lets only one of two parallel exchanges of the same code win", async () => {
    // Both exchanges read the code while it is still unused — the read-then-
    // write window.
    readBarrier = createReadBarrier(2);

    const [first, second] = await Promise.all([POST(validGrant()), POST(validGrant())]);

    // Exactly one exchange gets a token; the other is refused.
    expect([first.status, second.status].sort()).toEqual([200, 400]);
    const rejected = first.status === 400 ? first : second;
    await expect(rejected.json()).resolves.toEqual({ error: "invalid_grant" });
    // And only one token was minted.
    expect(db.apiTokenCreate).toHaveBeenCalledTimes(1);
    expect(db.oAuthCodeUpdateMany).toHaveBeenCalledTimes(2);
  });

  it("issues no token when the conditional update matches no row", async () => {
    // The code was consumed by another request between the read and the write.
    db.oAuthCodeUpdateMany.mockResolvedValue({ count: 0 });

    const res = await POST(validGrant());

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid_grant" });
    expect(db.apiTokenCreate).not.toHaveBeenCalled();
  });
});
