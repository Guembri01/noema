import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SAML route wiring: start, metadata, ACS provisioning/replay and SLO.
 *
 * `@node-saml/node-saml` itself is exercised against a real signed fixture in
 * `src/lib/sso/saml.test.ts`; here the client is a fake so the route's
 * authorization, cookie and account-linking decisions are the subject.
 */

const prismaMock = vi.hoisted(() => ({
  user: { findMany: vi.fn(), create: vi.fn() },
  workspaceMember: { findUnique: vi.fn(), upsert: vi.fn() },
  ssoConnection: { findUnique: vi.fn() },
  samlAssertionSeen: { deleteMany: vi.fn(), create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const authMock = vi.hoisted(() => ({
  createSession: vi.fn(async () => undefined),
  destroySession: vi.fn(async () => undefined),
}));
vi.mock("@/lib/auth", () => authMock);

const samlClientMock = vi.hoisted(() => ({
  createSamlClient: vi.fn(),
  samlMetadata: vi.fn(() => "<EntityDescriptor/>"),
}));
vi.mock("@/lib/sso/saml-client", () => samlClientMock);

import { GET as samlStart } from "./start/route";
import { POST as samlAcs } from "./acs/route";
import { GET as samlMetadataRoute } from "./metadata/route";
import { GET as samlSlo } from "./slo/route";
import { createSamlRelayState, readSamlRelayState } from "@/lib/sso/saml-relay";

const ORIGIN = "http://localhost:3000";
const ACS = `${ORIGIN}/api/auth/saml/acs`;
const START = `${ORIGIN}/api/auth/saml/start`;

const ENV_KEYS = [
  "AUTH_SECRET",
  "AUTH_SAML_SSO_URL",
  "AUTH_SAML_ENTITY_ID",
  "AUTH_SAML_CERT",
  "AUTH_SAML_SP_ENTITY_ID",
  "AUTH_SAML_CALLBACK_URL",
  "AUTH_SAML_EMAIL_ATTRIBUTE",
  "AUTH_SAML_GROUPS_ATTRIBUTE",
  "AUTH_SAML_WORKSPACE_ID",
  "AUTH_SAML_ROLE_RULES",
  "AUTH_STRATEGIES",
] as const;
const savedEnv = new Map<string, string | undefined>();
let relayState = "";

function configureSaml(): void {
  process.env.AUTH_SAML_SSO_URL = "https://idp.example.com/sso";
  process.env.AUTH_SAML_ENTITY_ID = "https://idp.example.com/metadata";
  process.env.AUTH_SAML_CERT = "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----";
  process.env.AUTH_SAML_SP_ENTITY_ID = `${ORIGIN}/api/auth/saml/metadata`;
  process.env.AUTH_SAML_CALLBACK_URL = ACS;
  process.env.AUTH_SAML_EMAIL_ATTRIBUTE = "email";
  delete process.env.AUTH_SAML_WORKSPACE_ID;
  delete process.env.AUTH_SAML_ROLE_RULES;
  delete process.env.AUTH_STRATEGIES;
}

const client = {
  getAuthorizeUrlAsync: vi.fn(
    async (relayState: string) =>
      `https://idp.example.com/sso?SAMLRequest=request&RelayState=${encodeURIComponent(relayState)}`,
  ),
  validatePostResponseAsync: vi.fn(),
  generateServiceProviderMetadata: vi.fn(() => "<EntityDescriptor/>"),
};

function formRequest(fields: Record<string, string>, url = ACS): Request {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return new Request(url, { method: "POST", body: form });
}

function profile(email = "alice@example.com") {
  return {
    nameID: email,
    email,
    name: "Alice Example",
    groups: ["eng"],
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  process.env.AUTH_SECRET = randomBytes(32).toString("hex");
  configureSaml();
  relayState = await createSamlRelayState("/app");
  samlClientMock.createSamlClient.mockReturnValue(client);
  client.validatePostResponseAsync.mockResolvedValue({ profile: profile(), loggedOut: false });
  prismaMock.user.findMany.mockResolvedValue([]);
  prismaMock.user.create.mockResolvedValue({ id: "new-user" });
  prismaMock.workspaceMember.findUnique.mockResolvedValue(null);
  prismaMock.workspaceMember.upsert.mockResolvedValue({ id: "member-1" });
  prismaMock.ssoConnection.findUnique.mockResolvedValue(null);
  prismaMock.samlAssertionSeen.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.samlAssertionSeen.create.mockResolvedValue({ id: "seen" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("GET /api/auth/saml/start", () => {
  it("redirects to the IdP with a signed RelayState carrying the return path", async () => {
    const response = await samlStart(new Request(START));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://idp.example.com");
    const relay = location.searchParams.get("RelayState") ?? "";
    expect(relay).toBeTruthy();
    expect(await readSamlRelayState(relay)).toEqual({ returnTo: "/app" });
    expect(client.getAuthorizeUrlAsync).toHaveBeenCalledWith(relay, ORIGIN, {});
  });

  it("normalises an off-origin returnTo to /app", async () => {
    const response = await samlStart(
      new Request(`${START}?returnTo=${encodeURIComponent("https://evil.example")}`),
    );
    const relay =
      new URL(response.headers.get("location") ?? "").searchParams.get("RelayState") ?? "";
    expect(await readSamlRelayState(relay)).toEqual({ returnTo: "/app" });
  });

  it("fails closed when SAML is not configured or the allow-list excludes it", async () => {
    delete process.env.AUTH_SAML_SSO_URL;
    const unconfigured = await samlStart(new Request(START));
    expect(unconfigured.status).toBe(404);

    configureSaml();
    process.env.AUTH_STRATEGIES = "password";
    const disabled = await samlStart(new Request(START));
    expect(disabled.status).toBe(404);
    expect(disabled.headers.get("location")).toBeNull();
  });
});

const CONNECTION = {
  id: "connection-1",
  workspaceId: "ws-1",
  name: "Acme Okta",
  protocol: "saml",
  idpEntityId: "https://idp.example.com/metadata",
  ssoUrl: "https://idp.example.com/sso",
  certificate: "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----",
  spEntityId: null,
  callbackUrl: null,
  emailAttribute: "email",
  nameAttribute: null,
  groupsAttribute: null,
  roleRules: [{ group: "eng", role: "ADMIN" }],
  enabled: true,
};

describe("per-workspace SAML connections", () => {
  it("starts and settles a connection login without the env connection", async () => {
    prismaMock.ssoConnection.findUnique.mockResolvedValue(CONNECTION);
    delete process.env.AUTH_SAML_SSO_URL;

    const start = await samlStart(new Request(`${START}?connection=connection-1`));
    expect(start.status).toBe(307);
    const relay =
      new URL(start.headers.get("location") ?? "").searchParams.get("RelayState") ?? "";
    expect(await readSamlRelayState(relay)).toEqual({
      returnTo: "/app",
      connectionId: "connection-1",
    });

    prismaMock.workspaceMember.findUnique.mockResolvedValue(null);
    const response = await samlAcs(
      formRequest({ SAMLResponse: "signed-response", RelayState: relay }),
    );
    expect(response.status).toBe(307);
    expect(prismaMock.ssoConnection.findUnique).toHaveBeenCalledWith({
      where: { id: "connection-1" },
    });
    expect(prismaMock.workspaceMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_userId: { workspaceId: "ws-1", userId: "new-user" } },
        create: expect.objectContaining({ role: "ADMIN" }),
      }),
    );
  });

  it("404s for an unknown connection and rejects a disabled one", async () => {
    const unknown = await samlStart(new Request(`${START}?connection=missing`));
    expect(unknown.status).toBe(404);

    prismaMock.ssoConnection.findUnique.mockResolvedValue({
      ...CONNECTION,
      enabled: false,
    });
    const disabled = await samlStart(new Request(`${START}?connection=connection-1`));
    expect(disabled.status).toBe(404);
  });
});

describe("GET /api/auth/saml/metadata", () => {
  it("returns SP metadata XML", async () => {
    const response = await samlMetadataRoute(new Request(`${ORIGIN}/api/auth/saml/metadata`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/samlmetadata+xml");
    expect(await response.text()).toContain("EntityDescriptor");
    expect(samlClientMock.samlMetadata).toHaveBeenCalled();
  });

  it("404s when SAML is not configured", async () => {
    delete process.env.AUTH_SAML_ENTITY_ID;
    const response = await samlMetadataRoute(new Request(`${ORIGIN}/api/auth/saml/metadata`));
    expect(response.status).toBe(404);
  });

  it("serves metadata for a workspace connection", async () => {
    prismaMock.ssoConnection.findUnique.mockResolvedValue(CONNECTION);
    const response = await samlMetadataRoute(
      new Request(`${ORIGIN}/api/auth/saml/metadata?connection=connection-1`),
    );
    expect(response.status).toBe(200);
    expect(samlClientMock.samlMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1" }),
    );
  });
});

describe("POST /api/auth/saml/acs", () => {
  it("links a verified existing account and clears the hand-off cookies", async () => {
    prismaMock.user.findMany.mockResolvedValue([
      { id: "user-1", email: "alice@example.com", emailVerified: true },
    ]);

    const response = await samlAcs(
      formRequest({ SAMLResponse: "signed-response", RelayState: relayState }),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/app`);
    expect(prismaMock.user.create).not.toHaveBeenCalled();
    expect(authMock.createSession).toHaveBeenCalledWith("user-1");
  });

  it("JIT-creates an account when the signed email is new", async () => {
    const response = await samlAcs(
      formRequest({ SAMLResponse: "signed-response", RelayState: relayState }),
    );
    expect(response.status).toBe(307);
    expect(prismaMock.user.create).toHaveBeenCalledWith({
      data: {
        email: "alice@example.com",
        name: "Alice Example",
        passwordHash: expect.stringMatching(/^sso:/),
        emailVerified: true,
      },
      select: { id: true },
    });
    expect(authMock.createSession).toHaveBeenCalledWith("new-user");
  });

  it("never links an existing account that has not proved its address", async () => {
    prismaMock.user.findMany.mockResolvedValue([
      { id: "user-1", email: "alice@example.com", emailVerified: false },
    ]);
    const response = await samlAcs(
      formRequest({ SAMLResponse: "signed-response", RelayState: relayState }),
    );
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=sso_email_taken`);
    expect(authMock.createSession).not.toHaveBeenCalled();
  });

  it("rejects a wrong RelayState, invalid assertion and missing email", async () => {
    const wrongState = await samlAcs(
      formRequest({ SAMLResponse: "signed-response", RelayState: "other" }),
    );
    expect(wrongState.headers.get("location")).toBe(`${ORIGIN}/login?error=sso`);
    expect(client.validatePostResponseAsync).not.toHaveBeenCalled();

    client.validatePostResponseAsync.mockRejectedValueOnce(new Error("Invalid signature"));
    const invalid = await samlAcs(
      formRequest({ SAMLResponse: "tampered", RelayState: relayState }),
    );
    expect(invalid.headers.get("location")).toBe(`${ORIGIN}/login?error=sso`);

    client.validatePostResponseAsync.mockResolvedValueOnce({
      profile: { nameID: "not-an-email" },
      loggedOut: false,
    });
    const missingEmail = await samlAcs(
      formRequest({ SAMLResponse: "signed-response", RelayState: relayState }),
    );
    expect(missingEmail.headers.get("location")).toBe(`${ORIGIN}/login?error=sso`);
  });

  it("rejects a byte-for-byte replay before a second session is issued", async () => {
    prismaMock.samlAssertionSeen.create
      .mockResolvedValueOnce({ id: "seen" })
      .mockRejectedValueOnce(Object.assign(new Error("duplicate"), { code: "P2002" }));

    const first = await samlAcs(
      formRequest({ SAMLResponse: "signed-response", RelayState: relayState }),
    );
    expect(first.headers.get("location")).toBe(`${ORIGIN}/app`);
    expect(authMock.createSession).toHaveBeenCalledTimes(1);

    const replay = await samlAcs(
      formRequest({ SAMLResponse: "signed-response", RelayState: relayState }),
    );
    expect(replay.headers.get("location")).toBe(`${ORIGIN}/login?error=sso`);
    expect(authMock.createSession).toHaveBeenCalledTimes(1);
  });

  it("honours the signed same-origin return path", async () => {
    relayState = await createSamlRelayState("/w/acme/settings");
    const response = await samlAcs(
      formRequest({ SAMLResponse: "signed-response", RelayState: relayState }),
    );
    expect(response.headers.get("location")).toBe(`${ORIGIN}/w/acme/settings`);
  });

  it("rejects a tampered RelayState", async () => {
    const [header, payload, signature] = relayState.split(".");
    const flipped = `${signature.slice(0, 4)}${signature[4] === "a" ? "b" : "a"}${signature.slice(5)}`;
    const tampered = `${header}.${payload}.${flipped}`;
    const response = await samlAcs(
      formRequest({ SAMLResponse: "signed-response", RelayState: tampered }),
    );
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=sso`);
    expect(client.validatePostResponseAsync).not.toHaveBeenCalled();
  });
});

describe("SAML directory auto-join", () => {
  it("adds a mapped MEMBER/ADMIN to the configured workspace", async () => {
    process.env.AUTH_SAML_WORKSPACE_ID = "ws-1";
    process.env.AUTH_SAML_ROLE_RULES = "eng:ADMIN,ops:MEMBER";

    await samlAcs(formRequest({ SAMLResponse: "signed-response", RelayState: relayState }));

    expect(prismaMock.workspaceMember.upsert).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId: "ws-1", userId: "new-user" } },
      create: { workspaceId: "ws-1", userId: "new-user", role: "ADMIN" },
      update: { role: "ADMIN" },
    });
  });

  it("defaults to MEMBER and never demotes an existing OWNER", async () => {
    process.env.AUTH_SAML_WORKSPACE_ID = "ws-1";
    prismaMock.workspaceMember.findUnique.mockResolvedValue({ role: "OWNER" });

    await samlAcs(formRequest({ SAMLResponse: "signed-response", RelayState: relayState }));

    expect(prismaMock.workspaceMember.upsert).not.toHaveBeenCalled();
  });

  it("does not touch memberships when no workspace is configured", async () => {
    await samlAcs(formRequest({ SAMLResponse: "signed-response", RelayState: relayState }));
    expect(prismaMock.workspaceMember.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.workspaceMember.upsert).not.toHaveBeenCalled();
  });
});

describe("GET /api/auth/saml/slo", () => {
  it("destroys the local session and returns to /login", async () => {
    const response = await samlSlo(new Request(`${ORIGIN}/api/auth/saml/slo`));
    expect(authMock.destroySession).toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login`);
  });
});
