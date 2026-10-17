import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ticket manipulation — permanent delete, bulk delete, bulk archive and the
 * label/estimate half of bulk update.
 *
 * Only the database edge (`@/lib/db`), the auth edge (`@/lib/auth`,
 * `@/lib/permissions`) and `next/cache` are mocked; the domain logic in the
 * actions runs for real. Pins the payloads, the reported counts and — most
 * importantly — that every destructive path keeps the same role gate as any
 * other write (a guest is refused and nothing is written).
 */

const db = vi.hoisted(() => ({
  ticket: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
  },
  ticketLabel: { createMany: vi.fn(), deleteMany: vi.fn() },
  label: { findMany: vi.fn() },
  ticketActivity: { create: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "actor-1" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/permissions", () => ({
  getWorkspaceAccess: vi.fn(),
  canEditContent: (role: string) => role !== "GUEST",
  canManageMembers: (role: string) => role === "OWNER" || role === "ADMIN",
}));

import { getWorkspaceAccess } from "@/lib/permissions";
import {
  bulkArchiveTicketsAction,
  bulkDeleteTicketsAction,
  bulkUpdateTicketsAction,
  deleteTicketAction,
} from "./tickets";

const access = vi.mocked(getWorkspaceAccess);

beforeEach(() => {
  vi.clearAllMocks();
  access.mockResolvedValue({ role: "MEMBER" } as never);
  db.ticket.findUnique.mockResolvedValue({
    id: "t1",
    workspaceId: "ws1",
    status: "todo",
    title: "Ticket one",
    key: "NOE-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  db.ticket.findMany.mockImplementation(async (args: { where?: { id?: { in?: string[] } } }) =>
    (args?.where?.id?.in ?? []).map((id) => ({ id })),
  );
  db.ticketActivity.create.mockResolvedValue({ id: "a1" });
});

describe("deleteTicketAction (permanent, single)", () => {
  it("deletes the row when the caller can edit the workspace", async () => {
    await expect(deleteTicketAction("t1")).resolves.toEqual({ ok: true });
    expect(db.ticket.delete).toHaveBeenCalledWith({ where: { id: "t1" } });
  });

  it("refuses a guest and writes nothing", async () => {
    access.mockResolvedValue({ role: "GUEST" } as never);
    const result = await deleteTicketAction("t1");
    expect("error" in result).toBe(true);
    expect(db.ticket.delete).not.toHaveBeenCalled();
  });

  it("refuses when the caller has no access at all", async () => {
    access.mockResolvedValue(null);
    const result = await deleteTicketAction("t1");
    expect("error" in result).toBe(true);
    expect(db.ticket.delete).not.toHaveBeenCalled();
  });

  it("reports a missing ticket", async () => {
    db.ticket.findUnique.mockResolvedValue(null);
    await expect(deleteTicketAction("gone")).resolves.toEqual({ error: "Ticket not found." });
    expect(db.ticket.delete).not.toHaveBeenCalled();
  });
});

describe("bulkDeleteTicketsAction", () => {
  it("deletes the whole selection and reports the count", async () => {
    db.ticket.deleteMany.mockResolvedValue({ count: 3 });
    await expect(bulkDeleteTicketsAction({ ticketIds: ["a", "b", "c"] })).resolves.toEqual({
      ok: true,
      deleted: 3,
    });
    expect(db.ticket.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["a", "b", "c"] }, workspaceId: "ws1" },
    });
  });

  it("is a no-op for an empty selection", async () => {
    await expect(bulkDeleteTicketsAction({ ticketIds: [] })).resolves.toEqual({
      ok: true,
      deleted: 0,
    });
    expect(db.ticket.findUnique).not.toHaveBeenCalled();
    expect(db.ticket.deleteMany).not.toHaveBeenCalled();
  });

  it("refuses a guest and writes nothing", async () => {
    access.mockResolvedValue({ role: "GUEST" } as never);
    const result = await bulkDeleteTicketsAction({ ticketIds: ["a", "b"] });
    expect("error" in result).toBe(true);
    expect(db.ticket.deleteMany).not.toHaveBeenCalled();
  });
});

describe("bulkArchiveTicketsAction", () => {
  it("archives the selection and logs one activity per ticket", async () => {
    db.ticket.updateMany.mockResolvedValue({ count: 2 });
    await expect(bulkArchiveTicketsAction({ ticketIds: ["a", "b"] })).resolves.toEqual({
      ok: true,
      updated: 2,
    });
    expect(db.ticket.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["a", "b"] }, workspaceId: "ws1" },
      data: { archived: true },
    });
    expect(db.ticketActivity.create).toHaveBeenCalledTimes(2);
  });

  it("restores when archived:false", async () => {
    db.ticket.updateMany.mockResolvedValue({ count: 1 });
    await bulkArchiveTicketsAction({ ticketIds: ["a"], archived: false });
    expect(db.ticket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { archived: false } }),
    );
  });
});

describe("bulkUpdateTicketsAction — labels and estimate", () => {
  it("applies an estimate and only workspace-valid labels", async () => {
    db.label.findMany.mockResolvedValue([{ id: "l1" }, { id: "l2" }]);
    db.ticket.updateMany.mockResolvedValue({ count: 2 });
    db.ticketLabel.createMany.mockResolvedValue({ count: 2 });
    db.ticketLabel.deleteMany.mockResolvedValue({ count: 1 });

    await expect(
      bulkUpdateTicketsAction({
        ticketIds: ["a", "b"],
        estimate: 5,
        estimateUnit: "hours",
        addLabelIds: ["l1", "bogus"],
        removeLabelIds: ["l2"],
      }),
    ).resolves.toEqual({ ok: true, updated: 2 });

    expect(db.ticket.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["a", "b"] }, workspaceId: "ws1" },
      data: { estimate: 5, estimateUnit: "hours" },
    });
    // "bogus" is not a label in this workspace, so it never becomes a row.
    expect(db.ticketLabel.createMany).toHaveBeenCalledWith({
      data: [
        { ticketId: "a", labelId: "l1" },
        { ticketId: "b", labelId: "l1" },
      ],
      skipDuplicates: true,
    });
    expect(db.ticketLabel.deleteMany).toHaveBeenCalledWith({
      where: { ticketId: { in: ["a", "b"] }, labelId: { in: ["l2"] } },
    });
  });

  it("handles labels alone without touching scalar columns", async () => {
    db.label.findMany.mockResolvedValue([{ id: "l1" }]);
    db.ticketLabel.createMany.mockResolvedValue({ count: 1 });

    await expect(
      bulkUpdateTicketsAction({ ticketIds: ["a"], addLabelIds: ["l1"] }),
    ).resolves.toEqual({ ok: true, updated: 1 });
    expect(db.ticket.updateMany).not.toHaveBeenCalled();
    expect(db.ticketLabel.createMany).toHaveBeenCalledTimes(1);
  });

  it("refuses a guest", async () => {
    access.mockResolvedValue({ role: "GUEST" } as never);
    const result = await bulkUpdateTicketsAction({ ticketIds: ["a"], priority: "high" });
    expect("error" in result).toBe(true);
    expect(db.ticket.updateMany).not.toHaveBeenCalled();
  });
});
