import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
const access = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn() }));
const db = vi.hoisted(() => ({
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));
const activity = vi.hoisted(() => ({ logActivity: vi.fn() }));
const guard = vi.hoisted(() => ({ safeFetchGuarded: vi.fn() }));

vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: access.getWorkspaceAccess };
});
vi.mock("@/lib/db", () => ({ prisma: { ssoConnection: db } }));
vi.mock("@/lib/activity", () => activity);
vi.mock("@/lib/feed-guard", () => guard);
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ host: "localhost:3000", "x-forwarded-proto": "https" })),
}));

import {
  createSsoConnectionAction,
  deleteSsoConnectionAction,
  generateScimTokenAction,
  listSsoConnectionsAction,
  refreshSsoConnectionMetadataAction,
  revokeScimTokenAction,
  testSsoConnectionAction,
  updateSsoConnectionAction,
  type SsoConnectionInput,
} from "./sso-connections";

const metadataXml = `<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example.com/new-metadata"><IDPSSODescriptor><KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${Buffer.from("new-cert").toString("base64")}</X509Certificate></X509Data></KeyInfo></KeyDescriptor><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/new-sso"/></IDPSSODescriptor></EntityDescriptor>`;

const INPUT: SsoConnectionInput = {
  name: "Acme Okta",
  idpEntityId: "https://idp.example.com/metadata",
  ssoUrl: "https://idp.example.com/sso",
  certificate: "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----",
  emailAttribute: "email",
  roleRules: "eng:ADMIN",
};

/** A real self-signed test certificate (CN=noema-test-idp) so X509 parsing runs. */
const CERT_BASE64 =
  "MIIDKDCCAhCgAwIBAgIQMGT0HvlPoZRAxt9z7wRYcTANBgkqhkiG9w0BAQsFADAZMRcwFQYDVQQDDA5ub2VtYS10ZXN0LWlkcDAeFw0xOTEyMzEyMjAwMDBaFw0zOTEyMzEyMjAwMDBaMBkxFzAVBgNVBAMMDm5vZW1hLXRlc3QtaWRwMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvpeo+jeVRoAGIzb9CgpLUEWb25pBQ8kWe9IyH6jxzYcGk4Xl74fICQfYYNF11vTTO0i8rZ8WieI36fxOyF5WWnbojB4IrPuaFHzqCh9VUsnURXDmXmBgb8nTLixb8auL7FFZPmWsTcvQl080m8zw84HyFRQak1aPY1nn+YGJLjLfDx6CNmMvxRrtNt3AoueJBjpEfRp1UDTtdukvTc4fhLJ16f5Fe7EhqfWloAoCD5mFB/Uj7NgQnBUU7P5SAkYKSYtzw8EJX7fRwCeprbOycDnfSmn2lX5XKp2s1rQwjqZK8EW37UaV31mRyviSziRF8T8V/qpkUE/EzkfnanFNrQIDAQABo2wwajAOBgNVHQ8BAf8EBAMCBaAwHQYDVR0lBBYwFAYIKwYBBQUHAwIGCCsGAQUFBwMBMBoGA1UdEQQTMBGCD2lkcC5leGFtcGxlLmNvbTAdBgNVHQ4EFgQUpcF16JACCSCLQqcBGZ9mvzKWhF4wDQYJKoZIhvcNAQELBQADggEBAKjTcfUld5sKWTQPMImZefNE0Rg9P4fvjWjKbWBDeGzbDbZBucFoyRst9OYVI/KvliMBLPZFwF1v40K3E6n+vGfmLDE5hwWN1o/XWZxeDnVXy4XH/2W9RLs+mUsCdV5xOZYlIK5+OkwBHgxZeapRrf6xEMTsSiuvmX32CyY5J4K1I7Z5gqdKt3Pb0/rdn6Gnh2rtJOaeGNVOTX2Q5lpixLiazAEURM8+l2GdQcI4adPHbU7KBJ4CtgYkUedOubKS6ptLzmfHknqSTgMiHkdhLMyelEHdJlQ55YY6Msnq5n6ncW8UCi3hNfzSM/l270xeHUghw8E2B7lp9YdqUaJynOU=";

const CERT_PEM = `-----BEGIN CERTIFICATE-----\n${(CERT_BASE64.match(/.{1,64}/g) ?? []).join("\n")}\n-----END CERTIFICATE-----`;

