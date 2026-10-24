import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Exact-range comment anchors, server side.
 *
 * The action validates client offsets against the page's *stored* content
 * before writing. These tests pin the persistence shape, the fail-closed
 * cases (mismatched quote, out-of-bounds/foreign block), reply inheritance and
 * the permission gate. Only transport edges are mocked; validation and the
 * page-capability decision run for real.
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
vi.mock("@/lib/guest-access", () => ({
  guestReadablePageIds: vi.fn(async () => new Set<string>()),
}));

const perms = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn() }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: perms.getWorkspaceAccess };
});

import { addCommentAction } from "./comments";

const ACTOR = "actor";
const PAGE_ID = "clzzzzzzzzzzzzzzzzzzzzzzz";
const ROOT_ID = "claaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_ID = "clbbbbbbbbbbbbbbbbbbbbbbbbb";

const PAGE_CONTENT = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { id: "b1" },
      content: [{ type: "text", text: "hello selected world" }],
    },
  ],
};

function pageMeta(permissions: { level: string }[] = []) {
  return { workspaceId: "ws-1", permissions };
}

function rootRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ROOT_ID,
    parentId: null,
    pageId: PAGE_ID,
    authorId: ACTOR,
    body: "the original comment",
    blockId: "b1",
    anchorFrom: 6,
    anchorTo: 14,
    quote: "selected",
    createdAt: new Date("2026-10-24T10:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.pageFindUnique.mockImplementation(
    async ({ select }: { select?: Record<string, unknown> }) =>
      select && "content" in select
        ? { content: PAGE_CONTENT }
        : pageMeta(),
  );
  db.commentFindUnique.mockResolvedValue(rootRow());
  db.commentCreate.mockResolvedValue({ id: NEW_ID });
  db.memberFindMany.mockResolvedValue([]);
  db.notificationCreate.mockResolvedValue({ id: "notif-1" });
  db.notificationCreateMany.mockResolvedValue({ count: 0 });
  perms.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
});

describe("addCommentAction → exact-range anchors", () => {
  it("persists validated offsets and the exact quote on a root", async () => {
    await expect(
      addCommentAction({
        pageId: PAGE_ID,
        body: "a precise comment",
        blockId: "b1",
        quote: "selected",
        anchorFrom: 6,
        anchorTo: 14,
      }),
    ).resolves.toEqual({ ok: true, id: NEW_ID });

    expect(db.commentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          parentId: null,
          blockId: "b1",
          quote: "selected",
          anchorFrom: 6,
          anchorTo: 14,
        }),
      }),
    );
  });

  it("fails closed when the quote no longer matches the stored block text", async () => {
    await expect(
      addCommentAction({
        pageId: PAGE_ID,
        body: "a stale comment",
        blockId: "b1",
        quote: "different",
        anchorFrom: 6,
        anchorTo: 14,
      }),
    ).resolves.toEqual({
      error: "The selected text changed. Select it again.",
    });
    expect(db.commentCreate).not.toHaveBeenCalled();
  });

  it("rejects out-of-bounds and half ranges before writing", async () => {
    await expect(
      addCommentAction({
        pageId: PAGE_ID,
        body: "too far",
        blockId: "b1",
        quote: "selected",
        anchorFrom: 6,
        anchorTo: 999,
      }),
    ).resolves.toEqual({ error: "The selected range is outside its block." });

    await expect(
      addCommentAction({
        pageId: PAGE_ID,
        body: "half",
        blockId: "b1",
        quote: "selected",
        anchorFrom: 6,
      }),
    ).resolves.toEqual({
      error: "The selected range is incomplete. Select the text again.",
    });
    expect(db.commentCreate).not.toHaveBeenCalled();
  });

  it("fails closed for a block id that is not in this page", async () => {
    await expect(
      addCommentAction({
        pageId: PAGE_ID,
        body: "foreign",
        blockId: "other-page-block",
        quote: "selected",
        anchorFrom: 6,
        anchorTo: 14,
      }),
    ).resolves.toEqual({
      error: "The selected text is no longer available.",
    });
    expect(db.commentCreate).not.toHaveBeenCalled();
  });

  it("drops offsets supplied on a reply instead of storing a second anchor", async () => {
    await addCommentAction({
      pageId: PAGE_ID,
      body: "a reply",
      parentId: ROOT_ID,
      blockId: "b1",
      quote: "selected",
      anchorFrom: 6,
      anchorTo: 14,
    });

    const created = db.commentCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(created.parentId).toBe(ROOT_ID);
    expect(created.blockId).toBeUndefined();
    expect(created.quote).toBeNull();
    expect(created.anchorFrom).toBeUndefined();
    expect(created.anchorTo).toBeUndefined();
  });

  it("carries the root's range into a reply mention deep link", async () => {
    db.memberFindMany.mockResolvedValue([
      { userId: "member-2", user: { name: "Ada", email: "ada@example.test" } },
    ]);

    await addCommentAction({
      pageId: PAGE_ID,
      body: "@Ada reply",
      parentId: ROOT_ID,
    });

    const rows = db.notificationCreateMany.mock.calls[0][0].data as {
      payload: Record<string, unknown>;
    }[];
    expect(rows[0].payload).toMatchObject({
      pageId: PAGE_ID,
      blockId: "b1",
      anchorFrom: 6,
      anchorTo: 14,
    });
  });

  it("rejects a READ-only member before validating or writing", async () => {
    db.pageFindUnique.mockResolvedValue(pageMeta([{ level: "READ" }]));

    await expect(
      addCommentAction({
        pageId: PAGE_ID,
        body: "not allowed",
        blockId: "b1",
        quote: "selected",
        anchorFrom: 6,
        anchorTo: 14,
      }),
    ).resolves.toEqual({ error: "You do not have permission to comment." });

    expect(db.commentCreate).not.toHaveBeenCalled();
    // The content read is behind the permission gate.
    expect(
      db.pageFindUnique.mock.calls.some(
        (call) => call[0]?.select && "content" in call[0].select,
      ),
    ).toBe(false);
  });
});
