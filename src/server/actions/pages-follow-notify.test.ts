import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R82.12 — the `updatePageAction` → `notifyPageUpdated` wiring
 * (docs/specs/notifications.md D1, docs/FEATURE_MATRIX.md "Following pages":
 * "no mutation ever consults PageFollow"). These tests run the REAL action
 * chain (updatePageAction → the real notifyPageUpdated → resolveRecipients);
 * only the transport edges (prisma/auth/permissions/webhooks/activity/cache)
 * are mocked, so the assertion is end-to-end: an update to a followed page
 * writes a notification row, and a no-op save writes none.
 */

const ACTOR = "author";
const PAGE_ID = "page-1";

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  pageUpdate: vi.fn(),
  pageVersionCreate: vi.fn(),
  pageFollowFindMany: vi.fn(),
  workspaceMemberFindMany: vi.fn(),
  userFindMany: vi.fn(),
  notificationFindMany: vi.fn(),
  notificationCreateMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: db.pageFindUnique, update: db.pageUpdate },
    pageVersion: { create: db.pageVersionCreate },
    pageFollow: { findMany: db.pageFollowFindMany },
    workspaceMember: { findMany: db.workspaceMemberFindMany },
    user: { findMany: db.userFindMany },
    notification: {
      findMany: db.notificationFindMany,
      createMany: db.notificationCreateMany,
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "author" })),
}));
vi.mock("@/lib/webhooks", () => ({
  dispatchWebhooks: vi.fn(async () => undefined),
}));
const activity = vi.hoisted(() => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("@/lib/activity", () => ({ logActivity: activity.logActivity }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const perms = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn() }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: perms.getWorkspaceAccess };
});

import { updatePageAction } from "./pages";

function doc(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

const DOC_OLD = doc("Old body");
const DOC_NEW = doc("New body");

function muted(userId: string) {
  return {
    userId,
    channels: { inApp: true, email: false, push: false },
    digest: "off",
    perType: { "page.updated": { inApp: false, email: false } },
  };
}

function writtenRecipients(): string[] {
  const calls = db.notificationCreateMany.mock.calls;
  if (calls.length === 0) return [];
  return (calls[0][0].data as { userId: string }[]).map((row) => row.userId);
}

beforeEach(() => {
  vi.clearAllMocks();
  db.pageFindUnique.mockResolvedValue({
    id: PAGE_ID,
    workspaceId: "ws-1",
    parentId: null,
    deletedAt: null,
    title: "Original",
    content: DOC_OLD,
    locked: false,
  });
  db.pageUpdate.mockResolvedValue({ id: PAGE_ID });
  db.pageVersionCreate.mockResolvedValue({ id: "ver-1" });
  db.pageFollowFindMany.mockResolvedValue([{ userId: "f1" }]);
  db.workspaceMemberFindMany.mockResolvedValue([{ userId: "f1" }]);
  db.userFindMany.mockResolvedValue([{ id: "f1", notificationPrefs: null }]);
  db.notificationFindMany.mockResolvedValue([]);
  db.notificationCreateMany.mockResolvedValue({ count: 1 });
  perms.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
});

describe("updatePageAction → follow dispatch (R82.12)", () => {
  it("a title edit writes a page.updated row for each follower", async () => {
    await expect(updatePageAction(PAGE_ID, { title: "Renamed" })).resolves.toEqual({
      ok: true,
    });

    expect(writtenRecipients()).toEqual(["f1"]);
    expect(db.notificationCreateMany.mock.calls[0][0].data[0]).toMatchObject({
      userId: "f1",
      type: "page.updated",
      payload: { workspaceId: "ws-1", pageId: PAGE_ID, actorId: ACTOR },
    });
  });

  it("a real content edit writes a page.updated row", async () => {
    await expect(updatePageAction(PAGE_ID, { content: DOC_NEW })).resolves.toEqual({
      ok: true,
    });
    expect(writtenRecipients()).toEqual(["f1"]);
  });

  it("a layout-only save is a no-op: no version, no notification", async () => {
    await expect(updatePageAction(PAGE_ID, { fullWidth: true })).resolves.toEqual({
      ok: true,
    });
    expect(db.pageVersionCreate).not.toHaveBeenCalled();
    expect(db.notificationCreateMany).not.toHaveBeenCalled();
  });

  it("re-saving the same title notifies nobody", async () => {
    await expect(updatePageAction(PAGE_ID, { title: "Original" })).resolves.toEqual({
      ok: true,
    });
    expect(db.pageVersionCreate).not.toHaveBeenCalled();
    expect(db.notificationCreateMany).not.toHaveBeenCalled();
  });

  it("re-saving an identical content doc snapshots history but does not notify", async () => {
    await expect(updatePageAction(PAGE_ID, { content: DOC_OLD })).resolves.toEqual({
      ok: true,
    });
    expect(db.pageVersionCreate).toHaveBeenCalledTimes(1);
    expect(db.notificationCreateMany).not.toHaveBeenCalled();
  });

  it("a muted follower receives nothing even on a real edit", async () => {
    db.pageFollowFindMany.mockResolvedValue([{ userId: "f1" }, { userId: "f2" }]);
    db.workspaceMemberFindMany.mockResolvedValue([
      { userId: "f1" },
      { userId: "f2" },
    ]);
    db.userFindMany.mockResolvedValue([
      { id: "f1", notificationPrefs: null },
      { id: "f2", notificationPrefs: muted("f2") },
    ]);

    await updatePageAction(PAGE_ID, { title: "Renamed" });

    expect(writtenRecipients()).toEqual(["f1"]);
  });

  it("a guest cannot edit and therefore dispatches nothing", async () => {
    perms.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
    await expect(updatePageAction(PAGE_ID, { title: "Renamed" })).resolves.toEqual({
      error: "You do not have permission to edit this page.",
    });
    expect(db.pageUpdate).not.toHaveBeenCalled();
    expect(db.notificationCreateMany).not.toHaveBeenCalled();
  });

  it("records a row.edited audit line when a database row is renamed", async () => {
    db.pageFindUnique.mockResolvedValue({
      id: PAGE_ID,
      workspaceId: "ws-1",
      parentId: "db-1",
      parent: { type: "DATABASE" },
      deletedAt: null,
      title: "Original",
      content: DOC_OLD,
      locked: false,
    });

    await updatePageAction(PAGE_ID, { title: "Renamed" });

    expect(activity.logActivity).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      actorId: ACTOR,
      action: "row.edited",
      targetType: "page",
      targetId: PAGE_ID,
    });
  });

  it("does not write row.edited for an ordinary page edit", async () => {
    await updatePageAction(PAGE_ID, { title: "Renamed" });
    expect(activity.logActivity).not.toHaveBeenCalled();
  });
});
