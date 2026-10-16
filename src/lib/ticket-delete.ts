/**
 * Tickets domain: wording for the destructive (permanent-delete) and archive
 * confirmations.
 *
 * Kept pure so the drawer's single-ticket delete and the board's bulk delete
 * share one source of truth, and so the count a confirmation names can be
 * pinned by a node test without rendering React. `(n) tickets` is always
 * pluralised correctly, which is the piece the user actually reads before
 * committing an irreversible action.
 */

/** `"ticket"` for exactly one, `"tickets"` otherwise. */
export function ticketNoun(count: number): string {
  return count === 1 ? "ticket" : "tickets";
}

/** Confirmation for deleting one ticket, naming its key and title. */
export function deleteTicketConfirmLabel(key: string, title: string): string {
  const trimmed = title.trim();
  const described = trimmed ? `${key}: ${trimmed}` : key;
  return `Permanently delete ${described}? This cannot be undone.`;
}

/** Confirmation for bulk deletion — always names how many will be removed. */
export function bulkDeleteConfirmLabel(count: number): string {
  return `Permanently delete ${count} ${ticketNoun(count)}? This cannot be undone.`;
}

/** Confirmation for bulk archiving (soft delete) — names the count. */
export function bulkArchiveConfirmLabel(count: number): string {
  return `Archive ${count} ${ticketNoun(count)}? You can restore them later.`;
}
