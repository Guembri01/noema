import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

/**
 * `src/app/oauth/authorize/complete/route.ts` — the authorization code handed
 * to the client must be stored as a digest.
 *
 * The code in the redirect URL is the plaintext; the row keeps only its
 * SHA-256 digest, so a database dump holds no redeemable code. The assertion
 * is the round trip: the code in the redirect hashes to the stored digest.
 */

const db = vi.hoisted(() => ({
  oAuthAppFindUnique: vi.fn(),
  oAuthCodeCreate: vi.fn(),
}));

const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    oAuthApp: { findUnique: db.oAuthAppFindUnique },
    oAuthCode: { create: db.oAuthCodeCreate },
  },
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: auth.getCurrentUser }));

import { POST } from "./route";

const CLIENT_ID = "noema_client123";
const REDIRECT_URI = "https://app.example.test/cb";
const APP_ORIGIN = "https://app.example.test";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function approval(
  overrides: Record<string, string> = {},
  options: { origin?: string | null; requestOrigin?: string } = {},
): Request {
  const body = new FormData();
  const fields = {
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state: "xyz",
    decision: "allow",
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  const origin = options.origin === undefined ? APP_ORIGIN : options.origin;
  return new Request(`${options.requestOrigin ?? APP_ORIGIN}/oauth/authorize/complete`, {
    method: "POST",
    body,
    ...(origin === null ? {} : { headers: { Origin: origin } }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("APP_URL", APP_ORIGIN);
  vi.stubEnv("APP_ORIGINS", "");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", undefined);
  auth.getCurrentUser.mockResolvedValue({ id: "user-1", email: "dev@example.test" });
  db.oAuthAppFindUnique.mockResolvedValue({
    id: "app-1",
    name: "Test app",
    clientId: CLIENT_ID,
    clientSecretHash: sha256("client-secret-plaintext"),
    redirectUris: [REDIRECT_URI],
    requiresPkce: false,
  });
  db.oAuthCodeCreate.mockResolvedValue({ id: "code-1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /oauth/authorize/complete", () => {
  it("stores the authorization code as a digest and hands the plaintext to the client", async () => {
    const res = await POST(approval());

    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    const code = new URL(location).searchParams.get("code") ?? "";
    expect(code).not.toBe("");
    expect(location).toContain("state=xyz");

    const data = db.oAuthCodeCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.codeHash).toBe(sha256(code));
    // The plaintext code is not stored.
    expect(data.code).toBeUndefined();
    expect(data.codeHash).not.toBe(code);
  });

  it("binds the digest to the client, the user and the redirect URI", async () => {
    await POST(approval());

    const data = db.oAuthCodeCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.clientId).toBe(CLIENT_ID);
    expect(data.userId).toBe("user-1");
    expect(data.redirectUri).toBe(REDIRECT_URI);
  });

  it("refuses a redirect URI the app did not register", async () => {
    const res = await POST(approval({ redirect_uri: "https://evil.example.test/cb" }));

    expect(res.status).toBe(400);
    expect(db.oAuthCodeCreate).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated request", async () => {
    auth.getCurrentUser.mockResolvedValue(null);

    const res = await POST(approval());

    expect(res.status).toBe(401);
    expect(db.oAuthCodeCreate).not.toHaveBeenCalled();
  });

  it("refuses a hostile sibling origin before issuing a code", async () => {
    const res = await POST(approval({}, { origin: "https://attacker.example.test" }));

    expect(res.status).toBe(403);
    expect(db.oAuthCodeCreate).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBeNull();
  });

  it("refuses a missing Origin before issuing a code", async () => {
    const res = await POST(approval({}, { origin: null }));

    expect(res.status).toBe(403);
    expect(db.oAuthCodeCreate).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBeNull();
  });

  it("refuses a malformed Origin before issuing a code", async () => {
    const res = await POST(approval({}, { origin: "not an origin" }));

    expect(res.status).toBe(403);
    expect(db.oAuthCodeCreate).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBeNull();
  });

  it("does not let an attacker-controlled Host establish a trusted origin", async () => {
    const attackerOrigin = "https://attacker.example.test";
    const res = await POST(
      approval({}, { origin: attackerOrigin, requestOrigin: attackerOrigin }),
    );

    expect(res.status).toBe(403);
    expect(db.oAuthCodeCreate).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBeNull();
  });

  it("accepts the configured APP_ORIGINS when the public origin is a proxy", async () => {
    vi.stubEnv("APP_URL", undefined);
    vi.stubEnv("APP_ORIGINS", APP_ORIGIN);

    const res = await POST(approval());

    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("code")).not.toBeNull();
    expect(db.oAuthCodeCreate).toHaveBeenCalledOnce();
  });

  it("does not treat an explicitly configured HTTPS APP_ORIGINS entry as HTTP", async () => {
    vi.stubEnv("APP_URL", undefined);
    vi.stubEnv("APP_ORIGINS", APP_ORIGIN);

    const res = await POST(approval({}, { origin: "http://app.example.test" }));

    expect(res.status).toBe(403);
    expect(db.oAuthCodeCreate).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBeNull();
  });
});