const CONNECTION_ROW = {
  id: "conn-1",
  protocol: "saml",
  idpEntityId: "https://idp.example.com/metadata",
  ssoUrl: "https://idp.example.com/sso",
  certificate: CERT_PEM,
  metadataUrl: null,
  spEntityId: null,
  callbackUrl: null,
  emailAttribute: "email",
  groupsAttribute: "groups",
};

function metadataWithCertificate(entityId = "https://idp.example.com/metadata", ssoUrl = "https://idp.example.com/sso"): string {
  return `<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}"><IDPSSODescriptor><KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${CERT_BASE64}</X509Certificate></X509Data></KeyInfo></KeyDescriptor><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${ssoUrl}"/></IDPSSODescriptor></EntityDescriptor>`;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUser.mockResolvedValue({ id: "user-1" });
  access.getWorkspaceAccess.mockResolvedValue({ role: "ADMIN" });
  db.findMany.mockResolvedValue([]);
  db.findFirst.mockResolvedValue({ id: "conn-1", name: "Acme Okta" });
  db.create.mockResolvedValue({ id: "conn-1" });
  db.update.mockResolvedValue({ id: "conn-1" });
  db.delete.mockResolvedValue({ id: "conn-1" });
});

describe("listSsoConnectionsAction", () => {
  it("returns the safe projection to an admin", async () => {
    db.findMany.mockResolvedValue([
      {
        id: "conn-1",
        name: "Acme Okta",
        idpEntityId: "https://idp.example.com/metadata",
        ssoUrl: "https://idp.example.com/sso",
        spEntityId: null,
        callbackUrl: null,
        emailAttribute: "email",
        nameAttribute: null,
        groupsAttribute: null,
        roleRules: [{ group: "eng", role: "ADMIN" }],
        enabled: true,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-02T00:00:00Z"),
      },
    ]);
    const result = await listSsoConnectionsAction("ws-1");
    expect(result).toMatchObject({
      ok: true,
      connections: [
        {
          id: "conn-1",
          roleRules: '[{"group":"eng","role":"ADMIN"}]',
          enabled: true,
        },
      ],
    });
  });

  it("refuses a non-admin", async () => {
    access.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
    await expect(listSsoConnectionsAction("ws-1")).resolves.toEqual({
      error: "You do not have permission to manage single sign-on.",
    });
    expect(db.findMany).not.toHaveBeenCalled();
  });
});

describe("create / update / delete", () => {
  it("creates a validated connection and logs it", async () => {
    await expect(createSsoConnectionAction("ws-1", INPUT)).resolves.toEqual({
      ok: true,
      id: "conn-1",
    });
    expect(db.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "Acme Okta",
        protocol: "saml",
        idpEntityId: "https://idp.example.com/metadata",
        emailAttribute: "email",
        roleRules: [{ group: "eng", role: "ADMIN" }],
        enabled: true,
        workspace: { connect: { id: "ws-1" } },
      }),
      select: { id: true },
    });
    expect(activity.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: "sso.connection_created" }),
    );
  });

  it("rejects bad URLs, certificates and role rules", async () => {
    await expect(
      createSsoConnectionAction("ws-1", { ...INPUT, ssoUrl: "javascript:alert(1)" }),
    ).resolves.toEqual({ error: "The IdP SSO URL must be an http(s) URL." });
    await expect(
      createSsoConnectionAction("ws-1", { ...INPUT, certificate: "not-pem" }),
    ).resolves.toEqual({ error: "The IdP certificate must be PEM text." });
    await expect(
      createSsoConnectionAction("ws-1", { ...INPUT, roleRules: "eng:SUPERUSER" }),
    ).resolves.toMatchObject({ error: expect.stringContaining("unsupported role") });
    expect(db.create).not.toHaveBeenCalled();
  });

  it("updates only a connection that belongs to the workspace", async () => {
    await expect(updateSsoConnectionAction("ws-1", "conn-1", INPUT)).resolves.toEqual({
      ok: true,
    });
    expect(db.findFirst).toHaveBeenCalledWith({
      where: { id: "conn-1", workspaceId: "ws-1" },
      select: { id: true },
    });
    expect(db.update).toHaveBeenCalled();

    db.findFirst.mockResolvedValue(null);
    await expect(updateSsoConnectionAction("ws-1", "other", INPUT)).resolves.toEqual({
      error: "That SAML connection does not exist in this workspace.",
    });
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("deletes a connection and records the audit line", async () => {
    await expect(deleteSsoConnectionAction("ws-1", "conn-1")).resolves.toEqual({ ok: true });
    expect(db.delete).toHaveBeenCalledWith({ where: { id: "conn-1" } });
    expect(activity.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: "sso.connection_deleted" }),
    );
  });
});

