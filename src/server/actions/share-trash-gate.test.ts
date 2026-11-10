import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P2-T08 — a trashed page must not be publishable, and a page's public link
 * must die when the page goes to trash.
 *
 * Before this gate, `createShareLinkAction`'s page select omitted `deletedAt`,
 * so a trashed page could be published straight from the trash — and a link
 * that predated an archive silently revived when the page was restored, with
 * no re-share on the creator's side. The archive side now revokes page-level
 * links (`viewId: null`) in the same transaction as the `deletedAt` write;
 * `restorePageAction` needs no reshare logic because the link is already gone
 * at archive time.
 *
 * Secrets-cache note: the share-unlock surfaces are stateless with respect to
 * a deleted link — `compareSharePassword` looks the token up in the DB (no row
 * → `false`, fail closed) and the unlock cookie is an HMAC over the token that
 * is only trusted after the `/s/<token>` route finds the link. That matches
 * `revokeShareLinkAction`, which invalidates nothing beyond the row itself, so
 * `archivePageAction` mirrors it: delete rows, no cache to stale.
 */

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  pageFindMany: vi.fn(),
  pageUpdateMany: vi.fn(),
  pageUpdate: vi.fn(),
  linkFindFirst: vi.fn(),
  linkFindUnique: vi.fn(),
  linkCreate: vi.fn(),
  linkUpdate: vi.fn(),
  linkDeleteMany: vi.fn(),
  transaction: vi.fn(),
}));
const auth = vi.hoisted(() => ({
  requireUser: vi.fn(),
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
}));
const perm = vi.hoisted(() => ({
  getWorkspaceAccess: vi.fn(),
  canPerformWorkspaceAction: vi.fn(),
  canEditContent: vi.fn(),
}));
const access = vi.hoisted(() => ({ pageCapabilitiesFromRelation: vi.fn() }));
const activity = vi.hoisted(() => ({ logActivity: vi.fn() }));
const slugs = vi.hoisted(() => ({ randomToken: vi.fn() }));
const shortLink = vi.hoisted(() => ({ generateShortCode: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: {
      findUnique: db.pageFindUnique,
      findMany: db.pageFindMany,
      update: db.pageUpdate,
      updateMany: db.pageUpdateMany,
    },
    shareLink: {
      findFirst: db.linkFindFirst,
      findUnique: db.linkFindUnique,
      create: db.linkCreate,
      update: db.linkUpdate,
      deleteMany: db.linkDeleteMany,
    },
    $transaction: db.transaction,
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
  canEditContent: perm.canEditContent,
}));
vi.mock("@/lib/page-access", () => ({
  pageCapabilitiesFromRelation: access.pageCapabilitiesFromRelation,
}));
vi.mock("@/lib/activity", () => ({ logActivity: activity.logActivity }));
vi.mock("@/lib/slug", () => ({ randomToken: slugs.randomToken }));
vi.mock("@/lib/short-link", () => ({ generateShortCode: shortLink.generateShortCode }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: vi.fn() }));
vi.mock("@/server/actions/notifications", () => ({ notifyPageUpdated: vi.fn() }));
vi.mock("@/lib/guest-access", () => ({ pageScopeFor: vi.fn().mockReturnValue(null) }));
vi.mock("@/lib/search", () => ({ pageSearchText: vi.fn((s = "") => s) }));
vi.mock("@/lib/validation", () => ({ parsePageContent: vi.fn((c) => ({ text: c ?? "" })) }));
vi.mock("@/lib/page-parent", () => ({ assertEditableParent: vi.fn() }));
vi.mock("@/lib/page-project", () => ({ assertScopedProject: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/database-lock", () => ({ canEditSchema: vi.fn().mockReturnValue(true) }));
vi.mock("@/lib/blocks", () => ({ prosemirrorToText: vi.fn(() => "") }));
vi.mock("@/lib/storage", () => ({
  storageDriver: vi.fn(() => ({ purge: vi.fn(), delete: vi.fn() })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  archivePageAction,
  restorePageAction,
} from "./pages";
import { attemptShareUnlock, createShareLinkAction } from "./share";

const NOW = new Date("2026-10-27T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUser.mockResolvedValue({ id: "user-1" });
  perm.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
  perm.canPerformWorkspaceAction.mockReturnValue(true);
  perm.canEditContent.mockReturnValue(true);
  access.pageCapabilitiesFromRelation.mockReturnValue({ share: true, edit: true });
  slugs.randomToken.mockReturnValue("tok-live-1");
  db.pageFindMany.mockResolvedValue([{ id: "p-1", parentId: null }]);
  db.pageUpdateMany.mockResolvedValue({ count: 1 });
  db.pageUpdate.mockResolvedValue({});
  db.linkFindFirst.mockResolvedValue(null);
  db.linkCreate.mockResolvedValue({ token: "tok-live-1" });
  db.linkDeleteMany.mockResolvedValue({ count: 1 });
  // Array-form $transaction: run every pre-built operation in order, exactly
  // as Prisma does, so the mocks' call order reflects the transaction body.
  db.transaction.mockImplementation(async (ops: Array<Promise<unknown>>) => {
    for (const op of ops) await op;
  });
});

describe("createShareLinkAction trash gate (P2-T08)", () => {
  it("refuses to publish a trashed page and mints nothing", async () => {
    db.pageFindUnique.mockResolvedValue({
      id: "p-1",
      workspaceId: "ws-1",
      deletedAt: NOW,
      permissions: [],
    });

    await expect(createShareLinkAction("p-1")).resolves.toEqual({
      error: "Page not found.",
    });
    // No link row is read, updated or created — and the short-code stamp is
    // not applied to a page the caller cannot publish in this state.
    expect(db.linkFindFirst).not.toHaveBeenCalled();
    expect(db.linkUpdate).not.toHaveBeenCalled();
    expect(db.linkCreate).not.toHaveBeenCalled();
    expect(db.pageUpdateMany).not.toHaveBeenCalled();
  });

  it("still publishes a live page (the gate keys on deletedAt alone)", async () => {
    db.pageFindUnique.mockResolvedValue({
      id: "p-1",
      workspaceId: "ws-1",
      deletedAt: null,
      permissions: [],
    });

    await expect(createShareLinkAction("p-1")).resolves.toEqual({
      url: "/s/tok-live-1",
    });
    const arg = db.linkCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data).toMatchObject({ pageId: "p-1", token: "tok-live-1" });
    // The create never sets a view — Prisma's default makes it page-level.
    expect(arg.data.viewId ?? null).toBe(null);
  });

  it("applies the same gate on the update path of an existing link", async () => {
    // A live link predating an archive could otherwise be refreshed while the
    // page sits in the trash.
    db.pageFindUnique.mockResolvedValue({
      id: "p-1",
      workspaceId: "ws-1",
      deletedAt: NOW,
      permissions: [],
    });
    db.linkFindFirst.mockResolvedValue({ id: "link-1", token: "tok-old" });

    await expect(createShareLinkAction("p-1")).resolves.toEqual({
      error: "Page not found.",
    });
    expect(db.linkFindFirst).not.toHaveBeenCalled();
    expect(db.linkUpdate).not.toHaveBeenCalled();
  });
});

describe("archivePageAction link revoke (P2-T08)", () => {
  it("deletes the page-level link in the same transaction as the trash write", async () => {
    db.pageFindUnique.mockResolvedValue({
      id: "p-1",
      workspaceId: "ws-1",
      parentId: null,
      deletedAt: null,
      parent: null,
      permissions: [],
    });

    await expect(archivePageAction("p-1")).resolves.toEqual({ ok: true });

    // The $transaction wrapper caps Prisma's array form: both writes ran
    // inside it, trash first, revoke second.
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.pageUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["p-1"] }, workspaceId: "ws-1", deletedAt: null },
      data: { deletedAt: expect.any(Date), isArchived: true },
    });
    expect(db.linkDeleteMany).toHaveBeenCalledWith({
      where: { pageId: { in: ["p-1"] }, viewId: null },
    });
    expect(db.pageUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      db.linkDeleteMany.mock.invocationCallOrder[0],
    );
    expect(db.linkDeleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      db.transaction.mock.invocationCallOrder[0],
    );
  });

  it("revokes every page-level link in the trashed subtree, root included", async () => {
    db.pageFindUnique.mockResolvedValue({
      id: "p-1",
      workspaceId: "ws-1",
      parentId: null,
      deletedAt: null,
      parent: null,
      permissions: [],
    });
    db.pageFindMany.mockResolvedValue([
      { id: "p-1", parentId: null },
      { id: "p-2", parentId: "p-1" },
    ]);

    await expect(archivePageAction("p-1")).resolves.toEqual({ ok: true });
    expect(db.linkDeleteMany).toHaveBeenCalledWith({
      where: { pageId: { in: ["p-1", "p-2"] }, viewId: null },
    });
  });

  it("leaves form links (viewId set) untouched", async () => {
    db.pageFindUnique.mockResolvedValue({
      id: "p-1",
      workspaceId: "ws-1",
      parentId: null,
      deletedAt: null,
      parent: null,
      permissions: [],
    });

    await expect(archivePageAction("p-1")).resolves.toEqual({ ok: true });
    const { where } = db.linkDeleteMany.mock.calls[0][0];
    // `viewId: null` excludes form links — they are their own publish surface,
    // gated by the form endpoints and revoked per view.
    expect(where).toEqual({ pageId: { in: ["p-1"] }, viewId: null });
  });
});

