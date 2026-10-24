import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B82/B79 audit completeness: editing, resolving and deleting a comment each
 * leave one `Activity` line, so the workspace audit feed can explain the whole
 * comment lifecycle instead of stopping at creation.
 */

const db = vi.hoisted(() => ({
  commentFindUnique: vi.fn(),
  commentUpdate: vi.fn(),
  commentDelete: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    comment: {
      findUnique: db.commentFindUnique,
      update: db.commentUpdate,
      delete: db.commentDelete,
    },
  },
}));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "actor" })),
}));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return {
    ...actual,
    getWorkspaceAccess: vi.fn(async () => ({ role: "MEMBER" })),
  };
});
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: vi.fn(async () => undefined) }));
const logActivity = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/activity", () => ({ logActivity }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  deleteCommentAction,
  editCommentAction,
  resolveCommentAction,
} from "./comments";

const COMMENT_ID = "claaaaaaaaaaaaaaaaaaaaaaaa";
const PAGE_ID = "clbbbbbbbbbbbbbbbbbbbbbbbb";

function commentRow() {
  return {
    id: COMMENT_ID,
    pageId: PAGE_ID,
    authorId: "actor",
    page: { workspaceId: "ws-1", permissions: [] },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.commentFindUnique.mockResolvedValue(commentRow());
  db.commentUpdate.mockResolvedValue({ id: COMMENT_ID });
  db.commentDelete.mockResolvedValue({ id: COMMENT_ID });
});

describe("comment lifecycle audit", () => {
  it("records an edit", async () => {
    await expect(editCommentAction(COMMENT_ID, "edited body")).resolves.toEqual({
      ok: true,
      edited: true,
    });
    expect(logActivity).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      actorId: "actor",
      action: "comment.edited",
      targetType: "comment",
      targetId: COMMENT_ID,
      meta: { pageId: PAGE_ID },
    });
  });

  it("records resolve and reopen with the target state", async () => {
    await expect(resolveCommentAction(COMMENT_ID, true)).resolves.toEqual({ ok: true });
    expect(logActivity).toHaveBeenLastCalledWith({
      workspaceId: "ws-1",
      actorId: "actor",
      action: "comment.resolved",
      targetType: "comment",
      targetId: COMMENT_ID,
      meta: { pageId: PAGE_ID, resolved: true },
    });

    await resolveCommentAction(COMMENT_ID, false);
    expect(logActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ meta: { pageId: PAGE_ID, resolved: false } }),
    );
  });

  it("records a deletion after the row is gone", async () => {
    await expect(deleteCommentAction(COMMENT_ID)).resolves.toEqual({ ok: true });
    expect(db.commentDelete).toHaveBeenCalledWith({ where: { id: COMMENT_ID } });
    expect(logActivity).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      actorId: "actor",
      action: "comment.deleted",
      targetType: "comment",
      targetId: COMMENT_ID,
      meta: { pageId: PAGE_ID },
    });
  });
});
