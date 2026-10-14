import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

/**
 * B67 - restore correctness, M1 slice of docs/specs/version-history-v2.md.
 *
 *  - R30.1: restore must rewrite `Page.searchText` with the same mirror
 *    formula the save path uses (`pageSearchText`, see `pages.ts` /
 *    `page-menu.ts` duplicatePageAction) inside the same `page.update`;
 *    otherwise the restored text stays FTS-invisible until the next edit
 *    (D8 in docs/specs/realtime-collab.md:93-96).
 *  - R30.2: content is written EXPLICITLY - a version snapshotted from an
 *    empty page (`content: null`) must clear the live body (`Prisma.DbNull`)
 *    instead of being silently dropped by `?? undefined`; snapshot + page
 *    update commit in one transaction.
 *  - R30.5: the pre-restore snapshot cites the restored version's own date
 *    (the old code rendered `Date.now()`, i.e. always *today*), stores the
 *    real charDelta (the old code hardcoded 0 and `void`ed the computation),
 *    and dispatches the same `page.updated` webhook as `updatePageAction`.
 *
 * Red-first: written against the pre-fix `restorePageVersionAction` - the
 * tails for each failing assertion are in the B67 batch report.
 */

const db = vi.hoisted(() => ({
  versionFindUnique: vi.fn(),
  versionCreate: vi.fn(),
  pageUpdate: vi.fn(),
  memberFindUnique: vi.fn(),
  workspaceFindUnique: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    pageVersion: {
      findUnique: db.versionFindUnique,
      create: db.versionCreate,
    },
    page: { update: db.pageUpdate },
    workspaceMember: { findUnique: db.memberFindUnique },
    workspace: { findUnique: db.workspaceFindUnique },
    $transaction: db.transaction,
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "user-1" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: vi.fn(async () => undefined) }));

import { revalidatePath } from "next/cache";
import { dispatchWebhooks } from "@/lib/webhooks";
import { pageSearchText } from "@/lib/search";
import { prosemirrorToText } from "@/lib/blocks";
import { restorePageVersionAction } from "./page-versions";

const SNAPSHOT_AT = new Date("2020-05-04T10:30:00.000Z");

function doc(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

const RESTORE_TARGET = doc("Seeded quokka text the mirror must index again.");
const LIVE_BODY = doc("Current live body before the restore.");

/** Seed a version whose author is a MEMBER who may edit. */
function seed(overrides: Record<string, unknown> = {}) {
  db.versionFindUnique.mockResolvedValue({
    id: "ver-1",
    title: "Quokka notes",
    content: RESTORE_TARGET,
    createdAt: SNAPSHOT_AT,
    pageId: "page-1",
    page: { id: "page-1", title: "Live title", content: LIVE_BODY, workspaceId: "ws-1" },
    ...overrides,
  });
  db.memberFindUnique.mockResolvedValue({ role: "MEMBER" });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
  db.versionCreate.mockResolvedValue({ id: "pre-restore-row" });
  db.pageUpdate.mockResolvedValue({ id: "page-1" });
});

describe("restorePageVersionAction (R30.1 / R30.2 / R30.5)", () => {
  it("R30.1 - rewrites searchText with the save-path mirror so restored text is FTS-visible", async () => {
    seed();
    await expect(restorePageVersionAction("ver-1")).resolves.toEqual({ ok: true });

    const { data } = db.pageUpdate.mock.calls[0][0];
    expect(data.searchText).toBe(pageSearchText("Quokka notes", RESTORE_TARGET));
    expect(String(data.searchText)).toContain("quokka");
    expect(data.title).toBe("Quokka notes");
  });

  it("R30.2 - a null-content version clears the live body instead of skipping the field", async () => {
    seed({ content: null });
    await expect(restorePageVersionAction("ver-1")).resolves.toEqual({ ok: true });

    const { data } = db.pageUpdate.mock.calls[0][0];
    expect(data.content).toBe(Prisma.DbNull);
    expect(data.title).toBe("Quokka notes");
  });

  it("R30.2 - pre-restore snapshot and page update commit in ONE transaction", async () => {
    seed();
    await restorePageVersionAction("ver-1");

    expect(db.transaction).toHaveBeenCalledTimes(1);
    const ops = db.transaction.mock.calls[0][0] as unknown[];
    expect(ops).toHaveLength(2);
    expect(db.versionCreate).toHaveBeenCalledTimes(1);
    expect(db.pageUpdate).toHaveBeenCalledTimes(1);
  });

  it("R30.5 - the pre-restore snapshot summary cites the restored version's date, not today", async () => {
    seed();
    await restorePageVersionAction("ver-1");

    const { summary } = db.versionCreate.mock.calls[0][0].data;
    expect(summary).toBe(`Restored the version from ${SNAPSHOT_AT.toLocaleDateString()}`);
    expect(summary).not.toContain(new Date().toLocaleDateString());
  });

  it("R30.5 - stores the real charDelta (post-restore length - pre-restore length)", async () => {
    seed();
    await restorePageVersionAction("ver-1");

    const expected =
      prosemirrorToText(RESTORE_TARGET).length - prosemirrorToText(LIVE_BODY).length;
    expect(expected).not.toBe(0); // fixture sanity: the delta is observable
    expect(db.versionCreate.mock.calls[0][0].data.charDelta).toBe(expected);
    expect(db.versionCreate.mock.calls[0][0].data.createdById).toBe("user-1");
  });

  it("R30.5 - dispatches page.updated once, like updatePageAction", async () => {
    seed();
    await restorePageVersionAction("ver-1");

    expect(dispatchWebhooks).toHaveBeenCalledTimes(1);
    expect(dispatchWebhooks).toHaveBeenCalledWith("ws-1", "page.updated", { pageId: "page-1" });
    expect(revalidatePath).toHaveBeenCalledWith("/w", "layout");
  });

  it("denies a guest without touching the page (non-regression pin)", async () => {
    seed();
    db.memberFindUnique.mockResolvedValue({ role: "GUEST" });
    await expect(restorePageVersionAction("ver-1")).resolves.toEqual({
      error: "You do not have permission to restore this page.",
    });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.pageUpdate).not.toHaveBeenCalled();
  });

  it("returns the generic not-found error for a missing version (non-regression pin)", async () => {
    seed();
    db.versionFindUnique.mockResolvedValue(null);
    await expect(restorePageVersionAction("nope")).resolves.toEqual({
      error: "Version not found.",
    });
    expect(db.pageUpdate).not.toHaveBeenCalled();
  });
});
