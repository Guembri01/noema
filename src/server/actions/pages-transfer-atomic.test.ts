import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P2-T02 — `transferPageAction` must move the subtree and re-parent the root
 * as one atomic unit: a subtree that switched workspaces while the root
 * re-parenting failed leaves cross-workspace orphaned children, so both
 * writes run inside a single `$transaction([...])`.
 *
 * The fake prisma models real commit semantics: writes awaited against the
 * global client land in the ledger immediately (auto-commit), while writes
 * passed through the array form of `$transaction` are buffered and only
 * enter the ledger when the whole transaction resolves — a rejection
 * discards the buffer, i.e. nothing survives a rollback. Writes execute on
 * first await (like a `PrismaPromise`), so array members stay unexecuted
 * until the transaction runs them.
 */

const state = vi.hoisted(() => {
  const behavior = {
    pageFindUnique: vi.fn(),
    pageFindMany: vi.fn(),
    pageUpdateMany: vi.fn(),
    pageUpdate: vi.fn(),
  };

  /** Op names that reached a commit. */
  const committed: string[] = [];
  /** Op names buffered inside an open transaction, not yet committed. */
  const pending: string[] = [];
  /** True while a `$transaction` is open: member writes buffer, not commit. */
  let inTransaction = false;

  type Args = { where: unknown; data?: unknown };

  /** Emulate a `PrismaPromise`: the write runs on first await, not on call. */
  const prismaPromise = (run: () => Promise<string>) => {
    let started: Promise<string> | null = null;
    return {
      then(
        onFulfilled?: (value: string) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        started ??= run();
        return started.then(onFulfilled, onRejected);
      },
    };
  };

  const trackedWrite =
    (op: string, mock: (typeof behavior)["pageUpdateMany"]) =>
    (args: Args) =>
      prismaPromise(async () => {
        const result = await mock(args);
        (inTransaction ? pending : committed).push(op);
        return result;
      });

  const prisma = {
    page: {
      findUnique: behavior.pageFindUnique,
      findMany: behavior.pageFindMany,
      updateMany: trackedWrite("page.updateMany", behavior.pageUpdateMany),
      update: trackedWrite("page.update", behavior.pageUpdate),
    },
    $transaction: async (
      arg: unknown[] | ((tx: unknown) => Promise<unknown>),
    ) => {
      if (Array.isArray(arg)) {
        inTransaction = true;
        pending.length = 0;
        try {
          const results = await Promise.all(arg);
          committed.push(...pending);
          pending.length = 0;
          return results;
        } catch (error) {
          // Rollback: the buffered writes are discarded.
          pending.length = 0;
          throw error;
        } finally {
          inTransaction = false;
        }
      }
      const result = await (arg as (tx: unknown) => Promise<unknown>)(prisma);
      committed.push(...pending);
      pending.length = 0;
      return result;
    },
  };

  return { behavior, prisma, committed, pending };
});

vi.mock("@/lib/db", () => ({ prisma: state.prisma }));

vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "user-1" }),
}));

vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: async () => ({ role: "MEMBER" }),
  canEditContent: () => true,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn() }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhooks: vi.fn() }));

import { transferPageAction } from "./pages";

const PAGE = {
  id: "page-1",
  workspaceId: "ws-1",
  parentId: null,
  deletedAt: null,
  parent: null,
  permissions: [],
};

const SUBTREE = [
  { id: "page-1", parentId: null },
  { id: "page-1-child-a", parentId: "page-1" },
  { id: "page-1-child-b", parentId: "page-1" },
];

beforeEach(() => {
  vi.clearAllMocks();
  state.committed.length = 0;
  state.pending.length = 0;

  state.behavior.pageFindUnique.mockResolvedValue(PAGE);
  state.behavior.pageFindMany.mockResolvedValue(SUBTREE);
  state.behavior.pageUpdateMany.mockResolvedValue({ count: SUBTREE.length });
  state.behavior.pageUpdate.mockResolvedValue({});
});

describe("transferPageAction — subtree transfer atomicity (P2-T02)", () => {
  it("rolls back both writes when the re-parent fails after the subtree update", async () => {
    state.behavior.pageUpdate.mockRejectedValueOnce(
      new Error("re-parent failure"),
    );

    await expect(transferPageAction("page-1", "ws-2")).rejects.toThrow(
      "re-parent failure",
    );

    // The subtree must not be stranded in ws-2: neither write survived.
    expect(state.committed).toEqual([]);
  });

  it("commits the subtree update and the root re-parent together, in order", async () => {
    const result = await transferPageAction("page-1", "ws-2");

    expect(result).toEqual({ ok: true });
    expect(state.committed).toEqual(["page.updateMany", "page.update"]);
    expect(state.behavior.pageUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["page-1", "page-1-child-a", "page-1-child-b"] } },
      data: { workspaceId: "ws-2" },
    });
    expect(state.behavior.pageUpdate).toHaveBeenCalledWith({
      where: { id: "page-1" },
      data: { parentId: null },
    });
  });
});
