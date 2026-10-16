import { describe, expect, it } from "vitest";
import {
  bulkArchiveConfirmLabel,
  bulkDeleteConfirmLabel,
  deleteTicketConfirmLabel,
  ticketNoun,
} from "./ticket-delete";

/**
 * Wording for the destructive confirmations. Pins that a deletion confirmation
 * always names exactly how many tickets it will remove (and pluralises the
 * noun), which is the number the user reads before an irreversible action.
 */

describe("ticketNoun", () => {
  it("is singular for one and plural otherwise", () => {
    expect(ticketNoun(0)).toBe("tickets");
    expect(ticketNoun(1)).toBe("ticket");
    expect(ticketNoun(2)).toBe("tickets");
  });
});

describe("bulkDeleteConfirmLabel", () => {
  it("names the count and pluralises", () => {
    expect(bulkDeleteConfirmLabel(1)).toContain("1 ticket");
    expect(bulkDeleteConfirmLabel(1)).not.toContain("1 tickets");
    expect(bulkDeleteConfirmLabel(5)).toContain("5 tickets");
  });

  it("warns that the action cannot be undone", () => {
    expect(bulkDeleteConfirmLabel(3)).toContain("cannot be undone");
  });
});

describe("deleteTicketConfirmLabel", () => {
  it("names the ticket by key and title", () => {
    const label = deleteTicketConfirmLabel("NOE-42", "Fix the board");
    expect(label).toContain("NOE-42");
    expect(label).toContain("Fix the board");
    expect(label).toContain("cannot be undone");
  });

  it("falls back to the key alone when there is no title", () => {
    expect(deleteTicketConfirmLabel("NOE-7", "   ")).toContain("NOE-7");
  });
});

describe("bulkArchiveConfirmLabel", () => {
  it("names the count and says it is reversible", () => {
    expect(bulkArchiveConfirmLabel(2)).toContain("2 tickets");
    expect(bulkArchiveConfirmLabel(2)).toContain("restore");
  });
});
