import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cross-workspace move actions — the server half of
 * `@/lib/workspace-move`. The pure planner runs for real; only the transport
 * edges (auth, db, permissions, activity, revalidation) are mocked. Pins the
 * plan→UI mapping, the refusal paths, the collision warnings and the exact
 * ref-remapped write payload.
 */

const auth = vi.hoisted(() => ({ user: { id: "user-1" } }));

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  pageFindMany: vi.fn(),
  workspaceFindUnique: vi.fn(),
  memberFindMany: vi.fn(),
  transaction: vi.fn(),
}));

const tx = vi.hoisted(() => ({
  pageCreateMany: vi.fn(),
  memberCreateMany: vi.fn(),
}));

const access = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: db.pageFindUnique, findMany: db.pageFindMany },
    workspace: { findUnique: db.workspaceFindUnique },
    workspaceMember: { findMany: db.memberFindMany },
    $transaction: db.transaction,
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => auth.user) }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: access.getWorkspaceAccess,
  canEditContent: (role: string) => role !== "GUEST",
}));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  executeWorkspaceMoveAction,
  previewWorkspaceMoveAction,
} from "./move-workspace";

const SOURCE_WORKSPACE = "ws-src";
const TARGET_WORKSPACE = "ws-dst";

/** A small source workspace: `p-root` + `p-a` are the subtree, the rest stays. */
function sourcePages() {
  return [
    {
      id: "p-root",
      parentId: null,
      title: "Root",
      createdById: "user-2",
      icon: "📄",
      coverUrl: null,
      type: "PAGE",
      position: 1,
      fullWidth: false,
      smallText: false,
      font: "default",
      lineSpacing: "normal",
      locked: false,
      schemaLocked: false,
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "hello" }] },
          { type: "mention", attrs: { pageId: "p-a", label: "Alpha" } },
          { type: "pageEmbed", attrs: { pageId: "p-missing", title: "Gone" } },
        ],
      },
    },
    {
      id: "p-a",
      parentId: "p-root",
      title: "Alpha",
      createdById: "user-2",
      type: "PAGE",
      position: 2,
      content: { type: "doc", content: [{ type: "relation", attrs: { pageIds: ["p-root"] } }] },
    },
    { id: "p-b", parentId: "p-external", title: "Beta", createdById: "user-2" },
    { id: "p-other", parentId: null, title: "Other", createdById: "user-2" },
  ];
}

/** The destination, which already has a page titled like the incoming `p-a`. */
const TARGET_PAGES = [{ id: "t1", title: "Alpha" }];

beforeEach(() => {
  vi.clearAllMocks();
  auth.user = { id: "user-1" };
  db.pageFindUnique.mockResolvedValue({
    id: "p-root",
    title: "Root",
    workspaceId: SOURCE_WORKSPACE,
    deletedAt: null,
  });
  db.workspaceFindUnique.mockResolvedValue({
    id: TARGET_WORKSPACE,
    name: "Destination",
    slug: "destination",
  });
  db.pageFindMany.mockImplementation(async (args: { where: { workspaceId: string } }) =>
    args.where.workspaceId === SOURCE_WORKSPACE ? sourcePages() : TARGET_PAGES,
  );
  db.memberFindMany.mockImplementation(async (args: { where: { workspaceId: string } }) =>
    args.where.workspaceId === SOURCE_WORKSPACE
      ? [{ userId: "user-1" }, { userId: "user-2" }]
      : [{ userId: "user-1" }],
  );
  access.getWorkspaceAccess.mockResolvedValue({ role: "OWNER" });
  db.transaction.mockImplementation(
    async (fn: (client: unknown) => Promise<unknown>) =>
      fn({
        page: { createMany: tx.pageCreateMany },
        workspaceMember: { createMany: tx.memberCreateMany },
      }),
  );
});

const preview = () =>
  previewWorkspaceMoveAction({ sourcePageId: "p-root", targetWorkspaceId: TARGET_WORKSPACE });

const execute = () =>
  executeWorkspaceMoveAction({ sourcePageId: "p-root", targetWorkspaceId: TARGET_WORKSPACE });

