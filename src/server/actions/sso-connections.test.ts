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

vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: access.getWorkspaceAccess };
});
vi.mock("@/lib/db", () => ({ prisma: { ssoConnection: db } }));
vi.mock("@/lib/activity", () => activity);

import {
  createSsoConnectionAction,
  deleteSsoConnectionAction,
  listSsoConnectionsAction,
  updateSsoConnectionAction,
  type SsoConnectionInput,
} from "./sso-connections";

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
