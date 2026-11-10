import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P3-T06 (F10) — a board drop only steers a column's order from rows of that
 * column.
 *
 * The board computes the drop target from the rendered page: "insert before the
 * first card of the drop column whose midpoint is below the pointer". So the
 * `beforeId` it sends is a row of the destination column — as rendered. A stale
 * page (the named card was moved to another column after the snapshot) or a
 * client that ignores the contract leaves `before` in another column, and its
 * position then steered the destination column's order against the board's
 * `(position asc, id asc)` sort: a ticket dropped above such a row could land
 * in the middle of the column or below every card instead of where it was
 * dropped.
 *
 * The move now slots against the destination column's first row when the
 * before row lives in another column — the drop reads as "at the top of the
 * column as it stands now" — and appends when the column is empty. Same-column
 * drops keep taking `before.position - 1`.
 *
 * Only the database edge and the auth/permission edges are mocked, with a
 * tiny in-memory store so `findFirst` honours the board's ordering; the
 * action's logic runs for real.
 */

const db = vi.hoisted(() => {
  type Row = { id: string; workspaceId: string; status: string; position: number };
  const rows: Row[] = [];
  const updates: Array<{
    where: { id: string };
    data: { status: string; position: number; completedAt: Date | null };
  }> = [];

  return {
    rows,
    updates,
    ticket: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        rows.find((row) => row.id === where.id) ?? null,
      ),
      findFirst: vi.fn(
        async (args: {
          where?: { workspaceId?: string; status?: string };
          orderBy?: unknown;
          select?: Record<string, boolean>;
        }) => {
          const matched = rows.filter(
            (row) =>
              (!args.where?.workspaceId || row.workspaceId === args.where.workspaceId) &&
              (!args.where?.status || row.status === args.where.status),
          );
          const byBoardTuple = (a: Row, b: Row) =>
            a.position - b.position || a.id.localeCompare(b.id);
          return matched.sort(
            Array.isArray(args.orderBy)
              ? byBoardTuple
              : (a: Row, b: Row) => b.position - a.position,
          )[0] ?? null;
        },
      ),
      update: vi.fn(async (args: { where: { id: string } }) => {
        updates.push(args as never);
        return { id: args.where.id };
      }),
    },
    ticketActivity: { create: vi.fn(async () => ({ id: "a1" })) },
  };
});

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "actor-1" })) }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: vi.fn(async () => ({ role: "MEMBER" })),
  canEditContent: (role: string) => role !== "GUEST",
  canManageMembers: () => false,
}));
vi.mock("@/server/actions/notifications", () => ({ notifyTicketAssigned: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { moveTicketAction } from "./tickets";

/** The dragged ticket: dragged out of `in_progress`, dropped onto `todo`. */
const DRAGGED = { id: "t-a", workspaceId: "ws1", status: "in_progress", position: 1000 };

/** Cards of the destination column `todo`, in board order. */
const TODO_HEAD = { id: "t-w", workspaceId: "ws1", status: "todo", position: 1000 };
const TODO_NEXT = { id: "t-u", workspaceId: "ws1", status: "todo", position: 2000 };

/** The card the stale page rendered in `todo`; its row left for another column. */
const STALE_BEFORE = { id: "t-b", workspaceId: "ws1", status: "in_progress", position: 2000 };

beforeEach(() => {
  db.rows.length = 0;
  db.updates.length = 0;
  db.ticketActivity.create.mockClear();
});

const written = () => db.updates.findLast(() => true);

describe("moveTicketAction — a drop above a row of the wrong column", () => {
  it("slots against the destination column's first row, not the stale row", async () => {
    // Column `todo` stands at head `t-w`@1000, then `t-u`@2000; the stale row
    // sits at 2000 of `in_progress` — the old code wrote 2000 - 1 = 1999, which
    // slid between `t-w` and `t-u` instead of reading as the drop: above `t-w`.
    db.rows.push(DRAGGED, TODO_HEAD, TODO_NEXT, STALE_BEFORE);

    await expect(
      moveTicketAction({ ticketId: "t-a", status: "todo", beforeId: "t-b" }),
    ).resolves.toEqual({ ok: true });

    expect(written()).toMatchObject({
      where: { id: "t-a" },
      data: { status: "todo", position: 999, completedAt: null },
    });
    // The destination column, sorted by the board's (position, id) tuple, has
    // the dragged card at the top — immediately above the card it dropped on,
    // and its position derives only from `todo`'s own rows.
    const todo = db.rows
      .filter((row) => row.status === "todo" && row.id !== "t-a")
      .map((row) => ({ id: row.id, position: row.position }));
    todo.push({ id: "t-a", position: 999 });
    todo.sort((x, y) => x.position - y.position || x.id.localeCompare(y.id));
    expect(todo.map((row) => row.id)).toEqual(["t-a", "t-w", "t-u"]);
  });

  it("appends to an empty destination column", async () => {
    // The drop names a row of another column; `todo` holds no rows, so the
    // column's base slot applies.
    db.rows.push(DRAGGED, STALE_BEFORE);

    await expect(
      moveTicketAction({ ticketId: "t-a", status: "todo", beforeId: "t-b" }),
    ).resolves.toEqual({ ok: true });

    expect(written()).toMatchObject({
      where: { id: "t-a" },
      data: { status: "todo", position: 1000, completedAt: null },
    });
  });

  it("keeps taking the position of a before row of the destination column", async () => {
    // Same contract as before the fix: the named row belongs to `todo`, so the
    // slot stays `before.position - 1` and nothing is recomputed.
    db.rows.push(
      { id: "t-a", workspaceId: "ws1", status: "todo", position: 1000 },
      TODO_HEAD,
      { ...TODO_NEXT, id: "t-u", position: 3000 },
    );

    await expect(
      moveTicketAction({ ticketId: "t-a", status: "todo", beforeId: "t-u" }),
    ).resolves.toEqual({ ok: true });

    expect(written()).toMatchObject({
      where: { id: "t-a" },
      data: { status: "todo", position: 2999, completedAt: null },
    });
  });

  it("still appends when the drop names no row at all", async () => {
    db.rows.push(DRAGGED, TODO_HEAD);

    await expect(moveTicketAction({ ticketId: "t-a", status: "todo" })).resolves.toEqual({
      ok: true,
    });

    expect(written()).toMatchObject({
      where: { id: "t-a" },
      data: { status: "todo", position: 2000, completedAt: null },
    });
  });
});
