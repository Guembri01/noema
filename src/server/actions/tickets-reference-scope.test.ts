import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B108 (and the write half of B43) — the rows a ticket points at must live in
 * the ticket's own workspace.
 *
 * The write path checked the workspace of the *ticket*, but not of the rows it
 * referenced: `createTicketAction` took `projectId`, `assigneeId` and
 * `parentId` as they came, `updateTicketAction` connected a project and an
 * assignee as they came, the bulk update did the same, and `moveTicketAction`
 * read the position of a foreign `beforeId`. The tracker then showed the
 * foreign project's name and the foreign assignee's name and e-mail address.
 *
 * Only the database edge, auth, the notification edge and `next/cache` are
 * mocked; the guards run for real.
 */

const db = vi.hoisted(() => ({
  ticket: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  project: { findUnique: vi.fn() },
  label: { findMany: vi.fn() },
  workspace: { findUnique: vi.fn(), update: vi.fn() },
  ticketActivity: { create: vi.fn() },
  ticketLabel: { createMany: vi.fn(), deleteMany: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "actor-1" })) }));
vi.mock("@/lib/permissions", () => ({
  // The actor and the members of `ws1` have access; `u-foreign` has none.
  getWorkspaceAccess: vi.fn(async (userId: string) =>
    userId === "u-foreign" ? null : { role: "MEMBER" },
  ),
  canEditContent: (role: string) => role !== "GUEST",
  canManageMembers: () => false,
}));
vi.mock("@/server/actions/notifications", () => ({ notifyTicketAssigned: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  bulkUpdateTicketsAction,
  createTicketAction,
  moveTicketAction,
  updateTicketAction,
} from "./tickets";

/** The ticket under edit: it lives in `ws1`. */
const TICKET = {
  id: "t1",
  workspaceId: "ws1",
  status: "todo",
  title: "Ticket one",
  key: "NOE-1",
  position: 1000,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  assigneeId: null,
  projectId: null,
};

/** A ticket of another workspace — the id a foreign parent or `beforeId` names. */
const FOREIGN_TICKET = {
  id: "t-foreign",
  workspaceId: "ws2",
  status: "todo",
  title: "Foreign ticket",
  key: "OTH-1",
  position: 500,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  assigneeId: null,
  projectId: null,
};

/** A sibling ticket of the same workspace. */
const SIBLING_TICKET = { ...TICKET, id: "t2", position: 2000 };

beforeEach(() => {
  vi.clearAllMocks();
  db.ticket.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    if (where.id === "t-foreign") return FOREIGN_TICKET;
    if (where.id === "t2") return SIBLING_TICKET;
    return TICKET;
  });
  db.ticket.findFirst.mockResolvedValue(null);
  db.ticket.findMany.mockResolvedValue([]);
  db.ticket.create.mockResolvedValue({ id: "t9", key: "NOE-8" });
  db.ticket.update.mockResolvedValue({ id: "t1" });
  db.ticket.updateMany.mockResolvedValue({ count: 1 });
  db.ticketActivity.create.mockResolvedValue({ id: "a1" });
  db.ticketLabel.createMany.mockResolvedValue({ count: 1 });
  db.ticketLabel.deleteMany.mockResolvedValue({ count: 0 });
  // The projects and the labels of `ws1`; everything else belongs to `ws2`.
  db.project.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === "p-foreign" ? { workspaceId: "ws2" } : { workspaceId: "ws1" },
  );
  db.label.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in.filter((id) => id !== "l-foreign").map((id) => ({ id })),
  );
  db.workspace.findUnique.mockResolvedValue({ name: "Noema", ticketCounter: 7 });
  db.workspace.update.mockResolvedValue({ ticketCounter: 8 });
});

