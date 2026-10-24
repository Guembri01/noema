import { describe, expect, it, vi } from "vitest";

/**
 * ds08 — the bulk actions bar's pure mapping: destructive action → confirm
 * copy. Built on `@/lib/ticket-delete`, so the count sentence is shared with
 * the drawer's single-ticket delete.
 */

vi.mock("@/server/actions/tickets", () => ({
  bulkArchiveTicketsAction: vi.fn(),
  bulkDeleteTicketsAction: vi.fn(),
  bulkUpdateTicketsAction: vi.fn(),
  toggleTicketLabelAction: vi.fn(),
  updateTicketAction: vi.fn(),
  restoreTicketAction: vi.fn(),
}));

import { bulkConfirmCopy, bulkTicketChanges } from "./ticket-bulk-actions";
import type { TicketRow } from "./ticket-types";

describe("bulkConfirmCopy", () => {
  it("gives a permanent delete the danger tone", () => {
    const copy = bulkConfirmCopy("delete", 1);
    expect(copy.tone).toBe("danger");
    expect(copy.confirmLabel).toBe("Delete permanently");
  });

  it("names the exact count in the delete sentence", () => {
    expect(bulkConfirmCopy("delete", 1).description).toBe(
      "Permanently delete 1 ticket? This cannot be undone.",
    );
    expect(bulkConfirmCopy("delete", 3).description).toBe(
      "Permanently delete 3 tickets? This cannot be undone.",
    );
  });

  it("keeps a reversible archive neutral, and still names the count", () => {
    const copy = bulkConfirmCopy("archive", 2);
    expect(copy.tone).toBe("default");
    expect(copy.description).toBe("Archive 2 tickets? You can restore them later.");
    expect(bulkConfirmCopy("archive", 1).description).toBe(
      "Archive 1 ticket? You can restore them later.",
    );
  });

  it("is total for any count, including zero", () => {
    expect(bulkConfirmCopy("delete", 0).description).toContain("0 tickets");
    expect(bulkConfirmCopy("archive", 0).title).toContain("0 tickets");
  });
});

const ticket = (overrides: Partial<TicketRow> = {}): TicketRow => ({
  id: "t1",
  key: "ABC-1",
  title: "A ticket",
  description: "",
  descriptionDoc: null,
  type: "task",
  status: "todo",
  priority: "medium",
  estimate: 1,
  estimateUnit: "points",
  startDate: null,
  dueDate: null,
  parentId: null,
  cycleId: null,
  projectId: null,
  projectName: null,
  milestoneId: null,
  milestoneName: null,
  assigneeId: null,
  assigneeName: null,
  assigneeEmail: null,
  labels: [],
  labelIds: [],
  commentCount: 0,
  childCount: 0,
  ...overrides,
});

describe("bulkTicketChanges — one inverse per changed row", () => {
  it("captures the previous scalar values and skips rows already there", () => {
    const rows = [
      ticket({ id: "a", status: "todo" }),
      ticket({ id: "b", status: "done" }),
    ];
    const changes = bulkTicketChanges(rows, ["a", "b"], { status: "done" });
    expect(changes).toEqual([
      { rowId: "a", before: { status: "todo" }, after: { status: "done" } },
    ]);
  });

  it("plans a label add only for rows that lack the label", () => {
    const rows = [
      ticket({ id: "a", labelIds: [] }),
      ticket({ id: "b", labelIds: ["l1"] }),
    ];
    const changes = bulkTicketChanges(rows, ["a", "b"], { addLabelIds: ["l1"] });
    expect(changes).toEqual([
      {
        rowId: "a",
        before: { removeLabelIds: ["l1"] },
        after: { addLabelIds: ["l1"] },
      },
    ]);
  });

  it("plans a label remove only for rows that carry it, inverted as an add", () => {
    const rows = [
      ticket({ id: "a", labelIds: ["l1"] }),
      ticket({ id: "b", labelIds: [] }),
    ];
    const changes = bulkTicketChanges(rows, ["a", "b"], { removeLabelIds: ["l1"] });
    expect(changes).toEqual([
      {
        rowId: "a",
        before: { addLabelIds: ["l1"] },
        after: { removeLabelIds: ["l1"] },
      },
    ]);
  });

  it("restores the estimate and its unit together", () => {
    const rows = [ticket({ id: "a", estimate: 2, estimateUnit: "hours" })];
    expect(bulkTicketChanges(rows, ["a"], { estimate: 5, estimateUnit: "points" })).toEqual([
      {
        rowId: "a",
        before: { estimate: 2, estimateUnit: "hours" },
        after: { estimate: 5, estimateUnit: "points" },
      },
    ]);
  });

  it("does not invent a change for an unselected or unknown row", () => {
    expect(bulkTicketChanges([ticket({ id: "a" })], ["missing"], { status: "done" })).toEqual([]);
  });
});