describe("SCIM tokens", () => {
  it("returns a token once and stores only its hash", async () => {
    const result = await generateScimTokenAction("ws-1", "conn-1");
    expect(result).toMatchObject({ ok: true, token: expect.stringMatching(/^noema_scim_/) });
    expect(db.update).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: { scimEnabled: true, scimTokenHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    const stored = db.update.mock.calls[0][0].data.scimTokenHash as string;
    if (!("ok" in result)) throw new Error(result.error);
    expect(stored).not.toBe(result.token);
  });

  it("revokes the token without touching SAML", async () => {
    await expect(revokeScimTokenAction("ws-1", "conn-1")).resolves.toEqual({ ok: true });
    expect(db.update).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: { scimEnabled: false, scimTokenHash: null },
    });
  });
});

describe("metadata rotation", () => {
  it("rotates the certificate and keeps the previous one for 24 hours", async () => {
    db.findFirst.mockResolvedValue({
      id: "conn-1",
      metadataUrl: "https://idp.example.com/metadata",
      certificate: "-----BEGIN CERTIFICATE-----\nold\n-----END CERTIFICATE-----",
    });
    guard.safeFetchGuarded.mockResolvedValue({
      ok: true,
      response: new Response(metadataXml, { status: 200 }),
      finalUrl: "https://idp.example.com/metadata",
    });
    db.update.mockResolvedValue({
      id: "conn-1",
      name: "Acme Okta",
      idpEntityId: "https://idp.example.com/new-metadata",
      ssoUrl: "https://idp.example.com/new-sso",
      metadataUrl: "https://idp.example.com/metadata",
      metadataFetchedAt: new Date("2026-01-01T00:00:00Z"),
      spEntityId: null,
      callbackUrl: null,
      emailAttribute: null,
      nameAttribute: null,
      groupsAttribute: null,
      roleRules: null,
      enabled: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });

    await expect(
      refreshSsoConnectionMetadataAction("ws-1", "conn-1"),
    ).resolves.toMatchObject({ ok: true, connection: { metadataUrl: "https://idp.example.com/metadata" } });
    expect(db.update).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: expect.objectContaining({
        idpEntityId: "https://idp.example.com/new-metadata",
        ssoUrl: "https://idp.example.com/new-sso",
        certificate: expect.stringContaining("bmV3LWNlcnQ="),
        prevCertificate: expect.stringContaining("old"),
        prevCertificateExpiresAt: expect.any(Date),
      }),
      select: expect.any(Object),
    });
    expect(activity.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: "sso.metadata_refreshed", meta: expect.objectContaining({ rotated: true }) }),
    );
  });

  it("fails closed when the URL is missing, blocked or malformed", async () => {
    await expect(
      refreshSsoConnectionMetadataAction("ws-1", "conn-1"),
    ).resolves.toEqual({ error: "Set an https metadata URL on this connection first." });

    db.findFirst.mockResolvedValue({
      id: "conn-1",
      metadataUrl: "https://idp.example.com/metadata",
      certificate: "old",
    });
    guard.safeFetchGuarded.mockResolvedValue({ ok: false, reason: "blocked" });
    await expect(
      refreshSsoConnectionMetadataAction("ws-1", "conn-1"),
    ).resolves.toEqual({ error: "The metadata URL was refused by the outbound network guard." });

    guard.safeFetchGuarded.mockResolvedValue({
      ok: true,
      response: new Response("not xml", { status: 200 }),
      finalUrl: "https://idp.example.com/metadata",
    });
    await expect(
      refreshSsoConnectionMetadataAction("ws-1", "conn-1"),
    ).resolves.toEqual({ error: "The IdP metadata is not valid XML." });
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("testSsoConnectionAction", () => {
  it("fails closed for a non-admin without reading the connection", async () => {
    access.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });

    await expect(testSsoConnectionAction("ws-1", "conn-1")).resolves.toEqual({
      error: "You do not have permission to manage single sign-on.",
    });
    expect(db.findFirst).not.toHaveBeenCalled();
    expect(guard.safeFetchGuarded).not.toHaveBeenCalled();
  });

  it("rejects a connection outside the workspace and never mutates or fetches", async () => {
    db.findFirst.mockResolvedValue(null);

    await expect(testSsoConnectionAction("ws-1", "other")).resolves.toEqual({
      error: "That SAML connection does not exist in this workspace.",
    });
    expect(db.update).not.toHaveBeenCalled();
    expect(activity.logActivity).not.toHaveBeenCalled();
    expect(guard.safeFetchGuarded).not.toHaveBeenCalled();
  });

  it("passes a complete stored connection without writing anything or leaking the PEM", async () => {
    db.findFirst.mockResolvedValue(CONNECTION_ROW);

    const result = await testSsoConnectionAction("ws-1", "conn-1");

    expect(result).toMatchObject({
      ok: true,
      report: { passed: true },
    });
    if (!("ok" in result)) throw new Error(result.error);
    expect(result.report.checks.every((entry) => entry.status === "pass")).toBe(true);
    expect(
      result.report.checks.some((entry) => entry.id === "certificate" && entry.detail.includes("valid until")),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("BEGIN CERTIFICATE");
    expect(JSON.stringify(result)).not.toContain(CERT_BASE64);
    expect(db.update).not.toHaveBeenCalled();
    expect(activity.logActivity).not.toHaveBeenCalled();
    expect(guard.safeFetchGuarded).not.toHaveBeenCalled();
  });

  it("reports invalid required fields, certificate and SP consistency as failures", async () => {
    db.findFirst.mockResolvedValue({
      ...CONNECTION_ROW,
      idpEntityId: "",
      ssoUrl: "javascript:alert(1)",
      certificate: "not-a-pem",
      spEntityId: "https://sp.example.com/metadata",
      callbackUrl: "https://other.example.com/acs",
    });

    const result = await testSsoConnectionAction("ws-1", "conn-1");

    if (!("ok" in result)) throw new Error(result.error);
    expect(result.report.passed).toBe(false);
    const failed = new Set(
      result.report.checks.filter((entry) => entry.status === "fail").map((entry) => entry.id),
    );
    expect(failed).toEqual(
      new Set([
        "idp-entity-id",
        "sso-url",
        "sp-origin-consistency",
        "certificate",
      ]),
    );
    expect(db.update).not.toHaveBeenCalled();
  });

  it("fetches and validates a configured metadata URL", async () => {
    db.findFirst.mockResolvedValue({
      ...CONNECTION_ROW,
      metadataUrl: "https://idp.example.com/metadata.xml",
    });
    guard.safeFetchGuarded.mockResolvedValue({
      ok: true,
      response: new Response(metadataWithCertificate(), { status: 200 }),
      finalUrl: "https://idp.example.com/metadata.xml",
    });

    const result = await testSsoConnectionAction("ws-1", "conn-1");

    if (!("ok" in result)) throw new Error(result.error);
    expect(result.report.passed).toBe(true);
    expect(result.report.checks.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["metadata-url", "metadata-entity-id", "metadata-sso-url", "metadata-certificate"]),
    );
    expect(guard.safeFetchGuarded).toHaveBeenCalledWith(
      "https://idp.example.com/metadata.xml",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(db.update).not.toHaveBeenCalled();
  });

  it("fails the metadata check when the URL is blocked or disagrees with the stored fields", async () => {
    db.findFirst.mockResolvedValue({
      ...CONNECTION_ROW,
      metadataUrl: "https://idp.example.com/metadata.xml",
    });
    guard.safeFetchGuarded.mockResolvedValue({ ok: false, reason: "blocked" });

    const blocked = await testSsoConnectionAction("ws-1", "conn-1");
    if (!("ok" in blocked)) throw new Error(blocked.error);
    expect(blocked.report.passed).toBe(false);
    expect(
      blocked.report.checks.find((entry) => entry.id === "metadata-url"),
    ).toMatchObject({ status: "fail" });

    guard.safeFetchGuarded.mockResolvedValue({
      ok: true,
      response: new Response(
        metadataWithCertificate("https://other.example.com/metadata", "https://other.example.com/sso"),
        { status: 200 },
      ),
      finalUrl: "https://idp.example.com/metadata.xml",
    });
    const mismatched = await testSsoConnectionAction("ws-1", "conn-1");
    if (!("ok" in mismatched)) throw new Error(mismatched.error);
    expect(mismatched.report.passed).toBe(false);
    const byId = new Map(mismatched.report.checks.map((entry) => [entry.id, entry]));
    expect(byId.get("metadata-entity-id")?.status).toBe("fail");
    expect(byId.get("metadata-sso-url")?.status).toBe("fail");
    expect(db.update).not.toHaveBeenCalled();
  });
});
