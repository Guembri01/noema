import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P1-T03 — the page share panel must only ever see the page-level share link
 * (`ShareLink.viewId === null`). `getPageDetail` used to select *any* link on
 * the page, so a published FORM view leaked its token into the page dialog's
 "published" state, and unpublishing then matched 0 rows while claiming
 * success. These pins cover the query filter, deterministic ordering, and the
 * unpublish outcome that reports how many rows actually went away.
 */

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  linkDeleteMany: vi.fn(),
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
    page: { findUnique: db.pageFindUnique },
    shareLink: { deleteMany: db.linkDeleteMany },
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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getPageDetail } from "@/server/queries/workspaces";
import { revokeShareLinkAction } from "./share";

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUser.mockResolvedValue({ id: "user-1" });
  perm.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
  perm.canPerformWorkspaceAction.mockReturnValue(true);
  access.pageCapabilitiesFromRelation.mockReturnValue({ share: true });
  db.pageFindUnique.mockResolvedValue({ id: "db-1", workspaceId: "ws-1", permissions: [] });
  db.linkDeleteMany.mockResolvedValue({ count: 1 });
});

describe("getPageDetail share-link select (P1-T03)", () => {
  it("only reads the page-level link, never a form (view) link", async () => {
    await getPageDetail("db-1");

    const call = db.pageFindUnique.mock.calls[0][0];
    expect(call).toMatchObject({
      where: { id: "db-1" },
      include: {
        shareLinks: {
          where: { viewId: null },
          orderBy: { id: "asc" },
          take: 1,
          select: { id: true, token: true },
        },
      },
    });
  });

  it("leads to a deterministic page token when several page-level links exist", async () => {
    // The where clause excludes form links, so whichever rows remain are all
    // page-level links; `{ id: "asc" }` makes the pick stable across calls.
    await getPageDetail("db-1");
    const { shareLinks } = db.pageFindUnique.mock.calls[0][0].include;
    expect(shareLinks.orderBy).toEqual({ id: "asc" });
    expect(shareLinks.take).toBe(1);
    expect(shareLinks.where).toEqual({ viewId: null });
  });

  it("returns no shareLinks token for a form-only published page", async () => {
    // A faithful mock honours the where clause: form-only page → no rows.
    db.pageFindUnique.mockResolvedValue({
      id: "db-1",
      workspaceId: "ws-1",
      shareLinks: [],
      versions: [],
      comments: [],
    });
    const page = await getPageDetail("db-1");
    expect(page?.shareLinks).toEqual([]);
    expect(page?.shareLinks[0]?.token).toBeUndefined();
  });
});

describe("revokeShareLinkAction outcome (P1-T03)", () => {
  it("reports removed: 0 and does not touch the audit log on a form-only page", async () => {
    db.linkDeleteMany.mockResolvedValue({ count: 0 });

    await expect(revokeShareLinkAction("db-1")).resolves.toEqual({
      ok: true,
      removed: 0,
    });
    expect(activity.logActivity).not.toHaveBeenCalled();
  });

  it("reports removed: 1 and logs page.unshared when a link went away", async () => {
    db.linkDeleteMany.mockResolvedValue({ count: 1 });

    await expect(revokeShareLinkAction("db-1")).resolves.toEqual({
      ok: true,
      removed: 1,
    });
    expect(activity.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "page.unshared",
        targetId: "db-1",
        actorId: "user-1",
      }),
    );
  });
});
