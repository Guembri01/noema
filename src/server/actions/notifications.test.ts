import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePrefs } from "@/lib/notification-prefs-engine";

/**
 * R82.12 — the PageFollow dispatch (docs/specs/notifications.md, D1 "bell is
 * write-only"; docs/specs/collaboration-deep.md §7 "Following pages").
 *
 * `notifyPageUpdated` is the missing consumer of `PageFollow`: it resolves the
 * page's followers through the pure engine (`resolveRecipients`) and writes one
 * `page.updated` row per deliverable recipient. These tests pin the *dispatch
 * decision* - given followers + prefs, who gets notified - plus the guards the
 * action carries on its own (self-authorization, 24 h dedupe, never throwing).
 * Only the transport edges (prisma/auth/permissions/cache) are mocked; the
 * recipient rules run for real.
 */

const ACTOR = "author";
const PAGE_ID = "page-1";

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  pageFollowFindMany: vi.fn(),
  userFindMany: vi.fn(),
  notificationFindMany: vi.fn(),
  notificationCreateMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: db.pageFindUnique },
    pageFollow: { findMany: db.pageFollowFindMany },
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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const perms = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn() }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: perms.getWorkspaceAccess };
});

import { notifyPageUpdated } from "./notifications";

/** The row a follower's `User.notificationPrefs` would carry. */
function prefsFor(userId: string, raw: Record<string, unknown> = {}) {
  return parsePrefs({ userId, ...raw });
}

function writtenRecipients(): string[] {
  const calls = db.notificationCreateMany.mock.calls;
  if (calls.length === 0) return [];
  return (calls[0][0].data as { userId: string }[]).map((row) => row.userId);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Pin "now" so quiet-hours membership is deterministic.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T03:00:00.000Z"));

  db.pageFindUnique.mockResolvedValue({
    id: PAGE_ID,
    workspaceId: "ws-1",
    title: "Roadmap",
    deletedAt: null,
  });
  db.pageFollowFindMany.mockResolvedValue([]);
  db.userFindMany.mockResolvedValue([]);
  db.notificationFindMany.mockResolvedValue([]);
  db.notificationCreateMany.mockResolvedValue({ count: 0 });
  perms.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("notifyPageUpdated — recipient decision (R82.12)", () => {
  it("notifies deliverable followers only: drops the actor, a mute and quiet hours", async () => {
    db.pageFollowFindMany.mockResolvedValue([
      { userId: ACTOR },
      { userId: "f1" },
      { userId: "f2" },
      { userId: "f3" },
    ]);
    db.userFindMany.mockResolvedValue([
      { id: "f1", notificationPrefs: null },
      {
        id: "f2",
        notificationPrefs: prefsFor("f2", {
          perType: { "page.updated": { inApp: false, email: false } },
        }),
      },
      {
        id: "f3",
        // 03:00 UTC sits inside this window.
        notificationPrefs: prefsFor("f3", {
          quietHours: { start: "02:00", end: "04:00", tz: "UTC" },
        }),
      },
    ]);

    await notifyPageUpdated(PAGE_ID);

    expect(writtenRecipients()).toEqual(["f1"]);
    expect(db.notificationCreateMany).toHaveBeenCalledTimes(1);
    expect(db.notificationCreateMany.mock.calls[0][0].data[0]).toMatchObject({
      userId: "f1",
      type: "page.updated",
      payload: {
        workspaceId: "ws-1",
        pageId: PAGE_ID,
        title: "Roadmap",
        actorId: ACTOR,
      },
    });
  });

  it("writes nothing when the only follower is the actor", async () => {
    db.pageFollowFindMany.mockResolvedValue([{ userId: ACTOR }]);
    await notifyPageUpdated(PAGE_ID);
    expect(db.notificationCreateMany).not.toHaveBeenCalled();
  });

  it("writes nothing when the page has no followers and never queries prefs", async () => {
    db.pageFollowFindMany.mockResolvedValue([]);
    await notifyPageUpdated(PAGE_ID);
    expect(db.notificationCreateMany).not.toHaveBeenCalled();
    expect(db.userFindMany).not.toHaveBeenCalled();
  });

  it("a follower who muted page.updated in-app receives nothing", async () => {
    db.pageFollowFindMany.mockResolvedValue([{ userId: "f1" }]);
    db.userFindMany.mockResolvedValue([
      {
        id: "f1",
        notificationPrefs: prefsFor("f1", {
          perType: { "page.updated": { inApp: false, email: false } },
        }),
      },
    ]);
    await notifyPageUpdated(PAGE_ID);
    expect(db.notificationCreateMany).not.toHaveBeenCalled();
  });

  it("dedupes a follower already notified for this page within 24 h", async () => {
    db.pageFollowFindMany.mockResolvedValue([{ userId: "f1" }, { userId: "f2" }]);
    db.userFindMany.mockResolvedValue([
      { id: "f1", notificationPrefs: null },
      { id: "f2", notificationPrefs: null },
    ]);
    db.notificationFindMany.mockResolvedValue([{ userId: "f1" }]);

    await notifyPageUpdated(PAGE_ID);

    expect(writtenRecipients()).toEqual(["f2"]);
    const dedupeWhere = db.notificationFindMany.mock.calls[0][0].where;
    expect(dedupeWhere.type).toBe("page.updated");
    expect(dedupeWhere.payload).toEqual({ path: ["pageId"], equals: PAGE_ID });
  });
});

describe("notifyPageUpdated — guards", () => {
  it("refuses a caller without edit access on the page's workspace", async () => {
    perms.getWorkspaceAccess.mockResolvedValue(null);
    db.pageFollowFindMany.mockResolvedValue([{ userId: "f1" }]);
    await notifyPageUpdated(PAGE_ID);
    expect(db.pageFollowFindMany).not.toHaveBeenCalled();
    expect(db.notificationCreateMany).not.toHaveBeenCalled();
  });

  it("ignores a missing or trashed page", async () => {
    db.pageFindUnique.mockResolvedValueOnce(null);
    await notifyPageUpdated(PAGE_ID);
    db.pageFindUnique.mockResolvedValueOnce({
      id: PAGE_ID,
      workspaceId: "ws-1",
      title: "Roadmap",
      deletedAt: new Date("2025-12-01T00:00:00.000Z"),
    });
    await notifyPageUpdated(PAGE_ID);
    expect(db.notificationCreateMany).not.toHaveBeenCalled();
  });

  it("never throws when the write fails (R82.8)", async () => {
    db.pageFollowFindMany.mockResolvedValue([{ userId: "f1" }]);
    db.userFindMany.mockResolvedValue([{ id: "f1", notificationPrefs: null }]);
    db.notificationCreateMany.mockRejectedValue(new Error("db down"));
    await expect(notifyPageUpdated(PAGE_ID)).resolves.toBeUndefined();
  });
});
