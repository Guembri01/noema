import { useState, type Dispatch, type SetStateAction } from "react";
import { Ban, CircleDot, Inbox } from "lucide-react";
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
import { applySort, type SortSpec } from "@/lib/sort-compare";
import { tagStyle, Z } from "@/lib/design-tokens";
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
import { Avatar } from "@/components/ui/avatar";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import {
  CountChip,
  KeyListChip,
  RelativeDateChip,
  SlaChip,
  StatusPill,
} from "./ticket-bits";
import { type TicketRow } from "./ticket-types";

/** `TicketRelation`-shaped rows accepted as an optional dependency source. */
type RelationInput = { fromId: string; toId: string; type: string };

/** Ticket colour name → design-system `Badge` tone (tokens only, no palette classes). */
const COLOR_BADGE_TONE: Record<string, BadgeTone> = {
  gray: "neutral",
  brown: "neutral",
  blue: "accent",
  teal: "accent",
  purple: "accent",
  pink: "accent",
  yellow: "warning",
  orange: "warning",
  green: "success",
  red: "danger",
};

/** Pure mapping from a ticket colour (`statusMeta`/`priorityMeta`) to a `Badge` tone. */
export function statusBadgeTone(color: string | null | undefined): BadgeTone {
  return (color ? COLOR_BADGE_TONE[color] : undefined) ?? "neutral";
}

/** A ticket label rendered as a token-coloured `Tag`. */
function LabelTag({ name, color }: { name: string; color: string }) {
  return (
    <Tag hue={color} size="sm">
      {name}
    </Tag>
  );
}


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

/**
 * Ticket fields the list view can be sorted by. These are the `propertyId`s the
 * engine receives; any other key is ignored rather than guessed at, so a stale
 * spec can never reorder rows the caller did not name.
 */
export type TicketSortField = "estimate" | "priority" | "status" | "date" | "assignee";

/**
 * A `SortSpec` narrowed to one of the ticket fields above. `dir`, `type`,
 * `optionOrder` and `nulls` keep their engine meaning, so a caller can rank
 * `priority` or `status` into a custom order via `optionOrder` and the shared
 * engine honours it.
 */
export type TicketSortSpec = Omit<SortSpec, "propertyId"> & { propertyId: TicketSortField };

const TICKET_SORT_FIELDS: readonly string[] = [
  "estimate",
  "priority",
  "status",
  "date",
  "assignee",
];

function isTicketSortField(propertyId: string): propertyId is TicketSortField {
  return TICKET_SORT_FIELDS.includes(propertyId);
}

/**
 * Raw cell value for one sortable ticket field, shaped for the engine's typed
 * comparisons: `estimate` is a number, `date` an ISO string (`dateKey` parses
 * it), and `priority`/`status`/`assignee` plain text. `null`/`undefined` marks
 * an empty cell, which the engine keeps at the chosen end.
 */
const TICKET_SORT_VALUES: Record<TicketSortField, (ticket: TicketRow) => unknown> = {
  estimate: (ticket) => ticket.estimate,
  priority: (ticket) => ticket.priority,
  status: (ticket) => ticket.status,
  date: (ticket) => ticket.dueDate,
  assignee: (ticket) => ticket.assigneeName,
};

/**
 * Order the list rows through the shared multi-key sort engine
 * (`@/lib/sort-compare`). Rows are wrapped into the engine's `SortRow` shape
 * (carrying the original ticket) so the ordering stays a pure comparison, then
 * unwrapped. An absent/empty `sortSpecs` — or one with no recognised ticket
 * field — returns an equal copy in the incoming order, so a list without a
 * supplied sort renders exactly as before.
 */
function sortTicketRows(
  rows: readonly TicketRow[],
  specs: readonly TicketSortSpec[] | undefined,
): TicketRow[] {
  if (!specs || specs.length === 0) return [...rows];
  const known = specs.filter((spec) => isTicketSortField(spec.propertyId));
  if (known.length === 0) return [...rows];
  const wrapped = rows.map((ticket) => ({
    id: ticket.id,
    propertyValues: known.map((spec) => ({
      propertyId: spec.propertyId,
      value: TICKET_SORT_VALUES[spec.propertyId](ticket),
    })),
    ticket,
  }));
  return applySort(wrapped, known).map((entry) => entry.ticket);
}

/** The `Badge` tone for a capacity state (tokens only). */
const CAPACITY_TONE: Record<CapacityState, BadgeTone> = {
  over: "danger",
  near: "warning",
  under: "success",
  unknown: "neutral",
};

/** Dev-only flag when the supplied relations close a loop. */
function DevCycleNotice({ cycle }: { cycle: string[] | null }) {
  if (!cycle) return null;
  return (
    <p className="mb-2 rounded-sm border border-dashed border-warning bg-warning-soft px-2 py-1 text-2xs text-warning">
      Dependency cycle: {cycle.join(" → ")}
    </p>
  );
}

