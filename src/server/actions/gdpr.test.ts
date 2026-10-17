import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B117 — the data-subject erasure left the link rows standing.
 *
 * The erasure (Art. 17) loaded the records of the kinds `user`, `page`,
 * `comment`, `reaction`, `version` and `shareLink` — but not the subject's
 * `pageFollow`, `favorite` and `notification` rows. The account was
 * anonymised, not deleted, so it **kept following** the pages (and kept
 * receiving the `page.updated` notifications, whose payload carries the page
 * title) and kept its inbox.
 *
 * These tests pin the request layer: the link rows are part of the subject's
 * records, they are exported (Art. 15), and the erasure removes them — unless
 * the subject put them under legal hold. The last test runs the real
 * `notifyPageUpdated` dispatch against the same store, so the effect on the
 * account is measured, not assumed. Only the transport edges (prisma, auth,
 * permissions, the queries module, the cache) are mocked; the plan engine, the
 * export bundle and the dispatch decision run for real.
 */

const SUBJECT = "u1";
const EDITOR = "u2";
const SLUG = "acme";

/** One follow row of the store. */
type FollowRow = { id: string; userId: string; pageId: string };

/** One notification row of the store. */
type NotificationRow = {
  id: string;
  userId: string;
  type: string;
  payload: unknown;
  read: boolean;
  createdAt: Date;
};

const auth = vi.hoisted(() => ({ user: { id: "u1", name: "Ada", locale: "en" } }));

