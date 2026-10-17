import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B04 — OAuth-issued tokens must carry an explicit grant.
 *
 * The token endpoint minted an `ApiToken` row without scopes at all
 * (`scopes: []`), so the grant was "whatever the API does not check". The
 * endpoint now stores a fixed, explicit scope list on the row and echoes the
 * granted set in the response (the response used to hardcode
 * `scope: "read write"`).
 *
 * The OAuth flow negotiates no scopes yet — the consent screen has no picker
 * and the app row stores none — so the grant is fixed rather than derived.
 * It covers the read and write scope of every resource in the catalogue and
 * deliberately excludes `admin:workspace`, which the endpoint never
 * advertised.
 */

const db = vi.hoisted(() => ({
  oAuthAppFindUnique: vi.fn(),
  oAuthCodeFindUnique: vi.fn(),
  oAuthCodeUpdate: vi.fn(),
  apiTokenCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    oAuthApp: { findUnique: db.oAuthAppFindUnique },
    oAuthCode: { findUnique: db.oAuthCodeFindUnique, update: db.oAuthCodeUpdate },
    apiToken: { create: db.apiTokenCreate },
  },
}));
vi.mock("@/lib/api-guard", () => ({ rateLimit: vi.fn(() => null) }));

import { API_SCOPE_IDS, hasScope } from "@/lib/api-token-scope";
import { POST } from "./route";

const CLIENT_ID = "noema_client";
const CLIENT_SECRET = "client-secret";
const REDIRECT_URI = "http://localhost:9999/callback";

const exchangeForm = () => {
  const form = new FormData();
  form.append("grant_type", "authorization_code");
  form.append("code", "code-1");
  form.append("client_id", CLIENT_ID);
  form.append("client_secret", CLIENT_SECRET);
  form.append("redirect_uri", REDIRECT_URI);
  return form;
};

const exchange = () =>
  POST(
    new Request("http://localhost/oauth/token", { method: "POST", body: exchangeForm() }),
  );

/** The scope list the endpoint stored on the minted token. */
const storedScopes = (): string[] => {
  const call = db.apiTokenCreate.mock.calls[0];
  if (!call) throw new Error("no token was created");
  return (call[0].data as { scopes: string[] }).scopes;
};

beforeEach(() => {
  vi.clearAllMocks();
  db.oAuthAppFindUnique.mockResolvedValue({
    id: "app-1",
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    name: "Demo app",
    redirectUris: [REDIRECT_URI],
  });
  db.oAuthCodeFindUnique.mockResolvedValue({
    id: "code-1",
    code: "code-1",
    clientId: CLIENT_ID,
    userId: "user-1",
    redirectUri: REDIRECT_URI,
    expiresAt: new Date(Date.now() + 60_000),
    used: false,
    codeChallenge: null,
    codeChallengeMethod: null,
  });
  db.oAuthCodeUpdate.mockResolvedValue({ id: "code-1" });
  db.apiTokenCreate.mockResolvedValue({ id: "token-1" });
});

describe("POST /oauth/token", () => {
  it("stores an explicit scope list on the minted token", async () => {
    const response = await exchange();

    expect(response.status).toBe(200);
    const scopes = storedScopes();
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes).toContain("read:pages");
    expect(scopes).toContain("write:pages");
  });

  it("grants only scopes from the catalogue", async () => {
    await exchange();

    for (const scope of storedScopes()) {
      expect(API_SCOPE_IDS).toContain(scope);
    }
  });

  it("does not grant the workspace-admin scope", async () => {
    await exchange();

    expect(storedScopes()).not.toContain("admin:workspace");
  });

  it("grants a scope the REST API actually enforces", async () => {
    await exchange();

    const scopes = storedScopes();
    expect(hasScope(scopes, "read:pages")).toBe(true);
    expect(hasScope(scopes, "write:pages")).toBe(true);
  });

  it("echoes the granted set in the response", async () => {
    const response = await exchange();
    const body = (await response.json()) as { scope: string };

    expect(body.scope).toBe(storedScopes().join(" "));
    expect(body.scope.split(" ")).toContain("read:pages");
  });

  it("still refuses an unknown client without minting a token", async () => {
    db.oAuthAppFindUnique.mockResolvedValue(null);

    const response = await exchange();

    expect(response.status).toBe(401);
    expect(db.apiTokenCreate).not.toHaveBeenCalled();
  });
});
