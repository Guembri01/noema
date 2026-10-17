"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArchiveRestore, Search } from "lucide-react";
import { toast } from "sonner";
import { restoreTicketAction } from "@/server/actions/tickets";
import { safeAction } from "@/lib/actions-client";
import { t } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/i18n-format";
import { statusMeta } from "@/lib/tickets";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/avatar";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

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

/** Ticket status → design-system `Badge` tone (no raw palette classes). */
const STATUS_TONE: Record<string, BadgeTone> = {
  backlog: "neutral",
  todo: "accent",
  in_progress: "warning",
  in_review: "accent",
  done: "success",
  cancelled: "danger",
};

/** Pure mapping from a status id to a `Badge` tone, defaulting to neutral. */
export function archiveStatusTone(status: string | null | undefined): BadgeTone {
  return (status ? STATUS_TONE[status] : undefined) ?? "neutral";
}

/**
 * One archived row: a `Switch` selection toggle, the status `Badge`, the
 * archiver `Avatar` and a `Button` restore. Split out so it can be rendered
 * statically (SSR test) without the surrounding list chrome.
 */
export function ArchiveRow({
  ticket,
  locale,
  selected = false,
  pending = false,
  onSelectedChange,
  onRestore,
}: {
  ticket: ArchivedTicketRow;
  locale: string;
  selected?: boolean;
  pending?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  onRestore: () => void;
}) {
  return (
    <li
      data-testid={`archive-row-${ticket.id}`}
      data-selected={selected ? "true" : undefined}
      className={cn(
        "u-colors flex items-center gap-3 px-3 py-2.5",
        selected ? "bg-surface-2" : "hover:bg-surface-2",
      )}
    >
      <Switch
        size="sm"
        checked={selected}
        onCheckedChange={onSelectedChange}
        aria-label={`${t(locale, "restore")} ${ticket.key}`}
      />
      <span className="font-mono text-xs text-muted">{ticket.key}</span>
      <span className="min-w-0 flex-1 truncate text-sm">{ticket.title}</span>
      <Badge tone={archiveStatusTone(ticket.status)}>{statusMeta(ticket.status).label}</Badge>
      {ticket.archivedByName ? (
        <Avatar
          user={{ id: ticket.archivedByName, name: ticket.archivedByName }}
          size={20}
          className="hidden sm:inline-flex"
        />
      ) : null}
      <span className="hidden shrink-0 text-xs text-muted sm:inline" title={ticket.archivedAt}>
        {formatRelativeTime(ticket.archivedAt, { locale })}
      </span>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={pending}
        data-testid={`restore-ticket-${ticket.id}`}
        leftIcon={<ArchiveRestore className="h-3.5 w-3.5" aria-hidden />}
        onClick={onRestore}
      >
        {t(locale, "restore")}
      </Button>
    </li>
  );
}

/**
 * The archived-ticket list: client-side search over key + title, per-row
 * `Switch` selection with a bulk restore, and a per-row Restore control.
 * Restoring runs `restoreTicketAction` (same role gate as every other ticket
 * write) and refreshes the server component, so the row drops off the list
 * without a full reload.
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
  const [selected, setSelected] = useState<string[]>([]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tickets;
    return tickets.filter((ticket) =>
      `${ticket.key} ${ticket.title}`.toLowerCase().includes(needle),
    );
  }, [tickets, query]);

  const restoreMany = (ids: string[]) =>
    startTransition(async () => {
      for (const id of ids) {
        const outcome = await safeAction(() => restoreTicketAction(id), { locale });
        if (!outcome.ok) {
          toast.error(outcome.error);
          return;
        }
        if ("error" in outcome.value) {
          toast.error(outcome.value.error);
          return;
        }
      }
      setSelected((current) => current.filter((id) => !ids.includes(id)));
      toast.success(ids.length === 1 ? "Ticket restored" : `${ids.length} tickets restored`);
      router.refresh();
    });

  const toggleSelected = (id: string, on: boolean) =>
    setSelected((current) =>
      on ? (current.includes(id) ? current : [...current, id]) : current.filter((entry) => entry !== id),
    );

  return (
    <div className="animate-fade">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          clearable
          onClear={() => setQuery("")}
          value={query}
          leading={<Search className="h-3.5 w-3.5" aria-hidden />}
          aria-label={t(locale, "searchTickets")}
          placeholder={t(locale, "searchTickets")}
          onChange={(event) => setQuery(event.target.value)}
          className="max-w-sm"
        />
        <Badge tone="neutral" count={tickets.length} title={t(locale, "archivedTickets")} />
        {selected.length > 0 ? (
          <div className="flex items-center gap-2" data-testid="archive-bulk">
            <Badge tone="accent" count={selected.length} />
            <Button
              type="button"
              size="sm"
              variant="primary"
              disabled={pending}
              leftIcon={<ArchiveRestore className="h-3.5 w-3.5" aria-hidden />}
              onClick={() => restoreMany(selected)}
            >
              {t(locale, "restoreSelected")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setSelected([])}>
              Clear
            </Button>
          </div>
        ) : null}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border">
          <EmptyState
            variant="full"
            icon={<ArchiveRestore className="h-5 w-5" aria-hidden />}
            title={tickets.length === 0 ? t(locale, "noArchivedTickets") : t(locale, "noMatchingTickets")}
            description={
              tickets.length === 0
                ? "Tickets you archive will appear here, ready to restore."
                : "Try a different key or title."
            }
            primaryAction={
              tickets.length === 0 ? (
                <Button type="button" variant="secondary" onClick={() => router.refresh()}>
                  {t(locale, "refresh")}
                </Button>
              ) : (
                <Button type="button" variant="secondary" onClick={() => setQuery("")}>
                  {t(locale, "clearSearch")}
                </Button>
              )
            }
          />
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {filtered.map((ticket) => (
            <ArchiveRow
              key={ticket.id}
              ticket={ticket}
              locale={locale}
              pending={pending}
              selected={selected.includes(ticket.id)}
              onSelectedChange={(on) => toggleSelected(ticket.id, on)}
              onRestore={() => restoreMany([ticket.id])}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