describe("previewWorkspaceMoveAction — plan → UI mapping", () => {
  it("maps the plan digest, warnings and collisions the UI renders", async () => {
    const result = await preview();
    if (!result.ok) throw new Error(result.error);

    expect(result.sourcePageTitle).toBe("Root");
    expect(result.targetName).toBe("Destination");
    expect(result.summary.pageCount).toBe(2);
    expect(result.summary.rootIds).toHaveLength(1);
    expect(result.summary.membershipCount).toBe(1);
    expect(result.summary.warningCount).toBe(1);
    expect(result.summary.warningsByCode).toEqual({ "ref-dangling": 1 });
    expect(result.warnings.map((warning) => warning.code)).toEqual(["ref-dangling"]);
    expect(result.validation).toEqual({ ok: true, errors: [] });
    expect(result.access).toEqual({ allowed: true, reasons: [] });
    expect(result.canConfirm).toBe(true);
  });

  it("surfaces a title collision against the destination", async () => {
    const result = await preview();
    if (!result.ok) throw new Error(result.error);
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0]).toMatchObject({ kind: "title", existingId: "t1", value: "Alpha" });
    // The collision names the incoming page by its new id, not its source id.
    expect(result.collisions[0].incomingId).not.toBe("p-a");
  });

  it("refuses a destination role the policy forbids, without blocking the preview", async () => {
    access.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
    const result = await preview();
    if (!result.ok) throw new Error(result.error);
    expect(result.access.allowed).toBe(false);
    expect(result.access.reasons).toEqual([
      "role MEMBER may not move pages into the target workspace",
    ]);
    expect(result.canConfirm).toBe(false);
  });

  it("refuses a caller with no role in the destination", async () => {
    access.getWorkspaceAccess.mockImplementation(async (_userId: string, workspaceId: string) =>
      workspaceId === SOURCE_WORKSPACE ? { role: "OWNER" } : null,
    );
    const result = await preview();
    if (!result.ok) throw new Error(result.error);
    expect(result.access.reasons).toContain("no role in the target workspace");
    expect(result.canConfirm).toBe(false);
  });

  it("refuses when the source page cannot be found", async () => {
    db.pageFindUnique.mockResolvedValue(null);
    await expect(preview()).resolves.toEqual({ ok: false, error: "Page not found." });
  });

  it("refuses a move into the workspace the page already lives in", async () => {
    await expect(
      previewWorkspaceMoveAction({ sourcePageId: "p-root", targetWorkspaceId: SOURCE_WORKSPACE }),
    ).resolves.toEqual({ ok: false, error: "That page is already in this workspace." });
  });

  it("refuses when the caller cannot edit the source workspace", async () => {
    access.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
    await expect(preview()).resolves.toEqual({
      ok: false,
      error: "You do not have permission to move this page.",
    });
  });

  it("warns about a dropped author and refuses to reuse a missing page id", async () => {
    db.pageFindMany.mockImplementation(async (args: { where: { workspaceId: string } }) =>
      args.where.workspaceId === SOURCE_WORKSPACE
        ? sourcePages().map((page) =>
            page.id === "p-a" ? { ...page, createdById: "ghost-user" } : page,
          )
        : TARGET_PAGES,
    );
    const result = await preview();
    if (!result.ok) throw new Error(result.error);
    expect(
      result.warnings.some(
        (warning) => warning.code === "member-missing" && warning.refId === "ghost-user",
      ),
    ).toBe(true);
    expect(
      result.warnings.some(
        (warning) => warning.code === "ref-dangling" && warning.refId === "p-missing",
      ),
    ).toBe(true);
  });
});

describe("executeWorkspaceMoveAction — ref-remapped write payload", () => {
  it("writes remapped pages and queued memberships in one transaction", async () => {
    const before = JSON.stringify(sourcePages());
    const result = await execute();
    if (!("ok" in result)) throw new Error(result.error);

    expect(result.moved).toBe(2);
    expect(result.memberships).toBe(1);
    expect(result.targetSlug).toBe("destination");
    expect(result.targetPageId).not.toBeNull();

    const data = tx.pageCreateMany.mock.calls[0][0].data as Record<string, unknown>[];
    expect(data).toHaveLength(2);
    for (const row of data) expect(row.workspaceId).toBe(TARGET_WORKSPACE);

    const root = data.find((row) => row.title === "Root");
    const alpha = data.find((row) => row.title === "Alpha");
    if (!root || !alpha) throw new Error("missing planned rows");

    // Parent remap: the moved root is top-level, the child points at the new root.
    expect(root.parentId).toBeNull();
    expect(alpha.parentId).toBe(root.id);
    expect(root.id).not.toBe("p-root");
    expect(alpha.id).not.toBe("p-a");

    // Reference remap: the internal mention → new child, the missing embed dropped.
    const rootContent = root.content as { content: { type: string; attrs: Record<string, unknown> }[] };
    expect(rootContent.content[1].attrs.pageId).toBe(alpha.id);
    expect(rootContent.content[2].attrs.pageId).toBeNull();

    const alphaContent = alpha.content as {
      content: { type: string; attrs: Record<string, unknown> }[];
    };
    expect(alphaContent.content[0].attrs.pageIds).toEqual([root.id]);

    // Authors carried over, never a dangling id.
    expect(root.createdById).toBe("user-2");
    expect(alpha.createdById).toBe("user-2");

    expect(tx.memberCreateMany).toHaveBeenCalledTimes(1);
    expect(tx.memberCreateMany.mock.calls[0][0]).toEqual({
      data: [{ workspaceId: TARGET_WORKSPACE, userId: "user-2", role: "MEMBER" }],
      skipDuplicates: true,
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);

    // The planner is pure: the source rows are untouched.
    expect(JSON.stringify(sourcePages())).toBe(before);
  });

  it("falls back to the acting user when the author is dropped", async () => {
    db.pageFindMany.mockImplementation(async (args: { where: { workspaceId: string } }) =>
      args.where.workspaceId === SOURCE_WORKSPACE
        ? sourcePages().map((page) =>
            page.id === "p-a" ? { ...page, createdById: "ghost-user" } : page,
          )
        : TARGET_PAGES,
    );
    const result = await execute();
    if (!("ok" in result)) throw new Error(result.error);
    const data = tx.pageCreateMany.mock.calls[0][0].data as Record<string, unknown>[];
    const alpha = data.find((row) => row.title === "Alpha");
    expect(alpha?.createdById).toBe("user-1");
  });

  it("refuses a forbidden destination role and writes nothing", async () => {
    access.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
    await expect(execute()).resolves.toEqual({
      error: "role MEMBER may not move pages into the target workspace",
    });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(tx.pageCreateMany).not.toHaveBeenCalled();
  });

  it("refuses a destination with no role and writes nothing", async () => {
    access.getWorkspaceAccess.mockImplementation(async (_userId: string, workspaceId: string) =>
      workspaceId === SOURCE_WORKSPACE ? { role: "OWNER" } : null,
    );
    await expect(execute()).resolves.toEqual({ error: "no role in the target workspace" });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("refuses a read-only source and writes nothing", async () => {
    access.getWorkspaceAccess.mockResolvedValue({ role: "GUEST" });
    await expect(execute()).resolves.toEqual({
      error: "You do not have permission to move this page.",
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