describe("createTicketAction — the rows a new ticket points at", () => {
  it("refuses a project of another workspace and writes nothing", async () => {
    const result = await createTicketAction({
      workspaceId: "ws1",
      title: "Ship it",
      projectId: "p-foreign",
    });

    expect(result).toEqual({ error: "That project is not in this workspace." });
    expect(db.ticket.create).not.toHaveBeenCalled();
    // The ticket counter is not burnt for a refused ticket.
    expect(db.workspace.update).not.toHaveBeenCalled();
  });

  it("refuses an assignee who is not in this workspace", async () => {
    const result = await createTicketAction({
      workspaceId: "ws1",
      title: "Ship it",
      assigneeId: "u-foreign",
    });

    expect(result).toEqual({ error: "That user is not in this workspace." });
    expect(db.ticket.create).not.toHaveBeenCalled();
  });

  it("refuses a parent ticket of another workspace", async () => {
    const result = await createTicketAction({
      workspaceId: "ws1",
      title: "Ship it",
      parentId: "t-foreign",
    });

    expect(result).toEqual({ error: "That parent ticket is not in this workspace." });
    expect(db.ticket.create).not.toHaveBeenCalled();
  });

  it("refuses a label of another workspace", async () => {
    const result = await createTicketAction({
      workspaceId: "ws1",
      title: "Ship it",
      labelIds: ["l1", "l-foreign"],
    });

    expect(result).toEqual({ error: "That label is not in this workspace." });
    expect(db.ticket.create).not.toHaveBeenCalled();
  });

  it("creates the ticket with its own project, assignee, parent and label", async () => {
    const result = await createTicketAction({
      workspaceId: "ws1",
      title: "Ship it",
      projectId: "p1",
      assigneeId: "u-mine",
      parentId: "t2",
      labelIds: ["l1"],
    });

    expect(result).toEqual({ ok: true, id: "t9", key: "NOE-8" });
    expect(db.ticket.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "ws1",
        number: 8,
        key: "NOE-8",
        title: "Ship it",
        type: "task",
        status: "todo",
        priority: "none",
        estimate: null,
        estimateUnit: "points",
        startDate: null,
        dueDate: null,
        projectId: "p1",
        milestoneId: null,
        assigneeId: "u-mine",
        reporterId: "actor-1",
        parentId: "t2",
        position: 1000,
        labels: { create: [{ labelId: "l1" }] },
      },
      select: { id: true, key: true },
    });
  });
});

describe("updateTicketAction — the rows a ticket is connected to", () => {
  it("refuses a project of another workspace", async () => {
    const result = await updateTicketAction({ ticketId: "t1", projectId: "p-foreign" });

    expect(result).toEqual({ error: "That project is not in this workspace." });
    expect(db.ticket.update).not.toHaveBeenCalled();
  });

  it("refuses an assignee who is not in this workspace", async () => {
    const result = await updateTicketAction({ ticketId: "t1", assigneeId: "u-foreign" });

    expect(result).toEqual({ error: "That user is not in this workspace." });
    expect(db.ticket.update).not.toHaveBeenCalled();
  });

  it("connects a project and an assignee of its own workspace", async () => {
    const result = await updateTicketAction({
      ticketId: "t1",
      projectId: "p1",
      assigneeId: "u-mine",
    });

    expect(result).toEqual({ ok: true });
    expect(db.ticket.update).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: {
        project: { connect: { id: "p1" } },
        assignee: { connect: { id: "u-mine" } },
      },
    });
  });
});

describe("moveTicketAction — the ticket a board move is placed before", () => {
  it("refuses a before ticket of another workspace", async () => {
    const result = await moveTicketAction({
      ticketId: "t1",
      status: "todo",
      beforeId: "t-foreign",
    });

    expect(result).toEqual({ error: "That ticket is not in this workspace." });
    expect(db.ticket.update).not.toHaveBeenCalled();
  });

  it("takes the position of a before ticket of its own workspace", async () => {
    const result = await moveTicketAction({ ticketId: "t1", status: "todo", beforeId: "t2" });

    expect(result).toEqual({ ok: true });
    expect(db.ticket.update).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { status: "todo", position: 1999, completedAt: null },
    });
  });
});

describe("bulkUpdateTicketsAction — the rows a bulk write points at", () => {
  it("refuses an assignee who is not in this workspace", async () => {
    const result = await bulkUpdateTicketsAction({ ticketIds: ["a"], assigneeId: "u-foreign" });

    expect(result).toEqual({ error: "That user is not in this workspace." });
    expect(db.ticket.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a project of another workspace", async () => {
    const result = await bulkUpdateTicketsAction({ ticketIds: ["a"], projectId: "p-foreign" });

    expect(result).toEqual({ error: "That project is not in this workspace." });
    expect(db.ticket.updateMany).not.toHaveBeenCalled();
  });
});
