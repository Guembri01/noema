import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `archiveTicketAction` / `restoreTicketAction` — the soft-delete pair behind
 * the archive view. The write must be gated exactly like every other ticket
 * write (`authorizeTicket` → `canEditContent`) and must be idempotent, so a
 * retry never flip-flops the ticket or spams the activity trail.
 *
 * `getArchivedTickets` — the one query that deliberately reads `archived: true`.
 * The board/list/timeline all filter `archived: false`, so this file pins the
 * other half of that contract.
 *
 * Only prisma, auth, permissions, the queries module and the cache are mocked;
 * the actions' branching runs for real.
 */

const db = vi.hoisted(() => ({
  ticketFindUnique: vi.fn(),
  ticketUpdate: vi.fn(),
  ticketFindMany: vi.fn(),
  activityCreate: vi.fn(),
}));
const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
const perm = vi.hoisted(() => ({
  getWorkspaceAccess: vi.fn(),
  canEditContent: vi.fn(),
  canManageMembers: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    ticket: {
      findUnique: db.ticketFindUnique,
      update: db.ticketUpdate,
      findMany: db.ticketFindMany,
    },
    ticketActivity: { create: db.activityCreate },
  },
}));
vi.mock("@/lib/auth", () => ({ requireUser: auth.requireUser }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: perm.getWorkspaceAccess,
  canEditContent: perm.canEditContent,
  canManageMembers: perm.canManageMembers,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/queries", () => ({ getTicketDetail: vi.fn(), getTicketsPage: vi.fn() }));

import { archiveTicketAction, restoreTicketAction } from "./tickets";
import { getArchivedTickets } from "@/server/ticket-archive";

/** A ticket mid-archive; individual tests override `archived`. */
const TICKET = {
  id: "t1",
  workspaceId: "ws1",
  status: "todo",
  title: "Broken login",
  key: "WS-1",
  archived: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUser.mockResolvedValue({ id: "u1" });
  perm.getWorkspaceAccess.mockResolvedValue({ role: "MEMBER" });
  perm.canEditContent.mockReturnValue(true);
});

describe("restoreTicketAction", () => {
  it("refuses a caller without edit rights (no write, no activity)", async () => {
    perm.canEditContent.mockReturnValue(false);
    db.ticketFindUnique.mockResolvedValue(TICKET);

    await expect(restoreTicketAction("t1")).resolves.toEqual({
      error: "You do not have permission to edit tickets.",
    });
    expect(db.ticketUpdate).not.toHaveBeenCalled();
    expect(db.activityCreate).not.toHaveBeenCalled();
  });

  it("reports a missing ticket", async () => {
    db.ticketFindUnique.mockResolvedValue(null);

    await expect(restoreTicketAction("missing")).resolves.toEqual({
      error: "Ticket not found.",
    });
    expect(db.ticketUpdate).not.toHaveBeenCalled();
  });

  it("un-archives an archived ticket and logs a `restored` row", async () => {
    db.ticketFindUnique.mockResolvedValue(TICKET);

    await expect(restoreTicketAction("t1")).resolves.toEqual({ ok: true });
    expect(db.ticketUpdate).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { archived: false },
    });
    expect(db.activityCreate).toHaveBeenCalledWith({
      data: { ticketId: "t1", actorId: "u1", kind: "restored", detail: undefined },
    });
  });

  it("is idempotent: restoring a live ticket writes nothing", async () => {
    db.ticketFindUnique.mockResolvedValue({ ...TICKET, archived: false });

    await expect(restoreTicketAction("t1")).resolves.toEqual({ ok: true });
    expect(db.ticketUpdate).not.toHaveBeenCalled();
    expect(db.activityCreate).not.toHaveBeenCalled();
  });
});

describe("archiveTicketAction", () => {
  it("archives a live ticket", async () => {
    db.ticketFindUnique.mockResolvedValue({ ...TICKET, archived: false });

    await expect(archiveTicketAction("t1")).resolves.toEqual({ ok: true });
    expect(db.ticketUpdate).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { archived: true },
    });
    expect(db.activityCreate).toHaveBeenCalledWith({
      data: { ticketId: "t1", actorId: "u1", kind: "archived", detail: undefined },
    });
  });

  it("is idempotent: re-archiving an archived ticket writes nothing", async () => {
    db.ticketFindUnique.mockResolvedValue(TICKET);

    await expect(archiveTicketAction("t1")).resolves.toEqual({ ok: true });
    expect(db.ticketUpdate).not.toHaveBeenCalled();
    expect(db.activityCreate).not.toHaveBeenCalled();
  });
});

describe("getArchivedTickets", () => {
  it("reads only archived rows for the requested workspace", async () => {
    db.ticketFindMany.mockResolvedValue([]);

    await expect(getArchivedTickets("ws1")).resolves.toEqual([]);
    expect(db.ticketFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws1", archived: true } }),
    );
  });

  it("uses the latest `archived` activity for who/when", async () => {
    const at = new Date("2026-02-02T10:00:00.000Z");
    db.ticketFindMany.mockResolvedValue([
      {
        id: "t1",
        key: "WS-1",
        title: "Broken login",
        status: "todo",
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        activity: [{ createdAt: at, actor: { name: "Demo User" } }],
      },
    ]);

    await expect(getArchivedTickets("ws1")).resolves.toEqual([
      {
        id: "t1",
        key: "WS-1",
        title: "Broken login",
        status: "todo",
        archivedAt: at,
        archivedByName: "Demo User",
      },
    ]);
  });

  it("falls back to updatedAt and an unknown actor without a trail", async () => {
    const updatedAt = new Date("2026-03-03T00:00:00.000Z");
    db.ticketFindMany.mockResolvedValue([
      { id: "t1", key: "WS-1", title: "T", status: "done", updatedAt, activity: [] },
    ]);

    await expect(getArchivedTickets("ws1")).resolves.toEqual([
      {
        id: "t1",
        key: "WS-1",
        title: "T",
        status: "done",
        archivedAt: updatedAt,
        archivedByName: null,
      },
    ]);
  });
});