/** "blocked by N" badge listing the blocker keys in its tooltip. */
function DependencyBadge({ blockers, locale }: { blockers: TicketRow[]; locale: string }) {
  return (
    <Badge
      tone="warning"
      size="sm"
      className="shrink-0"
      icon={<Ban className="h-3 w-3" aria-hidden />}
      title={`${t(locale, "relationBlockedBy")}: ${blockers
        .map((blocker) => blocker.key)
        .join(", ")}`}
    >
      {t(locale, "relationBlockedBy")} {blockers.length}
    </Badge>
  );
}

/** "blocks N" badge listing the held-up keys in its tooltip. */
function BlockingBadge({ dependents, locale }: { dependents: TicketRow[]; locale: string }) {
  return (
    <Badge
      tone="accent"
      size="sm"
      className="shrink-0"
      icon={<Ban className="h-3 w-3 -scale-x-100" aria-hidden />}
      title={`${t(locale, "relationBlocks")}: ${dependents
        .map((dependent) => dependent.key)
        .join(", ")}`}
    >
      {dependents.length} {t(locale, "relationBlocks")}
    </Badge>
  );
}

/** Per-assignee open load, tinted by capacity state once a limit is supplied. */
function WorkloadChip({
  bucket,
  capacity,
  locale,
  className,
}: {
  bucket: WorkloadBucket | undefined;
  capacity: CapacityRow | undefined;
  /** BCP-47 locale for the open count's number/noun; English when omitted. */
  locale?: string;
  className?: string;
}) {
  if (!bucket) return null;
  const estimate = formatEstimate(bucket.points, bucket.unit);
  const load = `${bucket.openCount} open · ${estimate}`;
  return (
    <Badge
      tone={capacity ? CAPACITY_TONE[capacity.state] : "neutral"}
      size="sm"
      className={cn("shrink-0", className)}
      title={capacity && capacity.limit !== null ? `${load} / ${capacity.limit}` : load}
    >
      <CountChip
        count={bucket.openCount}
        one="open"
        other="open"
        locale={locale}
        className="rounded-none p-0 text-inherit"
      />
      {` · ${estimate}`}
    </Badge>
  );
}

/**
 * One board card. Extracted from the board column so it can be rendered
 * statically (SSR test) and so the column stays a thin map.
 *
 * ds08: labels render as token `Tag`s, the priority as a `Badge`, the assignee
 * as an `Avatar`, and the surface carries the design-system hover lift —
 * `.u-interactive` + `.u-surface` (border/shadow/background only, never size).
 * The drag class contract (`cursor-grab` / `active:cursor-grabbing`) is kept.
 */
