import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
const access = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn() }));
const dns = vi.hoisted(() => ({ resolveTxt: vi.fn() }));
const db = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  connectionFindFirst: vi.fn(),
}));
const activity = vi.hoisted(() => ({ logActivity: vi.fn() }));

vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: access.getWorkspaceAccess };
});
vi.mock("@/lib/db", () => ({
  prisma: { verifiedDomain: db, ssoConnection: { findFirst: db.connectionFindFirst } },
}));
vi.mock("@/lib/activity", () => activity);
vi.mock("node:dns/promises", () => ({ resolveTxt: dns.resolveTxt }));

import {
  addVerifiedDomainAction,
  deleteVerifiedDomainAction,
  listVerifiedDomainsAction,
  verifyVerifiedDomainAction,
} from "./verified-domains";

const ROW = {
  id: "d1",
  domain: "acme.com",
  verifyToken: "token-1",
  verifiedAt: null,
  connectionId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUser.mockResolvedValue({ id: "user-1" });
  access.getWorkspaceAccess.mockResolvedValue({ role: "ADMIN" });
  db.findMany.mockResolvedValue([]);
  db.findUnique.mockResolvedValue(null);
  db.create.mockResolvedValue(ROW);
  db.update.mockResolvedValue({ ...ROW, verifiedAt: new Date("2026-01-01T00:00:00Z") });
  db.delete.mockResolvedValue({ id: "d1" });
  db.connectionFindFirst.mockResolvedValue({ id: "conn-1" });
  dns.resolveTxt.mockResolvedValue([["token-1"]]);
});

describe("verified domains", () => {
  it("lists rows with the TXT name and token", async () => {
    db.findMany.mockResolvedValue([ROW]);
    await expect(listVerifiedDomainsAction("ws-1")).resolves.toMatchObject({
      ok: true,
      domains: [
        {
          domain: "acme.com",
          recordName: "_noema-verification.acme.com",
          verifyToken: "token-1",
          verifiedAt: null,
        },
      ],
    });
  });

  it("adds a normalised pending domain and is idempotent", async () => {
    await expect(addVerifiedDomainAction("ws-1", "Acme.COM")).resolves.toMatchObject({
      ok: true,
      domain: { domain: "acme.com" },
    });
    expect(db.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws-1",
        domain: "acme.com",
        verifyToken: expect.any(String),
      }),
      select: expect.any(Object),
    });

    db.findUnique.mockResolvedValue(ROW);
    await addVerifiedDomainAction("ws-1", "acme.com");
    expect(db.create).toHaveBeenCalledTimes(1);
  });

  it("refuses invalid domains, non-admins and a foreign connection", async () => {
    await expect(addVerifiedDomainAction("ws-1", "localhost")).resolves.toEqual({
      error: "Enter a valid domain such as acme.com.",
    });
    access.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
    await expect(addVerifiedDomainAction("ws-1", "acme.com")).resolves.toEqual({
      error: "You do not have permission to manage verified domains.",
    });
    access.getWorkspaceAccess.mockResolvedValue({ role: "ADMIN" });
    db.connectionFindFirst.mockResolvedValue(null);
    await expect(addVerifiedDomainAction("ws-1", "acme.com", "conn-x")).resolves.toEqual({
      error: "That SAML connection does not exist in this workspace.",
    });
  });

  it("verifies only when DNS returns the stored token", async () => {
    db.findUnique.mockResolvedValue(ROW);
    await expect(verifyVerifiedDomainAction("ws-1", "acme.com")).resolves.toMatchObject({
      ok: true,
      domain: { verifiedAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(dns.resolveTxt).toHaveBeenCalledWith("_noema-verification.acme.com");
    expect(activity.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: "sso.domain_verified" }),
    );

    dns.resolveTxt.mockResolvedValue([["wrong"]]);
    await expect(verifyVerifiedDomainAction("ws-1", "acme.com")).resolves.toEqual({
      error: "The verification TXT record does not contain the expected token.",
    });
    dns.resolveTxt.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(verifyVerifiedDomainAction("ws-1", "acme.com")).resolves.toEqual({
      error: "The verification TXT record was not found.",
    });
  });

  it("deletes a domain and audits it", async () => {
    db.findUnique.mockResolvedValue({ id: "d1" });
    await expect(deleteVerifiedDomainAction("ws-1", "acme.com")).resolves.toEqual({ ok: true });
    expect(db.delete).toHaveBeenCalledWith({ where: { id: "d1" } });
    expect(activity.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: "sso.domain_deleted" }),
    );
  });
});
