import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B16 — the bulk ticket writes are scoped to the workspace of the selection.
 *
 * `TicketLabel` and `TicketActivity` carry no workspace column of their own:
 * both hang off the ticket. A bulk operation therefore cannot be scoped by a
 * filter of its own — it has to narrow the selection to the workspace of its
 * first ticket *before* it writes. Without that narrowing a ticket id from
 * another workspace receives a label relation and an activity row, so a caller
 * who may edit one workspace can plant labels and history in another one.
 *
 * The same applies to a ticket that is created: the labels it carries must be
 * labels of its own workspace (`createTicketAction`).
 *
 * Only the database edge (`@/lib/db`), the auth edge (`@/lib/auth`,
 * `@/lib/permissions`) and `next/cache` are mocked; the domain logic in the
 * actions runs for real. The database mock answers the workspace filters the
 * way the schema does, so the actions have to do the narrowing themselves.
 */

const db = vi.hoisted(() => ({
  ticket: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
  ticketLabel: { createMany: vi.fn(), deleteMany: vi.fn() },
  label: { findMany: vi.fn() },
  ticketActivity: { create: vi.fn() },
  workspace: { findUnique: vi.fn(), update: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "actor-1" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: vi.fn(async () => ({ role: "MEMBER" })),
  canEditContent: (role: string) => role !== "GUEST",
  canManageMembers: () => false,
}));

import { bulkArchiveTicketsAction, bulkUpdateTicketsAction, createTicketAction } from "./tickets";

/** The tickets that exist, with the workspace they live in. */
const TICKETS: Record<string, string> = {
  "t-a": "ws1",
  "t-b": "ws1",
  "t-foreign": "ws2",
};

/** The labels that exist, with the workspace they live in. */
const LABELS: Record<string, string> = { "l1": "ws1", "l2": "ws1", "l-foreign": "ws2" };

type ScopeQuery = { where: { id: { in: string[] }; workspaceId: string } };

beforeEach(() => {
  vi.clearAllMocks();
  db.ticket.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const workspaceId = TICKETS[where.id];
    return workspaceId ? { workspaceId } : null;
  });
  db.ticket.findMany.mockImplementation(async ({ where }: ScopeQuery) =>
    Object.entries(TICKETS)
      .filter(([id, ws]) => ws === where.workspaceId && where.id.in.includes(id))
      .map(([id]) => ({ id })),
  );
  db.label.findMany.mockImplementation(async ({ where }: ScopeQuery) =>
    Object.entries(LABELS)
      .filter(([id, ws]) => ws === where.workspaceId && where.id.in.includes(id))
      .map(([id]) => ({ id })),
  );
  db.ticket.updateMany.mockResolvedValue({ count: 0 });
  db.ticketLabel.createMany.mockResolvedValue({ count: 0 });
  db.ticketLabel.deleteMany.mockResolvedValue({ count: 0 });
  db.ticketActivity.create.mockResolvedValue({ id: "a1" });
});

describe("bulkUpdateTicketsAction — the selection is scoped to the workspace", () => {
  it("does not attach a label to a ticket of another workspace", async () => {
    const result = await bulkUpdateTicketsAction({
      ticketIds: ["t-a", "t-foreign"],
      addLabelIds: ["l1"],
    });

    expect(result).toEqual({ ok: true, updated: 1 });
    expect(db.ticketLabel.createMany).toHaveBeenCalledWith({
      data: [{ ticketId: "t-a", labelId: "l1" }],
      skipDuplicates: true,
    });
  });

  it("does not remove a label from a ticket of another workspace", async () => {
    await bulkUpdateTicketsAction({
      ticketIds: ["t-a", "t-foreign"],
      removeLabelIds: ["l2"],
    });

    expect(db.ticketLabel.deleteMany).toHaveBeenCalledWith({
      where: { ticketId: { in: ["t-a"] }, labelId: { in: ["l2"] } },
    });
  });

  it("writes no activity row for a ticket of another workspace", async () => {
    await bulkUpdateTicketsAction({
      ticketIds: ["t-a", "t-foreign"],
      priority: "high",
    });

    expect(db.ticketActivity.create).toHaveBeenCalledTimes(1);
    expect(db.ticketActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ticketId: "t-a" }) }),
    );
  });

  it("still updates every ticket of the workspace and reports their number", async () => {
    db.ticket.updateMany.mockResolvedValue({ count: 2 });

    const result = await bulkUpdateTicketsAction({
      ticketIds: ["t-a", "t-b"],
      priority: "high",
      addLabelIds: ["l1"],
    });

    expect(result).toEqual({ ok: true, updated: 2 });
    expect(db.ticketLabel.createMany).toHaveBeenCalledWith({
      data: [
        { ticketId: "t-a", labelId: "l1" },
        { ticketId: "t-b", labelId: "l1" },
      ],
      skipDuplicates: true,
    });
    expect(db.ticketActivity.create).toHaveBeenCalledTimes(2);
  });
});

describe("bulkArchiveTicketsAction — the selection is scoped to the workspace", () => {
  it("writes no activity row for a ticket of another workspace", async () => {
    db.ticket.updateMany.mockResolvedValue({ count: 1 });

    const result = await bulkArchiveTicketsAction({ ticketIds: ["t-a", "t-foreign"] });

    expect(result).toEqual({ ok: true, updated: 1 });
    expect(db.ticketActivity.create).toHaveBeenCalledTimes(1);
    expect(db.ticketActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ticketId: "t-a" }) }),
    );
  });

  it("still archives every ticket of the workspace and logs one row each", async () => {
    db.ticket.updateMany.mockResolvedValue({ count: 2 });

    const result = await bulkArchiveTicketsAction({ ticketIds: ["t-a", "t-b"] });

    expect(result).toEqual({ ok: true, updated: 2 });
    expect(db.ticketActivity.create).toHaveBeenCalledTimes(2);
  });
});

describe("createTicketAction — the labels are scoped to the workspace", () => {
  beforeEach(() => {
    db.workspace.findUnique.mockResolvedValue({ name: "Noema", ticketCounter: 7 });
    db.workspace.update.mockResolvedValue({ ticketCounter: 8 });
    db.ticket.findFirst.mockResolvedValue(null);
    db.ticket.create.mockResolvedValue({ id: "t9", key: "NOE-8" });
  });

  it("does not attach a label of another workspace", async () => {
    const result = await createTicketAction({
      workspaceId: "ws1",
      title: "Ship it",
      labelIds: ["l-foreign"],
    });

    expect(result).toEqual({ ok: true, id: "t9", key: "NOE-8" });
    expect(db.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.not.objectContaining({ labels: expect.anything() }) }),
    );
  });

  it("attaches the labels of its own workspace", async () => {
    const result = await createTicketAction({
      workspaceId: "ws1",
      title: "Ship it",
      labelIds: ["l1", "l2"],
    });

    expect(result).toEqual({ ok: true, id: "t9", key: "NOE-8" });
    expect(db.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          labels: { create: [{ labelId: "l1" }, { labelId: "l2" }] },
        }),
      }),
    );
  });
});
