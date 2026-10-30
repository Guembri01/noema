import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateShortCode } from "@/lib/short-link";

/**
 * Public form links are ShareLink rows with a `viewId`. These tests pin the
 * boundary between a page share and a form share: the page share panel only
 * reads/writes `viewId: null`, a form link is idempotent per view, and revoking
 * a form link deletes only that view's row.
 */

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  pageUpdateMany: vi.fn(),
  viewFindUnique: vi.fn(),
  linkFindFirst: vi.fn(),
  linkCreate: vi.fn(),
  linkUpdate: vi.fn(),
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

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: db.pageFindUnique, updateMany: db.pageUpdateMany },
    databaseView: { findUnique: db.viewFindUnique },
    shareLink: {
      findFirst: db.linkFindFirst,
      create: db.linkCreate,
      update: db.linkUpdate,
      deleteMany: db.linkDeleteMany,
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
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  createFormShareLinkAction,
  createShareLinkAction,
  getFormShareLinkStateAction,
  getShareLinkStateAction,
  revokeFormShareLinkAction,
  revokeShareLinkAction,
} from "./share";

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUser.mockResolvedValue({ id: "user-1" });
  perm.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
  perm.canPerformWorkspaceAction.mockReturnValue(true);
  access.pageCapabilitiesFromRelation.mockReturnValue({ share: true });
  db.pageFindUnique.mockResolvedValue({
    id: "db-1",
    workspaceId: "ws-1",
    type: "DATABASE",
    deletedAt: null,
    permissions: [],
  });
  db.viewFindUnique.mockResolvedValue({
    id: "view-1",
    type: "FORM",
    databasePageId: "db-1",
  });
  db.linkFindFirst.mockResolvedValue(null);
  db.linkCreate.mockResolvedValue({ token: "tok-1" });
  db.linkUpdate.mockResolvedValue({});
  db.linkDeleteMany.mockResolvedValue({ count: 1 });
  db.pageUpdateMany.mockResolvedValue({ count: 1 });
});

describe("form share links", () => {
  it("creates one indexed-off link per FORM view", async () => {
    const result = await createFormShareLinkAction("view-1");

    expect(result).toEqual({ url: "/s/tok-1" });
    expect(db.linkFindFirst).toHaveBeenCalledWith({
      where: { pageId: "db-1", viewId: "view-1" },
      select: { token: true },
    });
    expect(db.linkCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        pageId: "db-1",
        viewId: "view-1",
        permission: "READ",
        indexing: false,
      }),
      select: { token: true },
    });
  });

  it("reuses the existing form link", async () => {
    db.linkFindFirst.mockResolvedValue({ token: "existing" });

    expect(await createFormShareLinkAction("view-1")).toEqual({
      url: "/s/existing",
    });
    expect(db.linkCreate).not.toHaveBeenCalled();
  });

  it("refuses a non-FORM view", async () => {
    db.viewFindUnique.mockResolvedValue({
      id: "view-1",
      type: "TABLE",
      databasePageId: "db-1",
    });

    expect(await createFormShareLinkAction("view-1")).toEqual({
      error: "Form not found.",
    });
    expect(db.linkCreate).not.toHaveBeenCalled();
  });

  it("refuses a caller without share permission", async () => {
    perm.canPerformWorkspaceAction.mockReturnValue(false);

    expect(await createFormShareLinkAction("view-1")).toEqual({
      error: "You do not have permission to share this form.",
    });
    expect(db.linkCreate).not.toHaveBeenCalled();
  });

  it("reports the form link state", async () => {
    expect(await getFormShareLinkStateAction("view-1")).toEqual({
      published: false,
      url: null,
    });

    db.linkFindFirst.mockResolvedValue({ token: "tok-2" });
    expect(await getFormShareLinkStateAction("view-1")).toEqual({
      published: true,
      url: "/s/tok-2",
    });
  });

  it("revokes only the form link", async () => {
    expect(await revokeFormShareLinkAction("view-1")).toEqual({ ok: true });
    expect(db.linkDeleteMany).toHaveBeenCalledWith({
      where: { pageId: "db-1", viewId: "view-1" },
    });
  });

  it("removing the page link leaves every form link published", async () => {
    expect(await revokeShareLinkAction("db-1")).toEqual({ ok: true, removed: 1 });
    expect(db.linkDeleteMany).toHaveBeenCalledWith({
      where: { pageId: "db-1", viewId: null },
    });
  });

  it("keeps the page share panel on the page-level link", async () => {
    db.linkFindFirst.mockResolvedValue({
      token: "page-token",
      permission: "READ",
      passwordHash: null,
      expiresAt: null,
      indexing: true,
    });

    await getShareLinkStateAction("db-1");
    expect(db.linkFindFirst).toHaveBeenCalledWith({
      where: { pageId: "db-1", viewId: null },
    });

    await createShareLinkAction("db-1");
    expect(db.linkFindFirst).toHaveBeenLastCalledWith({
      where: { pageId: "db-1", viewId: null },
    });
  });
});


/**
 * P1-T02 — the short link the dialog renders lives on a deterministic alias
 * (`Page.shortCode`, seeded by the page id). The alias is stamped lazily
 * whenever a permitted user reads or (re)publishes the page-level share
 * state, so the public resolver finds it by an indexed lookup instead of a
 * scan. A collision race never throws — it just leaves the alias unset,
 * which makes the short link fail closed rather than mis-route.
 */
describe("the short-code alias stamp (P1-T02)", () => {
  it("stamps the alias when the page-level share state is read", async () => {
    await getShareLinkStateAction("db-1");

    expect(db.pageFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "db-1" } }),
    );
    expect(db.pageUpdateMany).toHaveBeenCalledWith({
      where: { id: "db-1", shortCode: null },
      data: { shortCode: generateShortCode({ seed: "db-1" }) },
    });
  });

  it("stamps the alias when the page-level link is published or revisited", async () => {
    await createShareLinkAction("db-1", {});

    expect(db.pageUpdateMany).toHaveBeenCalledWith({
      where: { id: "db-1", shortCode: null },
      data: { shortCode: generateShortCode({ seed: "db-1" }) },
    });
  });

  it("swallows a collision race instead of failing the publish", async () => {
    db.pageUpdateMany.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    await expect(createShareLinkAction("db-1", {})).resolves.toEqual({
      url: "/s/tok-1",
    });
  });

  it("does not stamp the alias for a form-view link", async () => {
    await createFormShareLinkAction("view-1");

    expect(db.pageUpdateMany).not.toHaveBeenCalled();
  });
});
