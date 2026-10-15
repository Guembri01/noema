import type { Dispatch, SetStateAction } from "react";
import { Ban, CircleDot } from "lucide-react";
import { LocalTime } from "@/components/local-time";
import { addBusinessHours, type WorkingHours } from "@/lib/business-hours";
import {
  blockersOf,
  buildDependencyGraph,
  dependentsOf,
  edgesFromRelations,
  findCycle,
  isBlocked,
  type DependencyEdge,
} from "@/lib/dependencies";
import { t } from "@/lib/i18n";
import { slaStatus, type SlaClock, type SlaStatusResult } from "@/lib/sla-timer";
import {
  capacityStatus,
  formatEstimate,
  groupByStatus,
  isClosed,
  priorityMeta,
  statusMeta,
  timelineLayout,
  typeMeta,
  UNASSIGNED_BUCKET,
  workloadByAssignee,
  type CapacityLimits,
  type CapacityRow,
  type CapacityState,
  type WorkloadBucket,
} from "@/lib/tickets";
import { cn } from "@/lib/utils";
import { LabelChip, SlaChip, StatusPill } from "./ticket-bits";
import { LABEL_TONES, type TicketRow } from "./ticket-types";

/** `TicketRelation`-shaped rows accepted as an optional dependency source. */
type RelationInput = { fromId: string; toId: string; type: string };

/** Capacity-state tones, deliberately matching the status palette. */
const CAPACITY_TONES: Record<CapacityState, string> = {
  over: "bg-red-500/10 text-red-500",
  near: "bg-amber-500/10 text-amber-600",
  under: "bg-emerald-500/10 text-emerald-600",
  unknown: "bg-surface-2 text-muted",
};

/**
 * Edges to draw: the explicit `edges` prop wins; otherwise derive them from the
 * optional `relations` prop. With neither, the graph is empty and the views
 * render exactly as before.
 */
function dependencyEdges(
  edges: readonly DependencyEdge[] | undefined,
  relations: readonly RelationInput[] | undefined,
): DependencyEdge[] {
  if (edges && edges.length > 0) return [...edges];
  if (relations && relations.length > 0) return edgesFromRelations(relations);
  return [];
}

type DependencyView = {
  /** Blocked ticket id → its unfinished direct blockers, in graph order. */
  blockersByTicket: Map<string, TicketRow[]>;
  /** Blocker ticket id → the unfinished tickets it blocks, in graph order. */
  dependentsByTicket: Map<string, TicketRow[]>;
  /** Dev-only cycle path, or null when acyclic. */
  cycle: string[] | null;
};

/**
 * Blocked-by/blocking state for the rows on screen, backed by
 * `@/lib/dependencies`. Blockers missing from the current page are treated as
 * done, so a keyset-paginated list never invents a "blocked" badge for work it
 * cannot see. The cycle check is dev-only and free in production builds.
 */
function buildDependencyView(
  rows: TicketRow[],
  edges: readonly DependencyEdge[] | undefined,
  relations: readonly RelationInput[] | undefined,
): DependencyView {
  const graph = buildDependencyGraph(dependencyEdges(edges, relations));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const isDone = (id: string) => {
    const blocker = byId.get(id);
    return blocker ? isClosed(blocker.status) : true;
  };
  const blockersByTicket = new Map<string, TicketRow[]>();
  const dependentsByTicket = new Map<string, TicketRow[]>();
  for (const row of rows) {
    if (isBlocked(graph, row.id, isDone)) {
      const open = blockersOf(graph, row.id)
        .filter((id) => !isDone(id))
        .map((id) => byId.get(id))
        .filter((blocker): blocker is TicketRow => blocker !== undefined);
      blockersByTicket.set(row.id, open);
    }
    // "blocking" is the mirror view: still-open tickets this row holds up.
    const blocked = dependentsOf(graph, row.id)
      .filter((id) => !isDone(id))
      .map((id) => byId.get(id))
      .filter((dependent): dependent is TicketRow => dependent !== undefined);
    if (blocked.length > 0) dependentsByTicket.set(row.id, blocked);
  }
  return {
    blockersByTicket,
    dependentsByTicket,
    cycle: process.env.NODE_ENV === "production" ? null : findCycle(graph),
  };
}

type WorkloadView = {
  bucketsById: Map<string, WorkloadBucket>;
  capacityById: Map<string, CapacityRow>;
};

/** Per-assignee open load; capacity rows appear only when limits are supplied. */
function buildWorkloadView(
  rows: TicketRow[],
  capacityByUser: Partial<Record<string, CapacityLimits>> | undefined,
): WorkloadView {
  const buckets = workloadByAssignee(rows);
  const capacity = capacityStatus(buckets, capacityByUser ?? {});
  return {
    bucketsById: new Map(buckets.map((bucket) => [bucket.assigneeId, bucket])),
    capacityById: new Map(capacity.map((row) => [row.assigneeId, row])),
  };
}

