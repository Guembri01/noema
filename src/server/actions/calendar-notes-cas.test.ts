import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P2-T03 — `createMeetingNoteAction` claims `calendarEvent.notesPageId` via a
 * compare-and-swap, not an unconditional update: two concurrent accepts of an
 * event with `notesPageId: null` used to BOTH create a notes page and the
 * second `calendarEvent.update` blindly overwrite, leaving an orphan
 * duplicate page row.
 *
 * Mechanic: create-then-CAS inside one interactive `$transaction` —
 *   1. create the caller's candidate page,
 *   2. `calendarEvent.updateMany({ where: { id, notesPageId: null },
 *      data: { notesPageId: page.id } })` — the claim value IS the new page
 *      id, so page-first beats placeholder claim-first: one atomic
 *      updateMany and no temporary token,
 *   3. `count === 0` ⇒ someone else claimed: the loser deletes its candidate
 *      page INSIDE the same transaction and reuses the winner's page id.
 *
 * The fake prisma models PrismaPromise semantics (a write executes on first
 * await) with a commit ledger grouped per transaction. Interactive
 * `$transaction`s are entry-queued (serialized) so the winner/loser ordering
 * is deterministic, while both racing calls still observe
 * `notesPageId: null` on their pre-transaction read — the exact race window
 * under test. A rejected transaction discards its buffer (rollback).
 */

const state = vi.hoisted(() => {
  type Args = { where: unknown; data?: unknown };
  type Entry = { op: string; args: Args };

  const behavior = {
    calendarEventFindUnique: vi.fn(),
    calendarEventUpdateMany: vi.fn(),
    pageFindUnique: vi.fn(),
    pageFindFirst: vi.fn(),
    pageCreate: vi.fn(),
    pageDelete: vi.fn(),
    workspaceFindUnique: vi.fn(),
    revalidatePath: vi.fn(),
  };

  /** Committed ops, grouped per transaction (single ops get their own group). */
  const txLog: Entry[][] = [];
  /** Buffer of the transaction currently open. */
  let pending: Entry[] = [];
  let inTransaction = false;
  /** Entry queue so overlapping transactions commit their own group. */
  let chain: Promise<unknown> = Promise.resolve();

  /** Emulate a `PrismaPromise`: the write runs on first await, not on call. */
  const trackedWrite = (op: string, mock: (args: Args) => Promise<unknown>) =>
    (args: Args) => {
      let started: Promise<unknown> | null = null;
      return {
        then(
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) {
          started ??= (async () => {
            const result = await mock(args);
            if (inTransaction) pending.push({ op, args });
            else txLog.push([{ op, args }]);
            return result;
          })();
          return started.then(onFulfilled, onRejected);
        },
      };
    };

  const prisma = {
    calendarEvent: {
      findUnique: behavior.calendarEventFindUnique,
      updateMany: trackedWrite("calendarEvent.updateMany", behavior.calendarEventUpdateMany),
    },
    page: {
      findUnique: behavior.pageFindUnique,
      findFirst: behavior.pageFindFirst,
      create: trackedWrite("page.create", behavior.pageCreate),
      delete: trackedWrite("page.delete", behavior.pageDelete),
    },
    workspace: { findUnique: behavior.workspaceFindUnique },
    $transaction: (arg: unknown) => {
      if (typeof arg !== "function") {
        throw new Error("array-form $transaction not supported in this test");
      }
      chain = chain.then(async () => {
        inTransaction = true;
        pending = [];
        try {
          const result = await (arg as (tx: unknown) => Promise<unknown>)(
            prisma,
          );
          txLog.push(pending);
          pending = [];
          return result;
        } catch (error) {
          // Rollback: the buffered writes are discarded.
          pending = [];
          throw error;
        } finally {
          inTransaction = false;
        }
      });
      return chain;
    },
  };

  const reset = () => {
    txLog.length = 0;
    pending = [];
    inTransaction = false;
    chain = Promise.resolve();
  };

  return { behavior, prisma, txLog, reset };
});

vi.mock("@/lib/db", () => ({ prisma: state.prisma }));

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "u-1" })),
}));

vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: vi.fn(async () => ({ role: "MEMBER" })),
  canEditContent: vi.fn(() => true),
}));

vi.mock("next/cache", () => ({
  revalidatePath: state.behavior.revalidatePath,
}));

import { createMeetingNoteAction } from "./calendar";
import { requireUser } from "@/lib/auth";
import { getWorkspaceAccess, canEditContent } from "@/lib/permissions";

const EVENT = {
  id: "evt-1",
  workspaceId: "ws-1",
  title: "Weekly sync",
  notesPageId: null as string | null,
  start: new Date("2026-01-15T09:00:00Z"),
};

