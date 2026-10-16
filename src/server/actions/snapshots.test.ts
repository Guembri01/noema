import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wiring coverage for `src/server/actions/snapshots.ts` — the action layer over
 * the pure `src/lib/page-snapshots.ts` engine: create + dedupe (equal content
 * hash ⇒ no row), deduping a list of decoded rows, and restore planning /
 * application. Prisma, the session and `next/cache` are the only mocked edges;
 * permissions, the engine and the document mapping run for real.
 */

const db = vi.hoisted(() => ({
  pageFindUnique: vi.fn(),
  versionFindUnique: vi.fn(),
  versionFindFirst: vi.fn(),
  versionFindMany: vi.fn(),
  versionCreate: vi.fn(),
  pageUpdate: vi.fn(),
  memberFindUnique: vi.fn(),
  workspaceFindUnique: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    page: { findUnique: db.pageFindUnique, update: db.pageUpdate },
    pageVersion: {
      findUnique: db.versionFindUnique,
      findFirst: db.versionFindFirst,
      findMany: db.versionFindMany,
      create: db.versionCreate,
    },
    workspaceMember: { findUnique: db.memberFindUnique },
    workspace: { findUnique: db.workspaceFindUnique },
    $transaction: db.transaction,
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "user-1" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  createPageSnapshotAction,
  listPageSnapshotsAction,
  planPageSnapshotRestoreAction,
  restorePageSnapshotAction,
} from "./snapshots";

const block = (id: string, text: string) => ({
  type: "paragraph",
  attrs: { id },
  content: [{ type: "text", text }],
});
const doc = (...nodes: unknown[]) => ({ type: "doc", content: nodes });

const ALPHA = doc(block("a", "Alpha"));
const BETA = doc(block("a", "Alpha NEW"), block("b", "Beta"));

beforeEach(() => {
  vi.clearAllMocks();
  db.memberFindUnique.mockResolvedValue({ role: "MEMBER" });
  db.workspaceFindUnique.mockResolvedValue(null);
  db.transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
  db.versionCreate.mockResolvedValue({ id: "snap-new" });
  db.pageUpdate.mockResolvedValue({ id: "page-1" });
});

describe("createPageSnapshotAction", () => {
  it("dedupes an unnamed snapshot whose hash matches the newest row", async () => {
    db.pageFindUnique.mockResolvedValue({
      id: "page-1",
      title: "Notes",
      content: ALPHA,
      workspaceId: "ws-1",
      locked: false,
    });
    db.versionFindFirst.mockResolvedValue({
      id: "snap-1",
      pageId: "page-1",
      title: "Notes",
      content: ALPHA,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      label: null,
      createdById: "user-1",
    });

    const result = await createPageSnapshotAction("page-1");
    expect(result).toMatchObject({ ok: true, id: "snap-1", deduped: true });
    expect(db.versionCreate).not.toHaveBeenCalled();
  });

  it("persists a changed page and reports the new snapshot", async () => {
    db.pageFindUnique.mockResolvedValue({
      id: "page-1",
      title: "Notes",
      content: BETA,
      workspaceId: "ws-1",
      locked: false,
    });
    db.versionFindFirst.mockResolvedValue({
      id: "snap-1",
      pageId: "page-1",
      title: "Notes",
      content: ALPHA,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      label: null,
      createdById: "user-1",
    });

    const result = await createPageSnapshotAction("page-1", { label: "Release v1" });
    expect(result).toMatchObject({ ok: true, id: "snap-new", deduped: false });
    expect(db.versionCreate).toHaveBeenCalledWith({
      data: {
        pageId: "page-1",
        title: "Notes",
        content: BETA,
        createdById: "user-1",
        label: "Release v1",
        summary: expect.stringContaining("Release v1"),
      },
      select: { id: true },
    });
  });

  it("a named snapshot is an explicit bookmark and always persists", async () => {
    db.pageFindUnique.mockResolvedValue({
      id: "page-1",
      title: "Notes",
      content: ALPHA,
      workspaceId: "ws-1",
      locked: false,
    });

    const result = await createPageSnapshotAction("page-1", { label: "Bookmark" });
    expect(result).toMatchObject({ ok: true, deduped: false });
    expect(db.versionFindFirst).not.toHaveBeenCalled();
    expect(db.versionCreate).toHaveBeenCalledTimes(1);
  });

  it("denies a guest before writing anything", async () => {
    db.pageFindUnique.mockResolvedValue({
      id: "page-1",
      title: "Notes",
      content: ALPHA,
      workspaceId: "ws-1",
      locked: false,
    });
    db.memberFindUnique.mockResolvedValue({ role: "GUEST" });

    await expect(createPageSnapshotAction("page-1")).resolves.toEqual({
      error: "You do not have permission to snapshot this page.",
    });
    expect(db.versionCreate).not.toHaveBeenCalled();
  });
});

describe("listPageSnapshotsAction", () => {
  it("collapses consecutive equal hashes to the newest record", async () => {
    db.pageFindUnique.mockResolvedValue({ workspaceId: "ws-1" });
    db.versionFindMany.mockResolvedValue([
      {
        id: "s2",
        pageId: "page-1",
        title: "Notes",
        content: ALPHA,
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
        label: null,
        createdById: "user-1",
      },
      {
        id: "s1",
        pageId: "page-1",
        title: "Notes",
        content: ALPHA,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        label: null,
        createdById: "user-1",
      },
      {
        id: "s0",
        pageId: "page-1",
        title: "Notes",
        content: BETA,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        label: null,
        createdById: "user-1",
      },
    ]);

    const result = await listPageSnapshotsAction("page-1");
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.snapshots.map((snapshot) => snapshot.id)).toEqual(["s2", "s0"]);
  });
});

describe("restore planning and application", () => {
  beforeEach(() => {
    db.versionFindUnique.mockResolvedValue({
      id: "snap-a",
      pageId: "page-1",
      title: "Snapshot title",
      content: doc(block("a", "Alpha NEW")),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      label: "Alpha",
      createdById: "user-1",
      page: {
        workspaceId: "ws-1",
        title: "Live title",
        content: doc(block("a", "Alpha OLD"), block("b", "Beta")),
        locked: false,
      },
    });
  });

  it("plans the id-preserving patch that a restore would write", async () => {
    const plan = await planPageSnapshotRestoreAction("snap-a");
    expect(plan).toMatchObject({ ok: true, pageId: "page-1", snapshotId: "snap-a", title: "Snapshot title" });
    if ("error" in plan) return;
    expect(plan.added).toEqual([]);
    expect(plan.changed).toEqual(["a"]);
    expect(plan.removed).toEqual(["b"]);
  });

  it("applies the restore as one transaction (pre-restore snapshot + page write)", async () => {
    const result = await restorePageSnapshotAction("snap-a");
    expect(result).toMatchObject({ ok: true, changed: 1, removed: 1, restored: 1 });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.versionCreate).toHaveBeenCalledTimes(1);
    expect(db.pageUpdate).toHaveBeenCalledTimes(1);

    const { data } = db.pageUpdate.mock.calls[0][0];
    expect(data.title).toBe("Snapshot title");
    expect(data.content).toEqual(doc(block("a", "Alpha NEW")));
    expect(String(data.searchText)).toContain("Alpha NEW");
  });

  it("refuses to restore onto a locked page a member may not edit", async () => {
    db.versionFindUnique.mockResolvedValue({
      id: "snap-a",
      pageId: "page-1",
      title: "Snapshot title",
      content: ALPHA,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      label: null,
      createdById: "user-1",
      page: { workspaceId: "ws-1", title: "Live", content: BETA, locked: true },
    });

    await expect(restorePageSnapshotAction("snap-a")).resolves.toEqual({
      error: "This page is locked. Unlock it to restore a snapshot.",
    });
    expect(db.pageUpdate).not.toHaveBeenCalled();
  });

  it("returns the generic not-found error for a missing snapshot", async () => {
    db.versionFindUnique.mockResolvedValue(null);
    await expect(planPageSnapshotRestoreAction("nope")).resolves.toEqual({
      error: "Snapshot not found.",
    });
  });
});