export function BoardCard({
  ticket,
  locale = "en",
  blockers,
  dependents,
  bucket,
  capacity,
  slaRow,
  onSelect,
}: {
  ticket: TicketRow;
  locale?: string;
  blockers?: TicketRow[];
  dependents?: TicketRow[];
  bucket?: WorkloadBucket;
  capacity?: CapacityRow;
  slaRow?: SlaStatusResult;
  onSelect?: (id: string) => void;
}) {
  const assignee = ticket.assigneeName
    ? {
        id: ticket.assigneeId ?? ticket.assigneeName,
        name: ticket.assigneeName,
        email: ticket.assigneeEmail,
      }
    : null;

  return (
    <article
      data-testid="ticket-board-card"
      data-ticket={ticket.key}
      className={cn(
        "cursor-grab rounded-lg border border-border bg-bg p-2 shadow-1",
        "u-interactive u-surface hover:border-border-strong hover:bg-surface hover:shadow-2",
        "active:cursor-grabbing",
      )}
    >
      <button
        type="button"
        onClick={() => onSelect?.(ticket.id)}
        className="focus-ring block w-full rounded-sm text-left"
      >
        <span className="flex items-center gap-1.5 text-2xs text-muted">
          <span aria-hidden>{typeMeta(ticket.type).icon}</span>
          <span className="font-mono">{ticket.key}</span>
          <Badge
            tone={statusBadgeTone(priorityMeta(ticket.priority).color)}
            size="sm"
            className="ms-auto"
          >
            {priorityMeta(ticket.priority).label}
          </Badge>
          {assignee ? <Avatar user={assignee} size={20} /> : null}
        </span>
        <span className="mt-0.5 block text-sm">{ticket.title}</span>
        <span className="mt-1 flex flex-wrap items-center gap-1">
          {ticket.labels.map((label) => (
            <LabelTag key={label.id} name={label.name} color={label.color} />
          ))}
          {ticket.estimate !== null && (
            <Badge tone="neutral" size="sm">
              {formatEstimate(ticket.estimate, ticket.estimateUnit ?? "points")}
            </Badge>
          )}
          <RelativeDateChip date={ticket.dueDate} locale={locale} />
          {slaRow && <SlaChip status={slaRow.status} remainingMs={slaRow.remainingMs} />}
        </span>
        {blockers && (
          <span className="mt-1 flex flex-wrap items-center gap-1">
            <DependencyBadge blockers={blockers} locale={locale} />
            <KeyListChip keys={blockers.map((blocker) => blocker.key)} locale={locale} />
          </span>
        )}
        {dependents && (
          <span className="mt-1 flex flex-wrap items-center gap-1">
            <BlockingBadge dependents={dependents} locale={locale} />
            <KeyListChip keys={dependents.map((dependent) => dependent.key)} locale={locale} />
          </span>
        )}
        {bucket && (
          <span className="mt-1 flex items-center gap-1 text-3xs text-muted">
            <span className="max-w-24 truncate">{ticket.assigneeName}</span>
            <WorkloadChip bucket={bucket} capacity={capacity} locale={locale} />
          </span>
        )}
      </button>
    </article>
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
  sortSpecs,
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
  /**
   * Optional ordered sort keys (see `@/lib/sort-compare`). Omitted/empty keeps
   * the incoming order untouched, so this stays purely additive.
   */
  sortSpecs?: readonly TicketSortSpec[];
}) {
  const rows = sortTicketRows(filtered, sortSpecs);
  const dependencies = buildDependencyView(rows, edges, relations);
  const workload = buildWorkloadView(rows, capacityByUser);
  const sla = buildSlaView(rows, slaPolicy);
  const blocked = dependencies.blockersByTicket.size;

  return (
    <>
      <DevCycleNotice cycle={dependencies.cycle} />
      {blocked > 0 && (
        <p className="mb-2 text-2xs text-muted">
          {blocked} {t(locale, "relationBlockedBy")} unfinished work
        </p>
      )}

      {rows.length === 0 ? (
        pending ? (
          <Skeleton variant="table" rows={6} cols={4} data-testid="ticket-list-loading" />
        ) : (
          <div className="rounded-xl border border-dashed border-border">
            <EmptyState
              variant="compact"
              icon={<Inbox className="h-5 w-5" aria-hidden />}
              title="No tickets match"
              description="Adjust the filters or search to see more."
            />
          </div>
        )
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {rows.map((ticket) => {
            const blockers = dependencies.blockersByTicket.get(ticket.id);
            const dependents = dependencies.dependentsByTicket.get(ticket.id);
            const bucket = ticket.assigneeId
              ? workload.bucketsById.get(ticket.assigneeId)
              : undefined;
            const capacity = ticket.assigneeId
              ? workload.capacityById.get(ticket.assigneeId)
              : undefined;
            const slaRow = sla.get(ticket.id);
            const selected = checked.includes(ticket.id);
            return (
              <li
                key={ticket.id}
                data-selected={selected ? "true" : undefined}
                className={cn(
                  "u-colors flex items-center gap-3 px-3 py-2",
                  selected ? "bg-surface-2" : "hover:bg-surface-2",
                )}
              >
                <input
                  type="checkbox"
                  aria-label={`${t(locale, "select")} ${ticket.key}`}
                  checked={selected}
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
                  className="focus-ring u-interactive flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left"
                >
                  <span aria-hidden>{typeMeta(ticket.type).icon}</span>
                  <span className="w-16 shrink-0 font-mono text-2xs text-muted">{ticket.key}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{ticket.title}</span>
                  {ticket.labels.map((label) => (
                    <LabelTag key={label.id} name={label.name} color={label.color} />
                  ))}
                  {ticket.childCount > 0 && (
                    <Badge tone="neutral" size="sm">
                      {`${ticket.childCount} sub`}
                    </Badge>
                  )}
                </button>
                {blockers && <DependencyBadge blockers={blockers} locale={locale} />}
                {blockers && (
                  <KeyListChip
                    keys={blockers.map((blocker) => blocker.key)}
                    locale={locale}
                    className="hidden lg:inline-flex"
                  />
                )}
                {dependents && <BlockingBadge dependents={dependents} locale={locale} />}
                {dependents && (
                  <KeyListChip
                    keys={dependents.map((dependent) => dependent.key)}
                    locale={locale}
                    className="hidden lg:inline-flex"
                  />
                )}
                {bucket && (
                  <WorkloadChip
                    bucket={bucket}
                    capacity={capacity}
                    locale={locale}
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
                <RelativeDateChip
                  date={ticket.dueDate}
                  locale={locale}
                  className="hidden sm:inline-flex"
                />
                {slaRow && <SlaChip status={slaRow.status} remainingMs={slaRow.remainingMs} />}
                <StatusPill status={ticket.status} />
              </li>
            );
          })}
        </ul>
      )}

      {cursor && (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted">
          <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={onLoadMore}>
            {t(locale, "loadMore")}
          </Button>
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
  pending = false,
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
  /** Loading flag: empty columns render a matching card skeleton. */
  pending?: boolean;
}) {
  const dependencies = buildDependencyView(filtered, edges, relations);
  const workload = buildWorkloadView(filtered, capacityByUser);
  const sla = buildSlaView(filtered, slaPolicy);
  const [dragging, setDragging] = useState<string | null>(null);
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
        <div className="mb-3 flex flex-wrap items-center gap-2 text-2xs text-muted">
          <span className="font-medium uppercase tracking-wide">Workload</span>
          {workloadBuckets.map((bucket) => (
            <span key={bucket.assigneeId} className="flex items-center gap-1">
              <span className="max-w-24 truncate">
                {assigneeNames.get(bucket.assigneeId) ?? bucket.assigneeId}
              </span>
              <WorkloadChip
                bucket={bucket}
                capacity={workload.capacityById.get(bucket.assigneeId)}
                locale={locale}
              />
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
              <CircleDot className="h-3 w-3" aria-hidden /> {column.label}
              <Badge tone="neutral" size="sm" count={column.tickets.length} className="ms-auto" />
              <span className="tabular-nums">{column.estimate}</span>
            </p>
            <ul className="flex-1 space-y-2 p-2">
              {pending && column.tickets.length === 0 ? (
                <li className="list-none">
                  <Skeleton variant="card" data-testid="ticket-board-loading" />
                </li>
              ) : column.tickets.length === 0 ? (
                <li className="list-none">
                  <EmptyState
                    variant="compact"
                    title="No tickets"
                    description="Drop a ticket here."
                  />
                </li>
              ) : (
                column.tickets.map((ticket) => {
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
                      onDragStart={(event) => {
                        setDragging(ticket.id);
                        event.dataTransfer.setData("text/ticket", ticket.id);
                      }}
                      onDragEnd={() => setDragging(null)}
                      className={cn("list-none", dragging === ticket.id && "u-no-transition")}
                    >
                      <BoardCard
                        ticket={ticket}
                        locale={locale}
                        blockers={blockers}
                        dependents={dependents}
                        bucket={bucket}
                        capacity={capacity}
                        slaRow={slaRow}
                        onSelect={onSelect}
                      />
                    </li>
                  );
                })
              )}
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
  pending = false,
}: {
  tickets: TicketRow[];
  onOpen: (id: string) => void;
  /** Loading flag: renders a timeline-shaped skeleton instead of rows. */
  pending?: boolean;
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

  if (pending) {
    return (
      <div className="rounded-xl border border-border p-4">
        <Skeleton variant="block" height={16} width="40%" />
        <div className="mt-3 space-y-1.5">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} variant="block" height={24} />
          ))}
        </div>
      </div>
    );
  }

  if (layout.rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border">
        <EmptyState
          variant="full"
          icon={<Inbox className="h-5 w-5" aria-hidden />}
          title="Nothing on the timeline"
          description="Give a ticket a start or due date to plot it here."
        />
      </div>
    );
  }

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
          className="absolute -top-1 bottom-0 border-l border-dashed border-accent"
          style={{ left: `${layout.todayOffset}%`, zIndex: Z.sticky }}
          aria-hidden
        />
        <ul className="space-y-1.5">
          {layout.rows.map((row) => {
            const ticket = byId.get(row.ticket.id)!;
            const meta = statusMeta(ticket.status);
            const accent = tagStyle(meta.color);
            return (
              <li key={row.ticket.id} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onOpen(ticket.id)}
                  className="focus-ring u-interactive w-56 shrink-0 truncate rounded-sm text-left text-xs text-muted hover:text-fg"
                >
                  <span className="font-mono">{ticket.key}</span> {ticket.title}
                </button>
                <div className="relative h-6 flex-1 rounded-sm bg-surface-2/60">
                  <button
                    type="button"
                    onClick={() => onOpen(ticket.id)}
                    title={`${ticket.key} · ${formatEstimate(ticket.estimate, ticket.estimateUnit ?? "points")}`}
                    className={cn(
                      "focus-ring u-colors absolute inset-y-1 flex items-center gap-1 overflow-hidden rounded-sm border px-1.5 text-3xs font-medium",
                      !row.hasDates && "opacity-60",
                    )}
                    style={{
                      left: `${row.left}%`,
                      width: `${Math.max(row.width, 3)}%`,
                      ...accent,
                    }}
                  >
                    {typeMeta(ticket.type).icon}
                    <span className="truncate">
                      {ticket.estimate !== null
                        ? formatEstimate(ticket.estimate, ticket.estimateUnit ?? "points")
                        : "no estimate"}
                    </span>
                  </button>
                </div>
                <span className="w-20 shrink-0 text-right text-3xs text-muted">
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
