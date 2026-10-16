"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArchiveRestore, Search } from "lucide-react";
import { toast } from "sonner";
import { restoreTicketAction } from "@/server/actions/tickets";
import { safeAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/i18n-format";
import { StatusPill } from "./ticket-bits";

/**
 * One archived ticket as the archive page serialises it (dates as ISO strings,
 * so the row survives the server → client boundary).
 */
export type ArchivedTicketRow = {
  id: string;
  key: string;
  title: string;
  status: string;
  /** ISO instant the ticket was archived. */
  archivedAt: string;
  /** Who archived it, when an `archived` activity row recorded them. */
  archivedByName: string | null;
};

/**
 * The archived-ticket list: client-side search over key + title and a per-row
 * Restore control. Restoring runs `restoreTicketAction` (same role gate as every
 * other ticket write) and refreshes the server component, so the row drops off
 * the list without a full reload.
 */
export function TicketArchiveView({
  tickets,
  locale,
}: {
  tickets: ArchivedTicketRow[];
  locale: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tickets;
    return tickets.filter((ticket) =>
      `${ticket.key} ${ticket.title}`.toLowerCase().includes(needle),
    );
  }, [tickets, query]);

  const restore = (ticketId: string) =>
    startTransition(async () => {
      const outcome = await safeAction(() => restoreTicketAction(ticketId), { locale });
      if (!outcome.ok) {
        toast.error(outcome.error);
        return;
      }
      if ("error" in outcome.value) {
        toast.error(outcome.value.error);
        return;
      }
      toast.success("Ticket restored");
      router.refresh();
    });

  return (
    <div>
      <label className="mb-4 flex max-w-sm items-center gap-2 rounded border border-border bg-bg px-2">
        <Search className="h-3.5 w-3.5 text-muted" aria-hidden />
        <input
          value={query}
          aria-label={t(locale, "searchTickets")}
          placeholder={t(locale, "searchTickets")}
          onChange={(event) => setQuery(event.target.value)}
          className="h-9 w-full bg-transparent text-sm outline-none"
        />
      </label>

      {filtered.length === 0 ? (
        <p className="rounded border border-dashed border-border px-4 py-8 text-center text-sm text-muted">
          {tickets.length === 0 ? "No archived tickets." : "No tickets match your search."}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {filtered.map((ticket) => (
            <li key={ticket.id} className="flex items-center gap-3 px-3 py-2.5">
              <span className="font-mono text-xs text-muted">{ticket.key}</span>
              <span className="min-w-0 flex-1 truncate text-sm">{ticket.title}</span>
              <StatusPill status={ticket.status} />
              <span className="shrink-0 text-xs text-muted" title={ticket.archivedAt}>
                {ticket.archivedByName ? `${ticket.archivedByName} · ` : ""}
                {formatRelativeTime(ticket.archivedAt, { locale })}
              </span>
              <button
                type="button"
                data-testid={`restore-ticket-${ticket.id}`}
                disabled={pending}
                onClick={() => restore(ticket.id)}
                className="flex h-7 shrink-0 items-center gap-1 rounded border border-border px-2 text-xs hover:bg-surface-2 disabled:opacity-50"
              >
                <ArchiveRestore className="h-3.5 w-3.5" /> {t(locale, "restore")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