beforeEach(() => {
  // reset (not clear): mockClear keeps leftover `mockResolvedValueOnce`
  // queues, which would leak the race test's scripted claims into the
  // uncontended tests.
  vi.resetAllMocks();
  state.reset();

  (requireUser as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "u-1" });
  (getWorkspaceAccess as ReturnType<typeof vi.fn>).mockResolvedValue({
    role: "MEMBER",
  });
  (canEditContent as ReturnType<typeof vi.fn>).mockReturnValue(true);

  state.behavior.calendarEventFindUnique.mockResolvedValue(EVENT);
  state.behavior.pageFindFirst.mockResolvedValue({ position: 0 });
  state.behavior.pageCreate.mockResolvedValue({ id: "page-1" });
  state.behavior.calendarEventUpdateMany.mockResolvedValue({ count: 1 });
  state.behavior.pageDelete.mockResolvedValue({});
  state.behavior.workspaceFindUnique.mockResolvedValue({ slug: "ws" });
  state.behavior.pageFindUnique.mockResolvedValue({
    id: "page-9",
    deletedAt: null,
  });
});

const committedOps = (op: string): Array<Record<string, unknown>> =>
  state.txLog
    .flat()
    .filter((entry) => entry.op === op)
    .map((entry) => entry.args as Record<string, unknown>);

const opTypeNames = (op: string): string =>
  state.txLog
    .map((tx) => tx.map((e) => e.op).sort().join("+"))
    .filter((joined) => joined.split("+").includes(op))
    .sort()
    .join(",");

describe("createMeetingNoteAction — notesPageId CAS (P2-T03)", () => {
  it("two concurrent accepts of a null notesPageId: winner claims, loser deletes its page and reuses the winner's — exactly one page row", async () => {
    // Both racing calls read the event BEFORE either claims: null for both.
    state.behavior.pageCreate
      .mockResolvedValueOnce({ id: "page-winner" })
      .mockResolvedValueOnce({ id: "page-loser" });
    state.behavior.calendarEventUpdateMany
      .mockResolvedValueOnce({ count: 1 }) // winner wins the claim
      .mockResolvedValueOnce({ count: 0 }); // loser lost the race
    // The loser's re-read after losing sees the winner's claim on the event.
    // The re-read selects ONLY `notesPageId`; the initial read also selects
    // `id`, so `select.id === undefined` discriminates the two.
    state.behavior.calendarEventFindUnique.mockImplementation(
      (args: { select?: { id?: boolean } }) =>
        args?.select?.id === undefined
          ? Promise.resolve({ notesPageId: "page-winner" })
          : Promise.resolve(EVENT),
    );

    const [winner, loser] = await Promise.all([
      createMeetingNoteAction("evt-1"),
      createMeetingNoteAction("evt-1"),
    ]);

    expect(winner).toEqual({
      ok: true,
      id: "page-winner",
      slug: "ws",
      existing: false,
    });
    expect(loser).toEqual({
      ok: true,
      id: "page-winner",
      slug: "ws",
      existing: true,
    });

    // The claim is a conditional updateMany against `notesPageId: null`,
    // never an unconditional update.
    const claims = committedOps("calendarEvent.updateMany") as Array<{
      where: { id: string; notesPageId: string | null };
      data: { notesPageId: string };
    }>;
    expect(claims).toHaveLength(2);
    for (const claim of claims) {
      expect(claim.where).toEqual({ id: "evt-1", notesPageId: null });
    }
    expect(claims.map((c) => c.data.notesPageId)).toEqual(
      expect.arrayContaining(["page-winner", "page-loser"]),
    );

    // Two candidate pages were created; the loser's was deleted INSIDE its
    // transaction. Net: exactly one page row survives.
    expect(committedOps("page.create")).toHaveLength(2);
    const deletes = committedOps("page.delete") as Array<{
      where: { id: string };
    }>;
    expect(deletes).toEqual([{ where: { id: "page-loser" } }]);

    // Two transactions total: winner = create+claim, loser = create+claim+delete.
    expect(state.txLog).toHaveLength(2);
    expect(opTypeNames("calendarEvent.updateMany")).toBe(
      "calendarEvent.updateMany+page.create," +
        "calendarEvent.updateMany+page.create+page.delete",
    );
  });

  it("uncontended accept claims inside one transaction and keeps the revalidate hook", async () => {
    const result = await createMeetingNoteAction("evt-1");

    expect(result).toEqual({ ok: true, id: "page-1", slug: "ws", existing: false });
    expect(state.txLog.map((tx) => tx.map((e) => e.op))).toEqual([
      ["page.create", "calendarEvent.updateMany"],
    ]);
    expect(committedOps("calendarEvent.updateMany")[0]).toEqual({
      where: { id: "evt-1", notesPageId: null },
      data: { notesPageId: "page-1" },
    });
    expect(committedOps("page.delete")).toHaveLength(0);
    expect(state.behavior.revalidatePath).toHaveBeenCalledWith("/w", "layout");
  });

  it("an event that already has a live notes page is opened without any write", async () => {
    state.behavior.calendarEventFindUnique.mockResolvedValue({
      ...EVENT,
      notesPageId: "page-9",
    });

    const result = await createMeetingNoteAction("evt-1");

    expect(result).toEqual({ ok: true, id: "page-9", slug: "ws", existing: true });
    expect(committedOps("page.create")).toHaveLength(0);
    expect(state.txLog).toHaveLength(0);
  });

  it("callers who cannot edit content never reach the claim", async () => {
    (canEditContent as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const result = await createMeetingNoteAction("evt-1");

    expect(result).toEqual({ error: "You do not have permission to create a page." });
    expect(committedOps("page.create")).toHaveLength(0);
    expect(committedOps("calendarEvent.updateMany")).toHaveLength(0);
  });
});
