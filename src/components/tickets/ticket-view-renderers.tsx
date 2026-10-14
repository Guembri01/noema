import type { Dispatch, SetStateAction } from "react";
import { CircleDot } from "lucide-react";
import { LocalTime } from "@/components/local-time";
import { t } from "@/lib/i18n";
import {
  formatEstimate,
  groupByStatus,
  priorityMeta,
  statusMeta,
  timelineLayout,
  typeMeta,
} from "@/lib/tickets";
import { cn } from "@/lib/utils";
import { LabelChip, StatusPill } from "./ticket-bits";
import { LABEL_TONES, type TicketRow } from "./ticket-types";

/** Paginated list view with per-row selection and a "load more" affordance. */
export function TicketListView({
  filtered,
  checked,
  setChecked,
  onSelect,
  locale,
  pending,
  cursor,
  rowsCount,
  onLoadMore,
}: {
  filtered: TicketRow[];
  checked: string[];
  setChecked: Dispatch<SetStateAction<string[]>>;
  onSelect: (id: string) => void;
  locale: string;
  pending: boolean;
  cursor: string | null;
  rowsCount: number;
  onLoadMore: () => void;
}) {
  return (
    <>
      <ul className="divide-y divide-border rounded-xl border border-border">
        {filtered.length === 0 && <li className="px-3 py-6 text-sm text-muted">No tickets match.</li>}
        {filtered.map((ticket) => (
          <li key={ticket.id} className="flex items-center gap-3 px-3 py-2 hover:bg-surface-2">
            <input
              type="checkbox"
              aria-label={`Select ${ticket.key}`}
              checked={checked.includes(ticket.id)}
              onChange={(event) =>
                setChecked((current) =>
                  event.target.checked
                    ? [...current, ticket.id]
                    : current.filter((id) => id !== ticket.id),
                )
              }
            />
            <button
              type="button"
              onClick={() => onSelect(ticket.id)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <span aria-hidden>{typeMeta(ticket.type).icon}</span>
              <span className="w-16 shrink-0 font-mono text-[11px] text-muted">{ticket.key}</span>
              <span className="min-w-0 flex-1 truncate text-sm">{ticket.title}</span>
              {ticket.labels.map((label) => (
                <LabelChip key={label.id} name={label.name} color={label.color} />
              ))}
              {ticket.childCount > 0 && (
                <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">
                  {ticket.childCount} sub
                </span>
              )}
            </button>
            <span className="hidden w-20 text-right text-xs text-muted sm:block">
              {formatEstimate(ticket.estimate, ticket.estimateUnit ?? "points")}
            </span>
            <span className="hidden w-24 truncate text-xs text-muted md:block">
              {ticket.assigneeName ?? "Unassigned"}
            </span>
            <span className="hidden w-20 text-xs text-muted lg:block">
              {priorityMeta(ticket.priority).label}
            </span>
            <StatusPill status={ticket.status} />
          </li>
        ))}
      </ul>

      {cursor && (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted">
          <button
            type="button"
            disabled={pending}
            onClick={onLoadMore}
            className="h-8 rounded border border-border px-3 text-sm hover:bg-surface-2 disabled:opacity-50"
          >
            {t(locale, "loadMore")}
          </button>
          <span>showing {rowsCount} of the workspace&apos;s tickets</span>
        </div>
      )}
    </>
  );
}

/** Kanban board grouped by status, with drag-to-move between columns. */
export function TicketBoardView({
  filtered,
  onSelect,
  onMove,
}: {
  filtered: TicketRow[];
  onSelect: (id: string) => void;
  onMove: (ticketId: string, status: string) => void;
}) {
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {groupByStatus(filtered).map((column) => (
        <div
          key={column.status}
          className="flex w-64 shrink-0 flex-col rounded-xl border border-border"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            const ticketId = event.dataTransfer.getData("text/ticket");
            if (!ticketId) return;
            onMove(ticketId, column.status);
          }}
        >
          <p className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted">
            <CircleDot className="h-3 w-3" /> {column.label}
            <span className="ml-auto">
              {column.tickets.length} · {column.estimate}
            </span>
          </p>
          <ul className="flex-1 space-y-2 p-2">
            {column.tickets.map((ticket) => (
              <li
                key={ticket.id}
                draggable
                onDragStart={(event) => event.dataTransfer.setData("text/ticket", ticket.id)}
                className="cursor-grab rounded-lg border border-border bg-bg p-2 active:cursor-grabbing"
              >
                <button
                  type="button"
                  onClick={() => onSelect(ticket.id)}
                  className="block w-full text-left"
                >
                  <span className="flex items-center gap-1.5 text-[11px] text-muted">
                    {typeMeta(ticket.type).icon} {ticket.key}
                    <span className="ml-auto">{priorityMeta(ticket.priority).label}</span>
                  </span>
                  <span className="mt-0.5 block text-sm">{ticket.title}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-1">
                    {ticket.labels.map((label) => (
                      <LabelChip key={label.id} name={label.name} color={label.color} />
                    ))}
                    {ticket.estimate !== null && (
                      <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">
                        {formatEstimate(ticket.estimate, ticket.estimateUnit ?? "points")}
                      </span>
                    )}
                    {ticket.dueDate && (
                      <span className="text-[10px] text-muted">
                        {<LocalTime value={ticket.dueDate} mode="date" />}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Timeline/Gantt over the tickets that have dates (undated ones are flagged). */
export function TicketTimeline({
  tickets,
  onOpen,
}: {
  tickets: TicketRow[];
  onOpen: (id: string) => void;
}) {
  const layout = timelineLayout(
    tickets.map((ticket) => ({
      id: ticket.id,
      key: ticket.key,
      title: ticket.title,
      status: ticket.status,
      priority: ticket.priority,
      type: ticket.type,
      estimate: ticket.estimate,
      estimateUnit: ticket.estimateUnit,
      startDate: ticket.startDate,
      dueDate: ticket.dueDate,
    })),
  );
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="mb-3 flex items-center justify-between text-xs text-muted">
        <span>
          {layout.from.toLocaleDateString()} → {layout.to.toLocaleDateString()} · {layout.days} days
        </span>
        <span>Dashed line = today · bar = start → due · label = estimate</span>
      </div>
      <div className="relative">
        <div
          className="absolute -top-1 bottom-0 z-10 border-l border-dashed border-accent"
          style={{ left: `${layout.todayOffset}%` }}
          aria-hidden
        />
        <ul className="space-y-1.5">
          {layout.rows.map((row) => {
            const ticket = byId.get(row.ticket.id)!;
            const meta = statusMeta(ticket.status);
            return (
              <li key={row.ticket.id} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onOpen(ticket.id)}
                  className="w-56 shrink-0 truncate text-left text-xs text-muted hover:text-fg"
                >
                  <span className="font-mono">{ticket.key}</span> {ticket.title}
                </button>
                <div className="relative h-6 flex-1 rounded bg-surface-2/60">
                  <button
                    type="button"
                    onClick={() => onOpen(ticket.id)}
                    title={`${ticket.key} · ${formatEstimate(ticket.estimate, ticket.estimateUnit ?? "points")}`}
                    className={cn(
                      "absolute inset-y-1 flex items-center gap-1 overflow-hidden rounded px-1.5 text-[10px] font-medium",
                      LABEL_TONES[meta.color] ?? LABEL_TONES.gray,
                      !row.hasDates && "opacity-60",
                    )}
                    style={{ left: `${row.left}%`, width: `${Math.max(row.width, 3)}%` }}
                  >
                    {typeMeta(ticket.type).icon}
                    <span className="truncate">
                      {ticket.estimate !== null
                        ? formatEstimate(ticket.estimate, ticket.estimateUnit ?? "points")
                        : "no estimate"}
                    </span>
                  </button>
                </div>
                <span className="w-20 shrink-0 text-right text-[10px] text-muted">
                  {ticket.dueDate ? new Date(ticket.dueDate).toLocaleDateString() : "no date"}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
