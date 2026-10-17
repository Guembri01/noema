import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `updateTicketAction`'s milestone guard.
 *
 * A milestone belongs to a project, and a project belongs to a workspace, so the
 * write path has to check both: by id alone a ticket could be pointed at another
 * workspace's milestone, or paired with one its own project does not own (the
 * drawer's picker hides those, but a picker is not a security boundary). Only the
 * database edge, auth and `next/cache` are mocked; the guard runs for real.
 */

const db = vi.hoisted(() => ({
  ticket: { findUnique: vi.fn(), update: vi.fn() },
  milestone: { findUnique: vi.fn() },
  ticketActivity: { create: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "actor-1" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: vi.fn(async () => ({ role: "MEMBER" })),
  canEditContent: (role: string) => role !== "GUEST",
  canManageMembers: () => false,
}));

import { updateTicketAction } from "./tickets";

beforeEach(() => {
  vi.clearAllMocks();
  db.ticket.findUnique.mockResolvedValue({
    id: "t1",
    workspaceId: "ws1",
    status: "todo",
    title: "Ticket one",
    key: "NOE-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    assigneeId: null,
    projectId: null,
  });
  db.ticket.update.mockResolvedValue({ id: "t1" });
  db.ticketActivity.create.mockResolvedValue({ id: "a1" });
});

describe("updateTicketAction milestone guard", () => {
  it("connects a milestone that belongs to the ticket's project", async () => {
    db.milestone.findUnique.mockResolvedValue({
      projectId: "p1",
      project: { workspaceId: "ws1" },
    });

    const result = await updateTicketAction({ ticketId: "t1", projectId: "p1", milestoneId: "m1" });

    expect(result).toEqual({ ok: true });
    expect(db.ticket.update).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { project: { connect: { id: "p1" } }, milestone: { connect: { id: "m1" } } },
    });
  });

  it("refuses a milestone from another workspace", async () => {
    db.milestone.findUnique.mockResolvedValue({
      projectId: "p9",
      project: { workspaceId: "ws-other" },
    });

    const result = await updateTicketAction({ ticketId: "t1", milestoneId: "m1" });

    expect(result).toEqual({ error: "That milestone is not in this workspace." });
    expect(db.ticket.update).not.toHaveBeenCalled();
  });

  it("refuses a milestone the ticket's project does not own", async () => {
    db.milestone.findUnique.mockResolvedValue({
      projectId: "p2",
      project: { workspaceId: "ws1" },
    });

    // The ticket exists in `p1` (the project the drawer would be editing); `m1`
    // is a `p2` milestone, so the pairing would contradict the ticket.
    db.ticket.findUnique.mockResolvedValue({
      id: "t1",
      workspaceId: "ws1",
      status: "todo",
      title: "Ticket one",
      key: "NOE-1",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      assigneeId: null,
      projectId: "p1",
    });

    const result = await updateTicketAction({ ticketId: "t1", milestoneId: "m1" });

    expect(result).toEqual({ error: "That milestone belongs to another project." });
    expect(db.ticket.update).not.toHaveBeenCalled();
  });

  it("refuses a milestone when the same call moves the ticket to another project", async () => {
    db.milestone.findUnique.mockResolvedValue({
      projectId: "p2",
      project: { workspaceId: "ws1" },
    });

    const result = await updateTicketAction({ ticketId: "t1", projectId: "p1", milestoneId: "m1" });

    expect(result).toEqual({ error: "That milestone belongs to another project." });
    expect(db.ticket.update).not.toHaveBeenCalled();
  });

  it("disconnects on an explicit null without looking the milestone up", async () => {
    const result = await updateTicketAction({ ticketId: "t1", milestoneId: null });

    expect(result).toEqual({ ok: true });
    expect(db.milestone.findUnique).not.toHaveBeenCalled();
    expect(db.ticket.update).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { milestone: { disconnect: true } },
    });
  });

  it("refuses a milestone that does not exist", async () => {
    db.milestone.findUnique.mockResolvedValue(null);

    const result = await updateTicketAction({ ticketId: "t1", milestoneId: "missing" });

    expect(result).toEqual({ error: "That milestone is not in this workspace." });
    expect(db.ticket.update).not.toHaveBeenCalled();
  });
});
