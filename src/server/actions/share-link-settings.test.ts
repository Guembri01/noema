import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P3-T01 — a live share link's password and expiry had to stay forever: the
 * update branch's `??`-merge could keep or replace values but never remove
 * them, the update branch wrote no audit line (only the create logged), and
 * the dialog hid every form once the link was live. These pins cover the
 * explicit `clearPassword`/`clearExpiry` sentinels (booleans, no magic
 * strings; a replacement wins over its sentinel), the no-op skip of the audit
 * log, and the `page.share_updated` line when a change persists.
 */

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  pageUpdateMany: vi.fn(),
  linkFindFirst: vi.fn(),
  linkCreate: vi.fn(),
  linkUpdate: vi.fn(),
}));
const auth = vi.hoisted(() => ({
  requireUser: vi.fn(),
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
}));
const perm = vi.hoisted(() => ({
  getWorkspaceAccess: vi.fn(),
  canPerformWorkspaceAction: vi.fn(),
}));
const access = vi.hoisted(() => ({ pageCapabilitiesFromRelation: vi.fn() }));
const activity = vi.hoisted(() => ({ logActivity: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: db.pageFindUnique, updateMany: db.pageUpdateMany },
    shareLink: {
      findFirst: db.linkFindFirst,
      create: db.linkCreate,
      update: db.linkUpdate,
    },
  },
}));
vi.mock("@/lib/auth", () => ({
  requireUser: auth.requireUser,
  hashPassword: auth.hashPassword,
  verifyPassword: auth.verifyPassword,
}));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: perm.getWorkspaceAccess,
  canPerformWorkspaceAction: perm.canPerformWorkspaceAction,
}));
vi.mock("@/lib/page-access", () => ({
  pageCapabilitiesFromRelation: access.pageCapabilitiesFromRelation,
}));
vi.mock("@/lib/activity", () => ({ logActivity: activity.logActivity }));
vi.mock("@/lib/slug", () => ({ randomToken: vi.fn(() => "tok-new") }));
vi.mock("@/lib/short-link", () => ({
  generateShortCode: vi.fn(({ seed }) => `code-${seed}`),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createShareLinkAction } from "./share";

/** An existing live link the update branch can operate on. */
const storedLink = (overrides: Record<string, unknown> = {}) => ({
  id: "link-1",
  token: "tok-live",
  permission: "READ",
  passwordHash: "hash-stale",
  expiresAt: new Date("2026-12-01T00:00:00Z"),
  indexing: true,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUser.mockResolvedValue({ id: "user-1" });
  auth.hashPassword.mockImplementation(async (pw: string) => `hash-${pw}`);
  perm.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
  perm.canPerformWorkspaceAction.mockReturnValue(true);
  access.pageCapabilitiesFromRelation.mockReturnValue({ share: true });
  db.pageFindUnique.mockResolvedValue({
    id: "page-1",
    workspaceId: "ws-1",
    deletedAt: null,
    permissions: [],
  });
  db.pageUpdateMany.mockResolvedValue({ count: 1 });
  db.linkFindFirst.mockResolvedValue(null);
  db.linkCreate.mockResolvedValue({ token: "tok-new" });
  db.linkUpdate.mockResolvedValue({});
});

describe("clearing a set password (P3-T01)", () => {
  it("clears the explicit clearPassword sentinel to null and audits the update", async () => {
    db.linkFindFirst.mockResolvedValue(storedLink());

    await expect(
      createShareLinkAction("page-1", { clearPassword: true }),
    ).resolves.toEqual({ url: "/s/tok-live" });

    expect(db.linkUpdate).toHaveBeenCalledWith({
      where: { id: "link-1" },
      data: expect.objectContaining({ passwordHash: null }),
    });
    // The expiry must not be disturbed by a password-only patch.
    expect(db.linkUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          expiresAt: new Date("2026-12-01T00:00:00Z"),
        }),
      }),
    );
    expect(activity.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "page.share_updated",
        targetType: "page",
        targetId: "page-1",
        actorId: "user-1",
        workspaceId: "ws-1",
      }),
    );
  });

  it("keeps the password when the sentinel is explicitly false", async () => {
    db.linkFindFirst.mockResolvedValue(storedLink());

    await createShareLinkAction("page-1", { clearPassword: false });

    expect(db.linkUpdate).toHaveBeenCalledWith({
      where: { id: "link-1" },
      data: expect.objectContaining({ passwordHash: "hash-stale" }),
    });
  });
});