describe("restorePageAction stays link-free (P2-T08)", () => {
  it("restores without minting or reviving any share link", async () => {
    db.pageFindUnique.mockResolvedValue({
      id: "p-1",
      workspaceId: "ws-1",
      parentId: null,
      deletedAt: NOW,
      parent: null,
      permissions: [],
    });

    await expect(restorePageAction("p-1")).resolves.toEqual({ ok: true });

    expect(db.pageUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["p-1"] }, workspaceId: "ws-1" },
      data: { deletedAt: null, isArchived: false },
    });
    expect(db.linkCreate).not.toHaveBeenCalled();
    expect(db.linkUpdate).not.toHaveBeenCalled();
    expect(db.linkDeleteMany).not.toHaveBeenCalled();
  });
});

describe("deleted share links fail closed on the unlock surface", () => {
  it("a revoked token accepts no password and unlocks nothing", async () => {
    // The secrets-cache obligation: archive deletes the row, and every
    // password comparison for the now-dead token short-circuits to `false`
    // (no row → no hash → fail closed), so no stale in-memory state can
    // grant access to a trashed page.
    db.linkFindUnique.mockResolvedValue(null);

    await expect(attemptShareUnlock("tok-live-1", "anything")).resolves.toEqual({
      status: "wrong-password",
    });
    expect(db.linkFindUnique).toHaveBeenCalledWith({
      where: { token: "tok-live-1" },
      select: { passwordHash: true },
    });
  });
});