/**
 * Optional SLA configuration for the list/board chips. Every input the timer
 * needs is supplied by the caller; the bare prop is opt-in, so omitting it
 * leaves the rows byte-for-byte as they were.
 *
 * A ticket's timer opens at its `startDate` (tickets without one show no chip)
 * and its due instant is `startDate + hours` measured on the `workingHours`
 * calendar via `addBusinessHours`, so weekends and holidays stretch — not
 * shrink — the budget. `slaStatus` then grades the deadline against `now`.
 */
export type TicketSlaPolicy = {
  /** SLA budget in working hours from the ticket's start instant. */
  hours: number;
  /** UTC working calendar used to place the due instant. */
  workingHours: WorkingHours;
  /** Elapsed-window percentage at which the chip turns `warning`. */
  warnAtPercent?: number;
  /** Injected wall clock for deterministic grading; defaults to render time. */
  now?: SlaClock;
};

/** Per-ticket SLA grade, present only for tickets a supplied policy covers. */
function buildSlaView(
  rows: TicketRow[],
  policy: TicketSlaPolicy | undefined,
): Map<string, SlaStatusResult> {
  const view = new Map<string, SlaStatusResult>();
  if (!policy) return view;
  const now = policy.now ?? Date.now();
  for (const ticket of rows) {
    const anchor = ticket.startDate;
    if (!anchor) continue;
    const due = addBusinessHours(anchor, policy.hours, policy.workingHours);
    const dueMs = due.getTime();
    const startedMs = Date.parse(anchor);
    if (!Number.isFinite(dueMs)) continue;
    // The real span (incl. non-working gaps) drives the warning band so a
    // weekend inside the budget does not silently disable it.
    const windowMs = Number.isFinite(startedMs) ? dueMs - startedMs : undefined;
    view.set(
      ticket.id,
      slaStatus(now, dueMs, { warnAtPercent: policy.warnAtPercent, windowMs }),
    );
  }
  return view;
}

/** Dev-only flag when the supplied relations close a loop. */
function DevCycleNotice({ cycle }: { cycle: string[] | null }) {
  if (!cycle) return null;
  return (
    <p className="mb-2 rounded border border-dashed border-amber-500/40 px-2 py-1 text-[11px] text-amber-600">
      Dependency cycle: {cycle.join(" → ")}
    </p>
  );
}

/** "blocked by N" badge listing the blocker keys in its tooltip. */
function DependencyBadge({ blockers, locale }: { blockers: TicketRow[]; locale: string }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600"
      title={`${t(locale, "relationBlockedBy")}: ${blockers
        .map((blocker) => blocker.key)
        .join(", ")}`}
    >
      <Ban className="h-3 w-3" aria-hidden />
      {t(locale, "relationBlockedBy")} {blockers.length}
    </span>
  );
}

/** "blocks N" badge listing the held-up keys in its tooltip. */
function BlockingBadge({ dependents, locale }: { dependents: TicketRow[]; locale: string }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-600"
      title={`${t(locale, "relationBlocks")}: ${dependents
        .map((dependent) => dependent.key)
        .join(", ")}`}
    >
      <Ban className="h-3 w-3 -scale-x-100" aria-hidden />
      {dependents.length} {t(locale, "relationBlocks")}
    </span>
  );
}