describe("clearing a set expiry (P3-T01)", () => {
  it("clears the explicit clearExpiry sentinel to null and audits the update", async () => {
    db.linkFindFirst.mockResolvedValue(storedLink());

    await expect(
      createShareLinkAction("page-1", { clearExpiry: true }),
    ).resolves.toEqual({ url: "/s/tok-live" });

    expect(db.linkUpdate).toHaveBeenCalledWith({
      where: { id: "link-1" },
      data: expect.objectContaining({ expiresAt: null }),
    });
    // The password must not be disturbed by an expiry-only patch.
    expect(db.linkUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ passwordHash: "hash-stale" }) }),
    );
    expect(activity.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: "page.share_updated" }),
    );
  });

  it("keeps the expiry when the sentinel is explicitly false", async () => {
    db.linkFindFirst.mockResolvedValue(storedLink());

    await createShareLinkAction("page-1", { clearExpiry: false });

    expect(db.linkUpdate).toHaveBeenCalledWith({
      where: { id: "link-1" },
      data: expect.objectContaining({
        expiresAt: new Date("2026-12-01T00:00:00Z"),
      }),
    });
  });
});

describe("sentinel precedence (P3-T01)", () => {
  it("a replacement password wins over clearPassword in the same call", async () => {
    db.linkFindFirst.mockResolvedValue(storedLink());

    await createShareLinkAction("page-1", {
      password: "fresh",
      clearPassword: true,
    });

    expect(db.linkUpdate).toHaveBeenCalledWith({
      where: { id: "link-1" },
      data: expect.objectContaining({ passwordHash: "hash-fresh" }),
    });
  });

  it("a replacement expiry wins over clearExpiry in the same call", async () => {
    db.linkFindFirst.mockResolvedValue(storedLink());

    await createShareLinkAction("page-1", {
      expiresInDays: 7,
      clearExpiry: true,
    });

    expect(db.linkUpdate).toHaveBeenCalledWith({
      where: { id: "link-1" },
      data: expect.objectContaining({
        expiresAt: expect.any(Date),
      }),
    });
  });
});

describe("no-op updates stay silent (P3-T01)", () => {
  it("an empty patch on an unchanged link persists nothing worth logging", async () => {
    db.linkFindFirst.mockResolvedValue(storedLink());

    await expect(createShareLinkAction("page-1", {})).resolves.toEqual({
      url: "/s/tok-live",
    });

    expect(db.linkUpdate).toHaveBeenCalled();
    expect(activity.logActivity).not.toHaveBeenCalled();
  });

  it("the update branch logs page.share_updated, never page.shared", async () => {
    // Sanity pin: the observed update log line is the update branch's own, not
    // the create branch's `page.shared` leaking through.
    db.linkFindFirst.mockResolvedValue(storedLink());

    await createShareLinkAction("page-1", { indexing: false });

    expect(db.linkUpdate).toHaveBeenCalled();
    expect(activity.logActivity).toHaveBeenCalledTimes(1);
    expect(activity.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: "page.share_updated" }),
    );
  });

  it("a permission change on the live link still audits even without sentinels", async () => {
    db.linkFindFirst.mockResolvedValue(storedLink({ permission: "READ" }));

    await createShareLinkAction("page-1", { allowEditing: true });

    expect(db.linkUpdate).toHaveBeenCalledWith({
      where: { id: "link-1" },
      data: expect.objectContaining({ permission: "EDIT" }),
    });
    expect(activity.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "page.share_updated",
        targetId: "page-1",
      }),
    );
  });
});
