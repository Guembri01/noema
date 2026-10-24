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

import {
  createSsoConnectionAction,
  deleteSsoConnectionAction,
  generateScimTokenAction,
  listSsoConnectionsAction,
  refreshSsoConnectionMetadataAction,
  revokeScimTokenAction,
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