/** Per-assignee open load, tinted by capacity state once a limit is supplied. */
function WorkloadChip({
  bucket,
  capacity,
  className,
}: {
  bucket: WorkloadBucket | undefined;
  capacity: CapacityRow | undefined;
  className?: string;
}) {
  if (!bucket) return null;
  const load = `${bucket.openCount} open · ${formatEstimate(bucket.points, bucket.unit)}`;
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-[10px]",
        capacity ? CAPACITY_TONES[capacity.state] : "bg-surface-2 text-muted",
        className,
      )}
      title={capacity && capacity.limit !== null ? `${load} / ${capacity.limit}` : load}
    >
      {load}
    </span>
  );
}

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
  edges,
  relations,
  capacityByUser,
  slaPolicy,
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
  /** Explicit dependency edges; when absent, `relations` is used, else none. */
  edges?: readonly DependencyEdge[];
  /** Optional `TicketRelation` rows (`blocks`/`blocked_by` become edges). */
  relations?: readonly RelationInput[];
  /** Optional per-assignee capacity limits that tint the workload chips. */
  capacityByUser?: Partial<Record<string, CapacityLimits>>;
  /** Optional SLA budget that adds a per-ticket `ok`/`warning`/`overdue` chip. */
  slaPolicy?: TicketSlaPolicy;
}) {
  const dependencies = buildDependencyView(filtered, edges, relations);
  const workload = buildWorkloadView(filtered, capacityByUser);
  const sla = buildSlaView(filtered, slaPolicy);
  const blocked = dependencies.blockersByTicket.size;

  return (
    <>
      <DevCycleNotice cycle={dependencies.cycle} />
      {blocked > 0 && (
        <p className="mb-2 text-[11px] text-muted">
          {blocked} {t(locale, "relationBlockedBy")} unfinished work
        </p>
      )}

      <ul className="divide-y divide-border rounded-xl border border-border">
        {filtered.length === 0 && <li className="px-3 py-6 text-sm text-muted">No tickets match.</li>}
        {filtered.map((ticket) => {
          const blockers = dependencies.blockersByTicket.get(ticket.id);
          const dependents = dependencies.dependentsByTicket.get(ticket.id);
          const bucket = ticket.assigneeId
            ? workload.bucketsById.get(ticket.assigneeId)
            : undefined;
          const capacity = ticket.assigneeId
            ? workload.capacityById.get(ticket.assigneeId)
            : undefined;
          const slaRow = sla.get(ticket.id);
          return (
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
              {blockers && <DependencyBadge blockers={blockers} locale={locale} />}
              {dependents && <BlockingBadge dependents={dependents} locale={locale} />}
              {bucket && (
                <WorkloadChip
                  bucket={bucket}
                  capacity={capacity}
                  className="hidden lg:inline-flex"
                />
              )}
              <span className="hidden w-20 text-right text-xs text-muted sm:block">
                {formatEstimate(ticket.estimate, ticket.estimateUnit ?? "points")}
              </span>
              <span className="hidden w-24 truncate text-xs text-muted md:block">
                {ticket.assigneeName ?? "Unassigned"}
              </span>
              <span className="hidden w-20 text-xs text-muted lg:block">
                {priorityMeta(ticket.priority).label}
              </span>
              {slaRow && <SlaChip status={slaRow.status} remainingMs={slaRow.remainingMs} />}
              <StatusPill status={ticket.status} />
            </li>
          );
        })}
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
  locale = "en",
  edges,
  relations,
  capacityByUser,
  slaPolicy,
}: {
  filtered: TicketRow[];
  onSelect: (id: string) => void;
  onMove: (ticketId: string, status: string) => void;
  /** Locale for the surfaced dependency/workload labels. */
  locale?: string;
  /** Explicit dependency edges; when absent, `relations` is used, else none. */
  edges?: readonly DependencyEdge[];
  /** Optional `TicketRelation` rows (`blocks`/`blocked_by` become edges). */
  relations?: readonly RelationInput[];
  /** Optional per-assignee capacity limits that tint the workload chips. */
  capacityByUser?: Partial<Record<string, CapacityLimits>>;
  /** Optional SLA budget that adds a per-ticket `ok`/`warning`/`overdue` chip. */
  slaPolicy?: TicketSlaPolicy;
}) {
  const dependencies = buildDependencyView(filtered, edges, relations);
  const workload = buildWorkloadView(filtered, capacityByUser);
  const sla = buildSlaView(filtered, slaPolicy);
  const assigneeNames = new Map(
    filtered
      .filter((ticket) => ticket.assigneeId)
      .map((ticket) => [ticket.assigneeId as string, ticket.assigneeName ?? ticket.assigneeId as string]),
  );
  const workloadBuckets = [...workload.bucketsById.values()].filter(
    (bucket) => bucket.assigneeId !== UNASSIGNED_BUCKET,
  );

  return (
    <div>
      <DevCycleNotice cycle={dependencies.cycle} />

      {workloadBuckets.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-muted">
          <span className="font-medium uppercase tracking-wide">Workload</span>
          {workloadBuckets.map((bucket) => (
            <span key={bucket.assigneeId} className="flex items-center gap-1">
              <span className="max-w-24 truncate">
                {assigneeNames.get(bucket.assigneeId) ?? bucket.assigneeId}
              </span>
              <WorkloadChip bucket={bucket} capacity={workload.capacityById.get(bucket.assigneeId)} />
            </span>
          ))}
        </div>
      )}

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
              {column.tickets.map((ticket) => {
                const blockers = dependencies.blockersByTicket.get(ticket.id);
                const dependents = dependencies.dependentsByTicket.get(ticket.id);
                const bucket = ticket.assigneeId
                  ? workload.bucketsById.get(ticket.assigneeId)
                  : undefined;
                const capacity = ticket.assigneeId
                  ? workload.capacityById.get(ticket.assigneeId)
                  : undefined;
                const slaRow = sla.get(ticket.id);
                return (
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
                        {slaRow && <SlaChip status={slaRow.status} remainingMs={slaRow.remainingMs} />}
                      </span>
                      {blockers && (
                        <span className="mt-1 flex flex-wrap items-center gap-1">
                          <DependencyBadge blockers={blockers} locale={locale} />
                          <span className="text-[10px] text-muted">
                            {blockers.map((blocker) => blocker.key).join(", ")}
                          </span>
                        </span>
                      )}
                      {dependents && (
                        <span className="mt-1 flex flex-wrap items-center gap-1">
                          <BlockingBadge dependents={dependents} locale={locale} />
                          <span className="text-[10px] text-muted">
                            {dependents.map((dependent) => dependent.key).join(", ")}
                          </span>
                        </span>
                      )}
                      {bucket && (
                        <span className="mt-1 flex items-center gap-1 text-[10px] text-muted">
                          <span className="max-w-24 truncate">{ticket.assigneeName}</span>
                          <WorkloadChip bucket={bucket} capacity={capacity} />
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
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