const db = vi.hoisted(() => ({
  getWorkspaceAccess: vi.fn(),
  userFindUnique: vi.fn(),
  userFindMany: vi.fn(),
  pageFindUnique: vi.fn(),
  pageFindMany: vi.fn(),
  commentFindMany: vi.fn(),
  reactionFindMany: vi.fn(),
  versionFindMany: vi.fn(),
  shareLinkFindMany: vi.fn(),
  followFindMany: vi.fn(),
  followDelete: vi.fn(),
  favoriteFindMany: vi.fn(),
  favoriteDelete: vi.fn(),
  notificationFindMany: vi.fn(),
  notificationCreateMany: vi.fn(),
  notificationDelete: vi.fn(),
  transaction: vi.fn(),
  userUpdate: vi.fn(),
  pageUpdate: vi.fn(),
  memberFindMany: vi.fn(),
  commentUpdate: vi.fn(),
  versionUpdate: vi.fn(),
  shareLinkUpdate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: db.userFindUnique, findMany: db.userFindMany },
    page: { findUnique: db.pageFindUnique, findMany: db.pageFindMany },
    comment: { findMany: db.commentFindMany },
    commentReaction: { findMany: db.reactionFindMany },
    pageVersion: { findMany: db.versionFindMany },
    shareLink: { findMany: db.shareLinkFindMany },
    pageFollow: { findMany: db.followFindMany, delete: db.followDelete },
    // B37: the `page.updated` dispatch asks the members of the workspace who
    // may be notified — the mock has to answer.
    workspaceMember: { findMany: db.memberFindMany },
    favorite: { findMany: db.favoriteFindMany, delete: db.favoriteDelete },
    notification: {
      findMany: db.notificationFindMany,
      createMany: db.notificationCreateMany,
      delete: db.notificationDelete,
    },
    $transaction: db.transaction,
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => auth.user) }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: db.getWorkspaceAccess };
});
vi.mock("@/server/queries", () => ({
  getWorkspaceBySlug: vi.fn(async () => ({ id: "ws-1", name: "Acme", slug: SLUG })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { eraseSubjectDataAction, loadDataControlsAction } from "./gdpr";
import { notifyPageUpdated } from "./notifications";

/** The transaction handle the executor writes through. */
const tx = {
  user: { update: db.userUpdate },
  page: { update: db.pageUpdate },
  comment: { update: db.commentUpdate },
  pageVersion: { update: db.versionUpdate },
  shareLink: { update: db.shareLinkUpdate },
  pageFollow: { delete: db.followDelete },
  favorite: { delete: db.favoriteDelete },
  notification: { delete: db.notificationDelete },
};
/** The store the mocked prisma reads from and writes to. */
let followRows: FollowRow[] = [];
let notificationRows: NotificationRow[] = [];

/** The recipients of the last `page.updated` dispatch. */
function writtenRecipients(): string[] {
  const calls = db.notificationCreateMany.mock.calls;
  if (calls.length === 0) return [];
  return (calls[0][0].data as { userId: string }[]).map((row) => row.userId);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  auth.user = { id: SUBJECT, name: "Ada", locale: "en" };

  followRows = [
    { id: "pf_1", userId: SUBJECT, pageId: "pg_1" },
    { id: "pf_2", userId: EDITOR, pageId: "pg_1" },
  ];
  // B37: the `page.updated` dispatch notifies only the followers that are
  // members of the workspace — both are, in this fixture.
  db.memberFindMany.mockImplementation(
    async (args: { where: { workspaceId: string; userId: { in: string[] } } }) =>
      args.where.userId.in.map((userId) => ({ userId })),
  );
  notificationRows = [
    {
      id: "nt_1",
      userId: SUBJECT,
      type: "page.updated",
      payload: { workspaceId: "ws-1", pageId: "pg_1", title: "Roadmap", actorId: EDITOR },
      read: false,
      // Older than the 24 h dedupe window of the `page.updated` dispatch.
      createdAt: new Date("2025-12-20T00:00:00.000Z"),
    },
  ];

  db.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
  db.userFindUnique.mockResolvedValue({
    email: "ada@example.com",
    name: "Ada Lovelace",
    avatarUrl: null,
    locale: "en",
    theme: "dark",
    passwordHash: "$2b$hash",
    notificationPrefs: null,
    twoFactorSecret: null,
    twoFactorEnabled: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  });
  db.userFindMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
    args.where.id.in.map((id) => ({ id, notificationPrefs: null })),
  );
  db.pageFindUnique.mockResolvedValue({
    id: "pg_1",
    workspaceId: "ws-1",
    title: "Roadmap",
    deletedAt: null,
  });
  db.pageFindMany.mockResolvedValue([]);
  db.commentFindMany.mockResolvedValue([]);
  db.reactionFindMany.mockResolvedValue([]);
  db.versionFindMany.mockResolvedValue([]);
  db.shareLinkFindMany.mockResolvedValue([]);
  db.favoriteFindMany.mockResolvedValue([
    { id: "fv_1", userId: SUBJECT, pageId: "pg_2" },
  ]);
  db.favoriteDelete.mockResolvedValue({});

  db.followFindMany.mockImplementation(async (args: { where: { userId?: string; pageId?: string } }) =>
    followRows.filter(
      (row) =>
        (!args.where.userId || row.userId === args.where.userId) &&
        (!args.where.pageId || row.pageId === args.where.pageId),
    ),
  );
  db.followDelete.mockImplementation(async (args: { where: { id: string } }) => {
    followRows = followRows.filter((row) => row.id !== args.where.id);
    return {};
  });

  db.notificationFindMany.mockImplementation(
    async (args: {
      where: {
        userId?: string | { in: string[] };
        type?: string;
        createdAt?: { gte: Date };
        payload?: { path: string[]; equals: string };
      };
    }) => {
      const where = args.where ?? {};
      const users = typeof where.userId === "string" ? [where.userId] : (where.userId?.in ?? []);
      return notificationRows.filter((row) => {
        if (users.length > 0 && !users.includes(row.userId)) return false;
        if (where.type && where.type !== row.type) return false;
        if (where.createdAt?.gte && row.createdAt < where.createdAt.gte) return false;
        if (where.payload) {
          const payload = row.payload as Record<string, unknown> | null;
          if (!payload || payload.pageId !== where.payload.equals) return false;
        }
        return true;
      });
    },
  );
  db.notificationCreateMany.mockImplementation(async (args: { data: NotificationRow[] }) => {
    notificationRows.push(...args.data);
    return { count: args.data.length };
  });

  db.transaction.mockImplementation(async (run: (client: typeof tx) => unknown) => run(tx));
});

describe("eraseSubjectDataAction — the link rows (B117)", () => {
  it("removes the subject's follow, favourite and notification rows", async () => {
    const result = await eraseSubjectDataAction(SLUG);

    expect(result.ok).toBe(true);
    expect(db.followDelete).toHaveBeenCalledWith({ where: { id: "pf_1" } });
    expect(db.favoriteDelete).toHaveBeenCalledWith({ where: { id: "fv_1" } });
    expect(db.notificationDelete).toHaveBeenCalledWith({ where: { id: "nt_1" } });
  });

  it("keeps the anonymisation of the account itself", async () => {
    const result = await eraseSubjectDataAction(SLUG);

    expect(result.ok).toBe(true);
    expect(db.userUpdate).toHaveBeenCalledTimes(1);
    const written = db.userUpdate.mock.calls[0][0].data as Record<string, string>;
    expect(written.email).toMatch(/^anon:email:/);
    expect(written.name).toMatch(/^anon:name:/);
    expect(written.email).not.toContain("ada@example.com");
  });

  it("retains a link row the subject put under legal hold", async () => {
    const result = await eraseSubjectDataAction(SLUG, ["notification:nt_1"]);

    expect(result.ok).toBe(true);
    expect(db.notificationDelete).not.toHaveBeenCalled();
    expect(db.followDelete).toHaveBeenCalledWith({ where: { id: "pf_1" } });
    if (result.ok) expect(result.retained).toBe(1);
  });
});

describe("loadDataControlsAction — the link rows (B117)", () => {
  it("exports the subject's notifications with their payload", async () => {
    const result = await loadDataControlsAction(SLUG);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.exportCounts.notification).toBe(1);
    expect(result.exportCounts.pageFollow).toBe(1);
    expect(result.exportCounts.favorite).toBe(1);

    const bundle = JSON.parse(result.exportJson) as {
      entries: { entity: string; fields: Record<string, unknown> }[];
    };
    const notification = bundle.entries.find((entry) => entry.entity === "notification");
    expect(notification?.fields.payload).toEqual({
      workspaceId: "ws-1",
      pageId: "pg_1",
      title: "Roadmap",
      actorId: "u2",
    });
    const follow = bundle.entries.find((entry) => entry.entity === "pageFollow");
    expect(follow?.fields.pageId).toBe("pg_1");
  });

  it("lists the link rows in the plan, so they can be held", async () => {
    const result = await loadDataControlsAction(SLUG);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records.map((row) => row.key)).toEqual(
      expect.arrayContaining(["pageFollow:pf_1", "favorite:fv_1", "notification:nt_1"]),
    );
    expect(result.validation.ok).toBe(true);
  });
});

describe("the effect on the account (B117)", () => {
  it("stops the page.updated dispatch after the erasure", async () => {
    // Before the erasure: the subject follows the page, so an editor's change
    // notifies them — with the page title in the payload.
    auth.user = { id: EDITOR, name: "Bob", locale: "en" };
    await notifyPageUpdated("pg_1");
    expect(writtenRecipients()).toEqual([SUBJECT]);

    // The erasure removes the follow row …
    auth.user = { id: SUBJECT, name: "Ada", locale: "en" };
    await eraseSubjectDataAction(SLUG);
    expect(followRows.map((row) => row.id)).toEqual(["pf_2"]);

    // … so the anonymised account is no longer a recipient.
    vi.setSystemTime(new Date("2026-01-03T12:00:00.000Z"));
    db.notificationCreateMany.mockClear();
    auth.user = { id: EDITOR, name: "Bob", locale: "en" };
    await notifyPageUpdated("pg_1");
    expect(writtenRecipients()).toEqual([]);
  });
});
