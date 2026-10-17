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
  restoreTicketAction: vi.fn(),
}));

import { bulkConfirmCopy } from "./ticket-bulk-actions";

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
