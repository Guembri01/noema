import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/tickets` — dispatch for the destructive and bulk actions.
 *
 * The server actions are mocked so this pins exactly what the transport maps
 * each `action` to: `delete` → `deleteTicketAction(ticketId)`, `bulkDelete` →
 * `bulkDeleteTicketsAction({ ticketIds })`, and the label/estimate fields the
 * `bulk` case forwards. Action-level permission behaviour is covered in
 * `@/server/actions/tickets-manipulation.test`.
 */

const actions = vi.hoisted(() => ({
  addTicketCommentAction: vi.fn(),
  archiveTicketAction: vi.fn(),
  bulkArchiveTicketsAction: vi.fn(),
  bulkDeleteTicketsAction: vi.fn(),
  bulkUpdateTicketsAction: vi.fn(),
  createLabelAction: vi.fn(),
  createTicketAction: vi.fn(),
  deleteLabelAction: vi.fn(),
  deleteTicketAction: vi.fn(),
  linkTicketsAction: vi.fn(),
  moveTicketAction: vi.fn(),
  ticketFromPageAction: vi.fn(),
  toggleTicketLabelAction: vi.fn(),
  unlinkTicketAction: vi.fn(),
  updateLabelAction: vi.fn(),
  updateTicketAction: vi.fn(),
}));

vi.mock("@/server/actions/tickets", () => actions);
vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn(async () => ({ id: "u1" })) }));
vi.mock("@/lib/api-guard", () => ({ rateLimit: vi.fn(() => null) }));
vi.mock("@/server/queries", () => ({
  getLabels: vi.fn(),
  getTicketsCursorPage: vi.fn(),
}));

import { POST } from "./route";

const post = (body: Record<string, unknown>) =>
  POST(
    new Request("http://localhost/api/tickets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  actions.deleteTicketAction.mockResolvedValue({ ok: true });
  actions.bulkDeleteTicketsAction.mockResolvedValue({ ok: true, deleted: 0 });
  actions.bulkArchiveTicketsAction.mockResolvedValue({ ok: true, updated: 0 });
  actions.bulkUpdateTicketsAction.mockResolvedValue({ ok: true, updated: 0 });
});

describe("POST /api/tickets — delete", () => {
  it("maps action:delete to deleteTicketAction(ticketId)", async () => {
    const response = await post({ action: "delete", ticketId: "t1" });
    expect(actions.deleteTicketAction).toHaveBeenCalledWith("t1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("surfaces an action refusal as a 400", async () => {
    actions.deleteTicketAction.mockResolvedValue({ error: "You do not have permission" });
    const response = await post({ action: "delete", ticketId: "t1" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "You do not have permission" });
  });
});

describe("POST /api/tickets — bulkDelete", () => {
  it("forwards the ticket id list and returns the deleted count", async () => {
    actions.bulkDeleteTicketsAction.mockResolvedValue({ ok: true, deleted: 2 });
    const response = await post({ action: "bulkDelete", ticketIds: ["a", "b"] });
    expect(actions.bulkDeleteTicketsAction).toHaveBeenCalledWith({ ticketIds: ["a", "b"] });
    expect(await response.json()).toEqual({ ok: true, deleted: 2 });
  });

  it("defaults a missing list to an empty selection", async () => {
    await post({ action: "bulkDelete" });
    expect(actions.bulkDeleteTicketsAction).toHaveBeenCalledWith({ ticketIds: [] });
  });
});

describe("POST /api/tickets — bulkArchive", () => {
  it("archives by default and can restore", async () => {
    await post({ action: "bulkArchive", ticketIds: ["a"] });
    expect(actions.bulkArchiveTicketsAction).toHaveBeenCalledWith({
      ticketIds: ["a"],
      archived: true,
    });

    await post({ action: "bulkArchive", ticketIds: ["a"], archived: false });
    expect(actions.bulkArchiveTicketsAction).toHaveBeenLastCalledWith({
      ticketIds: ["a"],
      archived: false,
    });
  });
});

describe("POST /api/tickets — bulk label/estimate payload", () => {
  it("forwards estimate, unit and label add/remove ids", async () => {
    await post({
      action: "bulk",
      ticketIds: ["a", "b"],
      estimate: 3,
      estimateUnit: "hours",
      addLabelIds: ["l1"],
      removeLabelIds: ["l2"],
    });
    expect(actions.bulkUpdateTicketsAction).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketIds: ["a", "b"],
        estimate: 3,
        estimateUnit: "hours",
        addLabelIds: ["l1"],
        removeLabelIds: ["l2"],
      }),
    );
  });

  it("passes a null estimate through as an explicit clear", async () => {
    await post({ action: "bulk", ticketIds: ["a"], estimate: null });
    expect(actions.bulkUpdateTicketsAction).toHaveBeenCalledWith(
      expect.objectContaining({ estimate: null }),
    );
  });

  it("rejects an unknown action", async () => {
    const response = await post({ action: "explode" });
    expect(response.status).toBe(400);
  });
});
