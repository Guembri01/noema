import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B38 — the trash purge must not touch uploads of another workspace.
 *
 * A purged page can reference an upload of a *foreign* workspace (a URL that
 * leaked through a share link). The purge drops the blobs it finds and their
 * Asset rows, so without a workspace check it deletes another tenant's file.
 *
 * Only the transport edges (prisma, session, permissions, webhooks, activity,
 * cache, the storage driver) are mocked; the actions, the stale-url rules and
 * the storage cleanup run for real.
 */

const PAGE_ID = "page-1";

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  pageFindMany: vi.fn(),
  pageDeleteMany: vi.fn(),
  propertyValueFindMany: vi.fn(),
  assetDeleteMany: vi.fn(),
}));
const perms = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn() }));
const store = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: {
      findUnique: db.pageFindUnique,
      findMany: db.pageFindMany,
      deleteMany: db.pageDeleteMany,
    },
    propertyValue: { findMany: db.propertyValueFindMany },
    asset: { deleteMany: db.assetDeleteMany },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "user-1" })) }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: perms.getWorkspaceAccess };
});
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: vi.fn(async () => undefined) }));
vi.mock("@/server/actions/notifications", () => ({
  notifyPageUpdated: vi.fn(async () => undefined),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    storageDriver: () => ({
      name: "local" as const,
      put: store.put,
      get: store.get,
      remove: store.remove,
    }),
  };
});

import { deletePageAction, emptyTrashAction } from "./pages";

/** A trashed page that references one upload of its own workspace and one of another. */
const PURGED_CONTENT = {
  type: "doc",
  content: [
    { type: "image", attrs: { src: "/api/files/ws-1/own.png" } },
    { type: "image", attrs: { src: "/api/files/ws-2/foreign.png" } },
  ],
};

const removedKeys = (): string[] => store.remove.mock.calls.map((call) => call[0] as string);

beforeEach(() => {
  vi.clearAllMocks();
  perms.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
  db.pageFindUnique.mockResolvedValue({
    id: PAGE_ID,
    workspaceId: "ws-1",
    parentId: null,
    deletedAt: new Date("2026-01-01"),
  });
  db.pageFindMany.mockImplementation(
    async ({ where }: { where: Record<string, unknown> }) => {
      const id = where.id as { in?: string[]; notIn?: string[] } | undefined;
      if (where.deletedAt) return [{ id: PAGE_ID }];
      if (id?.in) return [{ content: PURGED_CONTENT, coverUrl: null }];
      if (id?.notIn) return [];
      return [{ id: PAGE_ID, parentId: null }];
    },
  );
  db.propertyValueFindMany.mockResolvedValue([]);
  db.pageDeleteMany.mockResolvedValue({ count: 1 });
  db.assetDeleteMany.mockResolvedValue({ count: 1 });
  store.remove.mockResolvedValue(undefined);
});

describe("trash purge — upload scope (B38)", () => {
  it("deletePageAction removes the workspace's own upload and not a foreign one", async () => {
    await expect(deletePageAction(PAGE_ID, "ws-1")).resolves.toEqual({ ok: true });

    expect(removedKeys()).toEqual(["ws-1/own.png"]);
    expect(removedKeys()).not.toContain("ws-2/foreign.png");
  });

  it("deletePageAction deletes only the Asset rows of its own workspace", async () => {
    await deletePageAction(PAGE_ID, "ws-1");

    expect(db.assetDeleteMany).toHaveBeenCalledWith({
      where: { url: { in: ["/api/files/ws-1/own.png"] } },
    });
  });

  it("emptyTrashAction removes the workspace's own upload and not a foreign one", async () => {
    await expect(emptyTrashAction("ws-1")).resolves.toEqual({ ok: true, deleted: 1 });

    expect(removedKeys()).toEqual(["ws-1/own.png"]);
    expect(removedKeys()).not.toContain("ws-2/foreign.png");
    expect(db.assetDeleteMany).toHaveBeenCalledWith({
      where: { url: { in: ["/api/files/ws-1/own.png"] } },
    });
  });

  it("still purges the page itself", async () => {
    await deletePageAction(PAGE_ID, "ws-1");

    expect(db.pageDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: [PAGE_ID] }, workspaceId: "ws-1" },
    });
  });
});
