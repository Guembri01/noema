import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SSO route wiring — the env-level OIDC connection driven by
 * `src/lib/auth-strategies.ts`.
 *
 * The routes are exercised end-to-end as Request → Response; only the
 * transport edges are mocked: `next/headers` cookies (in-memory jar),
 * `@/lib/db` (Prisma), `@/lib/auth` (the session issuer) and `jose` (id_token
 * verification). Everything else — `startLogin`, `validateCallback`,
 * `normalizeIdentity`, `linkOrCreate`, `enabledStrategies` — is the real
 * module, so these pin the wiring the live `check:sso` suite depends on.
 */

const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { name, value: jar.get(name) as string } : undefined,
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
}));

const prismaMock = vi.hoisted(() => ({
  user: {
    findMany: vi.fn(),
    create: vi.fn(),
  },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const authMock = vi.hoisted(() => ({ createSession: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth", () => ({ createSession: authMock.createSession }));

const joseMock = vi.hoisted(() => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: vi.fn(),
}));
vi.mock("jose", () => joseMock);

import { GET as ssoStart } from "./start/route";
import { GET as ssoCallback } from "./callback/route";

const DISCOVERY = {
  issuer: "http://localhost:4321",
  authorization_endpoint: "http://localhost:4321/authorize",
  token_endpoint: "http://localhost:4321/token",
  jwks_uri: "http://localhost:4321/jwks",
};

const START_URL = "http://localhost:3000/api/auth/sso/start";
const CALLBACK_URL = "http://localhost:3000/api/auth/sso/callback";

const ENV_KEYS = [
  "SSO_ISSUER",
  "SSO_CLIENT_ID",
  "SSO_CLIENT_SECRET",
  "SSO_REDIRECT_URI",
  "AUTH_STRATEGIES",
] as const;

const savedEnv = new Map<string, string | undefined>();

/** Route discovery and the token endpoint to fixed documents. */
function stubFetch(idToken: string | null = "id-token"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input.includes("/.well-known/openid-configuration")) {
        return new Response(JSON.stringify(DISCOVERY), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (input.endsWith("/token")) {
        return new Response(JSON.stringify(idToken ? { id_token: idToken } : {}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

/** Set-Cookie values across Node/undici versions. */
function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  return (response.headers.get("set-cookie") ?? "").split(/,\s*(?=[^;=]+=)/);
}

beforeEach(() => {
  vi.clearAllMocks();
  jar.clear();
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  process.env.SSO_ISSUER = "http://localhost:4321";
  process.env.SSO_CLIENT_ID = "noema";
  process.env.SSO_CLIENT_SECRET = "secret";
  delete process.env.SSO_REDIRECT_URI;
  delete process.env.AUTH_STRATEGIES;
  prismaMock.user.findMany.mockResolvedValue([]);
  prismaMock.user.create.mockResolvedValue({ id: "new-user" });
  joseMock.jwtVerify.mockResolvedValue({ payload: {} });
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("GET /api/auth/sso/start", () => {
  it("redirects to the discovered authorize endpoint and sets state + nonce cookies", async () => {
    const response = await ssoStart(new Request(START_URL));
    const location = response.headers.get("location") ?? "";

    expect(response.status).toBe(307);
    expect(location.startsWith("http://localhost:4321/authorize")).toBe(true);

    const url = new URL(location);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("noema");
    expect(url.searchParams.get("redirect_uri")).toBe(`${CALLBACK_URL}`);
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("nonce")).toBeTruthy();

    const cookies = setCookies(response);
    expect(cookies.some((cookie) => cookie.startsWith("sso_state="))).toBe(true);
    expect(cookies.some((cookie) => cookie.startsWith("sso_nonce="))).toBe(true);
  });

  it("honours SSO_REDIRECT_URI when configured", async () => {
    process.env.SSO_REDIRECT_URI = "https://app.example.com/api/auth/sso/callback";
    const response = await ssoStart(new Request(START_URL));
    const url = new URL(response.headers.get("location") ?? "");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/api/auth/sso/callback",
    );
  });

  it("refuses when the AUTH_STRATEGIES allow-list excludes OIDC", async () => {
    process.env.AUTH_STRATEGIES = "password";
    const response = await ssoStart(new Request(START_URL));
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
  });

  it("returns 404 when SSO is not configured", async () => {
    delete process.env.SSO_CLIENT_ID;
    const response = await ssoStart(new Request(START_URL));
    expect(response.status).toBe(404);
  });
});

describe("GET /api/auth/sso/callback", () => {
  beforeEach(() => {
    jar.set("sso_state", "state-1");
    jar.set("sso_nonce", "nonce-1");
  });

  it("links an existing email-matched account, clears the hand-off cookies and lands on /app", async () => {
    joseMock.jwtVerify.mockResolvedValue({
      payload: {
        sub: "sso-user-1",
        email: "sso-user@noema.local",
        name: "SSO User",
        nonce: "nonce-1",
      },
    });
    prismaMock.user.findMany.mockResolvedValue([
      { id: "user-1", email: "sso-user@noema.local", emailVerified: true },
    ]);

    const response = await ssoCallback(
      new Request(`${CALLBACK_URL}?code=code-1&state=state-1`),
    );

    expect(response.headers.get("location")).toBe("http://localhost:3000/app");
    expect(authMock.createSession).toHaveBeenCalledWith("user-1");
    expect(prismaMock.user.create).not.toHaveBeenCalled();
    expect(jar.has("sso_state")).toBe(false);
    expect(jar.has("sso_nonce")).toBe(false);
  });

  it("reads the verification flag of the candidate account", async () => {
    joseMock.jwtVerify.mockResolvedValue({
      payload: {
        sub: "sso-user-1",
        email: "sso-user@noema.local",
        name: "SSO User",
        nonce: "nonce-1",
      },
    });
    prismaMock.user.findMany.mockResolvedValue([
      { id: "user-1", email: "sso-user@noema.local", emailVerified: true },
    ]);

    await ssoCallback(new Request(`${CALLBACK_URL}?code=code-1&state=state-1`));

    expect(prismaMock.user.findMany).toHaveBeenCalledWith({
      where: { email: "sso-user@noema.local" },
      select: { id: true, email: true, emailVerified: true },
    });
  });

  it("refuses to link an account that never verified the address", async () => {
    // B07: the address may have been registered by somebody else before the
    // real owner showed up — the sign-in must not land in that account.
    joseMock.jwtVerify.mockResolvedValue({
      payload: {
        sub: "sso-user-5",
        email: "pre-registered@noema.local",
        name: "Pre Registered",
        nonce: "nonce-1",
      },
    });
    prismaMock.user.findMany.mockResolvedValue([
      { id: "user-5", email: "pre-registered@noema.local", emailVerified: false },
    ]);

    const response = await ssoCallback(
      new Request(`${CALLBACK_URL}?code=code-1&state=state-1`),
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?error=sso_email_taken",
    );
    expect(authMock.createSession).not.toHaveBeenCalled();
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it("just-in-time creates a user when no account matches", async () => {
    joseMock.jwtVerify.mockResolvedValue({
      payload: {
        sub: "sso-user-2",
        email: "new-user@noema.local",
        name: "New User",
        nonce: "nonce-1",
      },
    });
    prismaMock.user.findMany.mockResolvedValue([]);
    prismaMock.user.create.mockResolvedValue({ id: "user-2" });

    const response = await ssoCallback(
      new Request(`${CALLBACK_URL}?code=code-1&state=state-1`),
    );

    expect(response.headers.get("location")).toBe("http://localhost:3000/app");
    expect(prismaMock.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: "new-user@noema.local",
          name: "New User",
          passwordHash: expect.stringMatching(/^sso:/),
          // The provider vouched for the address.
          emailVerified: true,
        }),
      }),
    );
    expect(authMock.createSession).toHaveBeenCalledWith("user-2");
  });

  it("rejects a mismatched state before any token exchange", async () => {
    const response = await ssoCallback(
      new Request(`${CALLBACK_URL}?code=code-1&state=wrong`),
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?error=sso",
    );
    expect(authMock.createSession).not.toHaveBeenCalled();
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it("rejects an absolute returnTo instead of open-redirecting", async () => {
    const response = await ssoCallback(
      new Request(
        `${CALLBACK_URL}?code=code-1&state=state-1&returnTo=https://evil.example`,
      ),
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?error=sso",
    );
  });

  it("surfaces a provider error as a login failure", async () => {
    const response = await ssoCallback(
      new Request(`${CALLBACK_URL}?error=access_denied&state=state-1`),
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?error=sso",
    );
  });

  it("rejects an id_token whose nonce does not match the cookie", async () => {
    joseMock.jwtVerify.mockResolvedValue({
      payload: {
        sub: "sso-user-3",
        email: "user3@noema.local",
        nonce: "other-nonce",
      },
    });

    const response = await ssoCallback(
      new Request(`${CALLBACK_URL}?code=code-1&state=state-1`),
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?error=sso",
    );
    expect(authMock.createSession).not.toHaveBeenCalled();
  });

  it("fails closed when the identity carries no email", async () => {
    joseMock.jwtVerify.mockResolvedValue({ payload: { sub: "sso-user-4" } });

    const response = await ssoCallback(
      new Request(`${CALLBACK_URL}?code=code-1&state=state-1`),
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?error=sso",
    );
    expect(prismaMock.user.findMany).not.toHaveBeenCalled();
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it("returns 404 when the strategy is disabled", async () => {
    process.env.AUTH_STRATEGIES = "password";
    const response = await ssoCallback(
      new Request(`${CALLBACK_URL}?code=code-1&state=state-1`),
    );
    expect(response.status).toBe(404);
  });
});
