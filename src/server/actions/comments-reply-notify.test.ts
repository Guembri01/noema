import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B114 — a reply may only notify the author of the parent comment while that
 * person still is a member of the workspace.
 *
 * The mention path right below the reply path resolves the current members of
 * the workspace before it writes a row; the reply path did not, so somebody who
 * had been removed from the workspace was told that a reply to their comment
 * arrived. The real action runs (validation, thread depth, the write, the
 * dispatch); only the transport edges (prisma/auth/permissions/webhooks/
 * activity/cache) are mocked.
 */

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  commentFindUnique: vi.fn(),
  commentCreate: vi.fn(),
  memberFindMany: vi.fn(),
  notificationCreate: vi.fn(),
  notificationCreateMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: db.pageFindUnique },
    comment: { findUnique: db.commentFindUnique, create: db.commentCreate },
    workspaceMember: { findMany: db.memberFindMany },
    notification: {
      create: db.notificationCreate,
      createMany: db.notificationCreateMany,
    },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "actor" })) }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: vi.fn(async () => undefined) }));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const perms = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn() }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: perms.getWorkspaceAccess };
});

import { addCommentAction } from "./comments";

/** The actor of the reply — a member of the workspace. */
const ACTOR = "actor";
/** A member who is still in the workspace. */
const MEMBER = "member-2";
/** Somebody who was removed from the workspace after writing the comment. */
const REMOVED = "removed-member";

const PAGE_ID = "clzzzzzzzzzzzzzzzzzzzzzzz";
const PARENT_ID = "claaaaaaaaaaaaaaaaaaaaaaaa";
const REPLY_ID = "clbbbbbbbbbbbbbbbbbbbbbbbbb";

/** The parent comment as the action sees it (thread walk and reply notify). */
function parentRow(authorId: string) {
  return {
    id: PARENT_ID,
    parentId: null,
    pageId: PAGE_ID,
    authorId,
    body: "the original comment",
    createdAt: new Date("2026-10-21T10:00:00.000Z"),
  };
}

/** The reply notification rows that were written. */
function writtenReplies(): { userId: string; type: string; payload: unknown }[] {
  return db.notificationCreate.mock.calls.map(
    (call) => call[0].data as { userId: string; type: string; payload: unknown },
  );
}

/** The workspace access lookups the action made, in order. */
function accessLookups(): [string, string][] {
  return perms.getWorkspaceAccess.mock.calls.map((call) => [call[0], call[1]]);
}

beforeEach(() => {
  vi.clearAllMocks();
  db.pageFindUnique.mockResolvedValue({ workspaceId: "ws-1" });
  db.commentFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === PARENT_ID ? parentRow(MEMBER) : null,
  );
  db.commentCreate.mockResolvedValue({ id: REPLY_ID });
  db.memberFindMany.mockResolvedValue([]);
  db.notificationCreate.mockResolvedValue({ id: "notif-1" });
  db.notificationCreateMany.mockResolvedValue({ count: 0 });
  // The actor and every member have access; the removed member has none.
  perms.getWorkspaceAccess.mockImplementation(async (userId: string) =>
    userId === REMOVED ? null : { role: "MEMBER" },
  );
});

describe("addCommentAction → reply dispatch", () => {
  it("notifies the author of the parent comment while they are a member", async () => {
    await expect(
      addCommentAction({ pageId: PAGE_ID, body: "a reply", parentId: PARENT_ID }),
    ).resolves.toEqual({ ok: true, id: REPLY_ID });

    // B136: the payload names the workspace, like the other two notification
    // types do — without it the row cannot be attributed to a workspace.
    expect(writtenReplies()).toEqual([
      {
        userId: MEMBER,
        type: "comment.reply",
        payload: { workspaceId: "ws-1", pageId: PAGE_ID, commentId: REPLY_ID },
      },
    ]);
  });

  it("names the workspace in the payload of a mention (B136)", async () => {
    db.memberFindMany.mockResolvedValue([
      { userId: MEMBER, user: { name: "Ada", email: "ada@example.test" } },
    ]);

    await addCommentAction({ pageId: PAGE_ID, body: "@Ada hello" });

    const rows = db.notificationCreateMany.mock.calls.map(
      (call) => call[0].data as { userId: string; type: string; payload: unknown }[],
    );
    expect(rows[0][0]).toEqual({
      userId: MEMBER,
      type: "page.mention",
      payload: { workspaceId: "ws-1", pageId: PAGE_ID, commentId: REPLY_ID },
    });
  });

  it("asks whether the author of the parent comment still has access", async () => {
    await addCommentAction({ pageId: PAGE_ID, body: "a reply", parentId: PARENT_ID });

    expect(accessLookups()).toEqual([
      [ACTOR, "ws-1"],
      [MEMBER, "ws-1"],
    ]);
  });

  it("notifies nobody when the author of the parent comment was removed", async () => {
    db.commentFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === PARENT_ID ? parentRow(REMOVED) : null,
    );

    await expect(
      addCommentAction({ pageId: PAGE_ID, body: "a reply", parentId: PARENT_ID }),
    ).resolves.toEqual({ ok: true, id: REPLY_ID });

    expect(writtenReplies()).toEqual([]);
    expect(db.notificationCreate).not.toHaveBeenCalled();
    expect(accessLookups()).toContainEqual([REMOVED, "ws-1"]);
  });

  it("notifies nobody when the actor replies to their own comment", async () => {
    db.commentFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === PARENT_ID ? parentRow(ACTOR) : null,
    );

    await addCommentAction({ pageId: PAGE_ID, body: "a reply", parentId: PARENT_ID });

    expect(db.notificationCreate).not.toHaveBeenCalled();
  });

  it("writes no reply row for a comment without a parent", async () => {
    await expect(addCommentAction({ pageId: PAGE_ID, body: "a root comment" })).resolves.toEqual({
      ok: true,
      id: REPLY_ID,
    });

    expect(db.notificationCreate).not.toHaveBeenCalled();
  });
});

describe("addCommentAction → mention dispatch (unchanged)", () => {
  it("notifies a mentioned member of the workspace", async () => {
    db.memberFindMany.mockResolvedValue([
      { userId: MEMBER, user: { name: "Ada Lovelace", email: "ada@example.com" } },
    ]);

    await addCommentAction({ pageId: PAGE_ID, body: "ping @ada" });

    // B136: the payload names the workspace, like the other two notification
    // types do — without it the row cannot be attributed to a workspace.
    expect(db.notificationCreateMany).toHaveBeenCalledWith({
      data: [
        {
          userId: MEMBER,
          type: "page.mention",
          payload: { workspaceId: "ws-1", pageId: PAGE_ID, commentId: REPLY_ID },
        },
      ],
    });
  });

  it("does not mention the author of the comment", async () => {
    db.memberFindMany.mockResolvedValue([
      { userId: ACTOR, user: { name: "Ada Lovelace", email: "ada@example.com" } },
    ]);

    await addCommentAction({ pageId: PAGE_ID, body: "ping @ada" });

    expect(db.notificationCreateMany).not.toHaveBeenCalled();
  });
});
