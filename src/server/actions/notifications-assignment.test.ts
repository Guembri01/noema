import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePrefs } from "@/lib/notification-prefs-engine";

/**
 * Ticket assignment dispatch — "why doesn't the assignee hear anything?".
 *
 * The assignment paths wrote `assigneeId` and an activity row and stopped there,
 * so a person could be handed a ticket with no inbox row at all. `notifyTicketAssigned`
 * is the missing dispatch, and it is deliberately state-checked rather than
 * argument-trusted: it re-derives the actor, re-reads the tickets from the
 * database (scoped to the workspace) and only describes tickets that are
 * *currently* assigned to the target.
 *
 * These tests pin that contract, the recipient decision (`resolveRecipients` +
 * the assignee's own prefs, run for real) and the never-throw guarantee. Only the
 * transport edges (prisma/auth/permissions/cache) are mocked.
 */

const ACTOR = "author";
const ASSIGNEE = "worker";
const WORKSPACE = "ws-1";
const TICKET = "ticket-1";

const db = vi.hoisted(() => ({
  ticketFindMany: vi.fn(),
  userFindUnique: vi.fn(),
  notificationCreateMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    ticket: { findMany: db.ticketFindMany },
    user: { findUnique: db.userFindUnique },
    notification: { createMany: db.notificationCreateMany },
  },
}));

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "author" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const perms = vi.hoisted(() => ({ getWorkspaceAccess: vi.fn() }));
vi.mock("@/lib/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/permissions")>();
  return { ...actual, getWorkspaceAccess: perms.getWorkspaceAccess };
});

import { notifyTicketAssigned } from "./notifications";

/** The payload of the single `createMany` call, or `null` when nothing was written. */
function written(): { userId: string; type: string; payload: Record<string, unknown> } | null {
  const calls = db.notificationCreateMany.mock.calls;
  if (calls.length === 0) return null;
  const data = calls[0][0].data as {
    userId: string;
    type: string;
    payload: Record<string, unknown>;
  }[];
  return data[0] ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T03:00:00.000Z"));

  // Both the actor and the assignee are members: the access check is keyed by id.
  perms.getWorkspaceAccess.mockImplementation(async (userId: string) =>
    userId === ACTOR || userId === ASSIGNEE ? { role: "MEMBER" } : null,
  );
  db.ticketFindMany.mockResolvedValue([{ id: TICKET, title: "Ship the tracker" }]);
  db.userFindUnique.mockResolvedValue({ notificationPrefs: null });
  db.notificationCreateMany.mockResolvedValue({ count: 1 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("notifyTicketAssigned — the assignment reaches the assignee", () => {
  it("writes one inbox row naming the ticket", async () => {
    await notifyTicketAssigned({
      workspaceId: WORKSPACE,
      assigneeId: ASSIGNEE,
      ticketIds: [TICKET],
      projectId: "project-1",
    });

    const row = written();
    expect(row).not.toBeNull();
    expect(row?.userId).toBe(ASSIGNEE);
    expect(row?.type).toBe("ticket.assigned");
    expect(row?.payload).toMatchObject({
      workspaceId: WORKSPACE,
      ticketId: TICKET,
      title: "Ship the tracker",
      count: 1,
      projectId: "project-1",
      actorId: ACTOR,
    });
  });

  it("counts only the tickets the database still assigns to that person", async () => {
    // The caller passes three ids; the database confirms two (the third either
    // moved on or never belonged to the workspace).
    db.ticketFindMany.mockResolvedValue([
      { id: "ticket-1", title: "One" },
      { id: "ticket-2", title: "Two" },
    ]);

    await notifyTicketAssigned({
      workspaceId: WORKSPACE,
      assigneeId: ASSIGNEE,
      ticketIds: ["ticket-1", "ticket-2", "ticket-3"],
    });

    const row = written();
    expect(row?.payload.count).toBe(2);
    // The lookup itself carries the invariant: same workspace, same assignee.
    expect(db.ticketFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: WORKSPACE,
          assigneeId: ASSIGNEE,
        }),
      }),
    );
  });

  it("says nothing when the tickets are not the assignee's", async () => {
    db.ticketFindMany.mockResolvedValue([]);

    await notifyTicketAssigned({
      workspaceId: WORKSPACE,
      assigneeId: ASSIGNEE,
      ticketIds: [TICKET],
    });

    expect(db.notificationCreateMany).not.toHaveBeenCalled();
  });
});

describe("notifyTicketAssigned — who may be told, and who may tell", () => {
  it("never notifies the actor about their own assignment", async () => {
    await notifyTicketAssigned({
      workspaceId: WORKSPACE,
      assigneeId: ACTOR,
      ticketIds: [TICKET],
    });

    expect(db.ticketFindMany).not.toHaveBeenCalled();
    expect(db.notificationCreateMany).not.toHaveBeenCalled();
  });

  it("refuses a target who is not a member of the workspace", async () => {
    await notifyTicketAssigned({
      workspaceId: WORKSPACE,
      assigneeId: "stranger",
      ticketIds: [TICKET],
    });

    expect(db.notificationCreateMany).not.toHaveBeenCalled();
  });

  it("refuses an actor who may not edit content (a guest)", async () => {
    // `canEditContent` is "not a guest": a GUEST may read a workspace but not
    // hand work out in it, so a forged call in their name notifies nobody.
    perms.getWorkspaceAccess.mockImplementation(async (userId: string) =>
      userId === ACTOR ? { role: "GUEST" } : { role: "MEMBER" },
    );

    await notifyTicketAssigned({
      workspaceId: WORKSPACE,
      assigneeId: ASSIGNEE,
      ticketIds: [TICKET],
    });

    expect(db.notificationCreateMany).not.toHaveBeenCalled();
  });
});

describe("notifyTicketAssigned — the assignee's own preferences decide delivery", () => {
  it("honours a muted ticket-assignment type", async () => {
    db.userFindUnique.mockResolvedValue({
      notificationPrefs: parsePrefs({
        userId: ASSIGNEE,
        perType: { "ticket.assigned": { inApp: false, email: false } },
      }),
    });

    await notifyTicketAssigned({
      workspaceId: WORKSPACE,
      assigneeId: ASSIGNEE,
      ticketIds: [TICKET],
    });

    expect(db.notificationCreateMany).not.toHaveBeenCalled();
  });

  it("honours quiet hours", async () => {
    // 03:00 UTC sits inside a 22:00-07:00 window.
    db.userFindUnique.mockResolvedValue({
      notificationPrefs: parsePrefs({
        userId: ASSIGNEE,
        quietHours: { start: "22:00", end: "07:00", tz: "UTC", days: [0, 1, 2, 3, 4, 5, 6] },
      }),
    });

    await notifyTicketAssigned({
      workspaceId: WORKSPACE,
      assigneeId: ASSIGNEE,
      ticketIds: [TICKET],
    });

    expect(db.notificationCreateMany).not.toHaveBeenCalled();
  });
});

describe("notifyTicketAssigned — best effort (R82.8)", () => {
  it("never throws when the dispatch fails", async () => {
    db.ticketFindMany.mockRejectedValue(new Error("connection reset"));

    await expect(
      notifyTicketAssigned({
        workspaceId: WORKSPACE,
        assigneeId: ASSIGNEE,
        ticketIds: [TICKET],
      }),
    ).resolves.toBeUndefined();
  });

  it("does nothing at all for an empty selection", async () => {
    await notifyTicketAssigned({
      workspaceId: WORKSPACE,
      assigneeId: ASSIGNEE,
      ticketIds: [],
    });

    expect(db.ticketFindMany).not.toHaveBeenCalled();
  });
});
