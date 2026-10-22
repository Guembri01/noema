/**
 * Tickets domain: statuses, priorities, types, estimates and the maths behind
 * the board, the timeline and the rollups. Pure functions only — the UI, the
 * API and the tests all share them.
 */

import { descriptionToText } from "@/lib/description";

export const TICKET_STATUSES = [
  { id: "backlog", label: "Backlog", color: "gray", done: false },
  { id: "todo", label: "Todo", color: "blue", done: false },
  { id: "in_progress", label: "In progress", color: "yellow", done: false },
  { id: "in_review", label: "In review", color: "purple", done: false },
  { id: "done", label: "Done", color: "green", done: true },
  { id: "cancelled", label: "Cancelled", color: "red", done: true },
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number]["id"];

export const TICKET_PRIORITIES = [
  { id: "urgent", label: "Urgent", color: "red", weight: 4 },
  { id: "high", label: "High", color: "orange", weight: 3 },
  { id: "medium", label: "Medium", color: "yellow", weight: 2 },
  { id: "low", label: "Low", color: "blue", weight: 1 },
  { id: "none", label: "No priority", color: "gray", weight: 0 },
] as const;

export type TicketPriority = (typeof TICKET_PRIORITIES)[number]["id"];

export const TICKET_TYPES = [
  { id: "task", label: "Task", icon: "✓" },
  { id: "bug", label: "Bug", icon: "🐞" },
  { id: "feature", label: "Feature", icon: "✨" },
  { id: "epic", label: "Epic", icon: "🏔️" },
  { id: "chore", label: "Chore", icon: "🧹" },
] as const;

export type TicketType = (typeof TICKET_TYPES)[number]["id"];

export const ESTIMATE_UNITS = ["points", "hours", "days"] as const;
export type EstimateUnit = (typeof ESTIMATE_UNITS)[number];

export const LABEL_STYLES = [
  "gray",
  "blue",
  "green",
  "yellow",
  "orange",
  "red",
  "purple",
  "pink",
] as const;

export type NormalizedLabelInput =
  | { ok: true; name: string; color: string; description: string | null }
  | { ok: false; error: string };

/**
 * Pure label validation lifted out of `createLabelAction` (a "use server" file
 * cannot export it): trims + caps name (40) and description (200), falls back
 * to a known colour, and rejects blank names.
 */
export function normalizeLabelInput(input: {
  name: string;
  color?: string | null;
  description?: string | null;
}): NormalizedLabelInput {
  const name = input.name.trim().slice(0, 40);
  if (!name) return { ok: false, error: "Give the label a name." };
  const requested = input.color ?? "gray";
  const color = LABEL_STYLES.includes(requested as (typeof LABEL_STYLES)[number])
    ? requested
    : "gray";
  return { ok: true, name, color, description: input.description?.trim().slice(0, 200) || null };
}

export const RELATION_TYPES = [
  { id: "blocks", label: "Blocks", inverse: "blocked_by" },
  { id: "blocked_by", label: "Blocked by", inverse: "blocks" },
  { id: "relates", label: "Relates to", inverse: "relates" },
  { id: "duplicates", label: "Duplicates", inverse: "duplicates" },
] as const;

export type TicketRelationType = (typeof RELATION_TYPES)[number]["id"];

export function statusMeta(id: string) {
  return TICKET_STATUSES.find((status) => status.id === id) ?? TICKET_STATUSES[1];
}

export function priorityMeta(id: string) {
  return TICKET_PRIORITIES.find((priority) => priority.id === id) ?? TICKET_PRIORITIES[4];
}

export function typeMeta(id: string) {
  return TICKET_TYPES.find((type) => type.id === id) ?? TICKET_TYPES[0];
}

export function isClosed(status: string): boolean {
  return statusMeta(status).done;
}

/** `NOE-42`-style key from a workspace prefix and a number. */
export function ticketKey(prefix: string, number: number): string {
  const cleaned = prefix.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 4) || "NOE";
  return `${cleaned}-${number}`;
}

/** Default key prefix from a workspace name ("Demo Workspace" → "DW"). */
export function keyPrefix(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "NOE";
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words
    .slice(0, 3)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

/** Human estimate ("3 points", "1.5 days"). */
export function formatEstimate(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const rounded = Math.round(value * 100) / 100;
  const label = unit === "hours" ? (rounded === 1 ? "hour" : "hours") : unit === "days" ? (rounded === 1 ? "day" : "days") : rounded === 1 ? "point" : "points";
  return `${rounded} ${label}`;
}

/** Sum estimates, keeping the dominant unit (points by default). */
export function sumEstimates(
  items: { estimate: number | null; estimateUnit?: string | null }[],
): { total: number; unit: string; count: number } {
  const groups = new Map<string, number>();
  for (const item of items) {
    if (item.estimate === null || item.estimate === undefined) continue;
    const unit = item.estimateUnit ?? "points";
    groups.set(unit, (groups.get(unit) ?? 0) + item.estimate);
  }
  if (groups.size === 0) return { total: 0, unit: "points", count: items.length };
  const [unit, total] = [...groups.entries()].sort((a, b) => b[1] - a[1])[0];
  return { total: Math.round(total * 100) / 100, unit, count: items.length };
}

export type TicketLike = {
  id: string;
  key: string;
  title: string;
  status: string;
  priority: string;
  type: string;
  estimate: number | null;
  estimateUnit?: string | null;
  startDate: string | null;
  dueDate: string | null;
};

/** Group tickets into board columns, in workflow order. */
export function groupByStatus<T extends TicketLike>(
  tickets: T[],
): { status: TicketStatus; label: string; tickets: T[]; estimate: number }[] {
  return TICKET_STATUSES.map((status) => {
    const items = tickets.filter((ticket) => ticket.status === status.id);
    return {
      status: status.id,
      label: status.label,
      tickets: items,
      estimate: sumEstimates(items).total,
    };
  });
}

/** Sort for lists: priority first, then due date, then key (numerically: NOE-2 < NOE-10). */
export function sortTickets<T extends TicketLike>(tickets: T[]): T[] {
  return [...tickets].sort((a, b) => {
    const priority = priorityMeta(b.priority).weight - priorityMeta(a.priority).weight;
    if (priority !== 0) return priority;
    const aDue = a.dueDate ? new Date(a.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
    const bDue = b.dueDate ? new Date(b.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
    if (aDue !== bDue) return aDue - bDue;
    return a.key.localeCompare(b.key, undefined, { numeric: true });
  });
}

export type TimelineRow<T> = {
  ticket: T;
  /** Percentage offsets inside the timeline window. */
  left: number;
  width: number;
  hasDates: boolean;
};

/**
 * Lay tickets out on a timeline. Anything without dates falls back to a
 * one-day bar at "today" so it is still visible (and the UI flags it).
 */
export function timelineLayout<T extends TicketLike>(
  tickets: T[],
  options: { today?: Date; paddingDays?: number } = {},
): { rows: TimelineRow<T>[]; from: Date; to: Date; todayOffset: number; days: number } {
  const today = options.today ?? new Date();
  const oneDay = 24 * 60 * 60 * 1000;
  const dates: number[] = [today.getTime()];
  for (const ticket of tickets) {
    if (ticket.startDate) dates.push(new Date(ticket.startDate).getTime());
    if (ticket.dueDate) dates.push(new Date(ticket.dueDate).getTime());
  }
  const padding = (options.paddingDays ?? 2) * oneDay;
  const from = new Date(Math.min(...dates) - padding);
  const to = new Date(Math.max(...dates) + padding);
  const span = Math.max(to.getTime() - from.getTime(), oneDay);

  const pct = (value: number) => ((value - from.getTime()) / span) * 100;
  const rows = tickets.map((ticket) => {
    const start = ticket.startDate ? new Date(ticket.startDate).getTime() : null;
    const due = ticket.dueDate ? new Date(ticket.dueDate).getTime() : null;
    const hasDates = start !== null || due !== null;
    const begin = start ?? due ?? today.getTime();
    const end = due !== null && due >= begin ? due : begin + oneDay;
    return {
      ticket,
      left: Math.max(0, Math.min(100, pct(begin))),
      width: Math.max(1.2, Math.min(100, pct(end) - pct(begin))),
      hasDates,
    };
  });

  return {
    rows,
    from,
    to,
    todayOffset: Math.max(0, Math.min(100, pct(today.getTime()))),
    days: Math.round(span / oneDay),
  };
}

/** Progress of a set of tickets: closed vs total, plus estimate remaining. */
export function ticketProgress(tickets: TicketLike[]) {
  const total = tickets.length;
  const closed = tickets.filter((ticket) => isClosed(ticket.status)).length;
  const remaining = sumEstimates(tickets.filter((ticket) => !isClosed(ticket.status)));
  return {
    total,
    closed,
    open: total - closed,
    percent: total === 0 ? 0 : Math.round((closed / total) * 100),
    remaining,
  };
}

/** Group tickets by a label id (tickets may carry several labels). */
export function groupByLabel<T extends { id: string }>(
  tickets: T[],
  labelsByTicket: Record<string, string[]>,
  labelIds: string[],
): { labelId: string | null; tickets: T[] }[] {
  const groups: { labelId: string | null; tickets: T[] }[] = labelIds.map((labelId) => ({
    labelId,
    tickets: tickets.filter((ticket) => (labelsByTicket[ticket.id] ?? []).includes(labelId)),
  }));
  const unlabeled = tickets.filter((ticket) => (labelsByTicket[ticket.id] ?? []).length === 0);
  if (unlabeled.length > 0) groups.push({ labelId: null, tickets: unlabeled });
  return groups;
}


/** Shape the tracker renders (kept in the lib so the page and its pages agree). */
export type TrackerTicket = {
  id: string;
  key: string;
  title: string;
  /** Plain-text description (sanitised), empty string when none. */
  description: string;
  /** The stored description doc, for the rich description editor. */
  descriptionDoc: unknown;
  type: string;
  status: string;
  priority: string;
  estimate: number | null;
  estimateUnit: string | null;
  startDate: string | null;
  dueDate: string | null;
  parentId: string | null;
  cycleId: string | null;
  projectId: string | null;
  projectName: string | null;
  /** The milestone the ticket is in, and its name for the read-only summary. */
  milestoneId: string | null;
  milestoneName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  assigneeEmail: string | null;
  labels: { id: string; name: string; color: string }[];
  labelIds: string[];
  commentCount: number;
  childCount: number;
};

type TicketRecord = {
  id: string;
  key: string;
  title: string;
  /** Stored `Ticket.description` doc (Json), as returned by the list select. */
  description?: unknown;
  type: string;
  status: string;
  priority: string;
  estimate: number | null;
  estimateUnit: string;
  startDate: Date | null;
  dueDate: Date | null;
  parentId: string | null;
  cycleId: string | null;
  project: { id: string; name: string; icon: string | null } | null;
  milestone: { id: string; name: string } | null;
  assignee: { id: string; name: string; email: string } | null;
  labels: { label: { id: string; name: string; color: string } }[];
  _count: { children: number; comments: number };
};

/** Prisma ticket rows -> the tracker's row shape (dates as ISO strings). */
export function toTrackerTicket(ticket: TicketRecord): TrackerTicket {
  return {
    id: ticket.id,
    key: ticket.key,
    title: ticket.title,
    description: descriptionToText(ticket.description),
    descriptionDoc: ticket.description ?? null,
    type: ticket.type,
    status: ticket.status,
    priority: ticket.priority,
    estimate: ticket.estimate,
    estimateUnit: ticket.estimateUnit,
    startDate: ticket.startDate?.toISOString() ?? null,
    dueDate: ticket.dueDate?.toISOString() ?? null,
    parentId: ticket.parentId,
    cycleId: ticket.cycleId,
    projectId: ticket.project?.id ?? null,
    projectName: ticket.project?.name ?? null,
    milestoneId: ticket.milestone?.id ?? null,
    milestoneName: ticket.milestone?.name ?? null,
    assigneeId: ticket.assignee?.id ?? null,
    assigneeName: ticket.assignee?.name ?? null,
    assigneeEmail: ticket.assignee?.email ?? null,
    labels: ticket.labels.map((entry) => entry.label),
    labelIds: ticket.labels.map((entry) => entry.label.id),
    commentCount: ticket._count.comments,
    childCount: ticket._count.children,
  };
}

/* ------------------------------------------------------------------------ *
 * Milestones — the one relation a ticket cannot set directly by name.
 *
 * Milestones belong to a project, so the ticket drawer has to answer two
 * questions purely: which milestones may this ticket use, and what happens to
 * the milestone it already has when its project changes.
 * ------------------------------------------------------------------------ */

/** A project and the milestones it owns, as `getProjects` returns them. */
export type MilestoneSource = {
  id: string;
  name: string;
  /** Absent when a caller only needs the project's identity (e.g. the composer). */
  milestones?: readonly { id: string; name: string }[];
};

/** One assignable milestone, carrying its project and its display label. */
export type MilestoneChoice = {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  /** `label` for the picker: the bare name, or project-qualified when unscoped. */
  label: string;
};

/**
 * The milestones a ticket can be assigned to. A milestone is a project's, so a
 * ticket that sits in a project offers that project's milestones only; a ticket
 * with no project offers every milestone in the workspace, each labelled with its
 * project so two "Launch" milestones stay tellable apart.
 */
export function milestoneChoices(
  projects: readonly MilestoneSource[],
  projectId: string | null,
): MilestoneChoice[] {
  const scoped = projectId ? projects.filter((project) => project.id === projectId) : projects;
  const qualify = projectId === null;
  return scoped.flatMap((project) =>
    (project.milestones ?? []).map((milestone) => ({
      id: milestone.id,
      name: milestone.name,
      projectId: project.id,
      projectName: project.name,
      label: qualify ? `${project.name} - ${milestone.name}` : milestone.name,
    })),
  );
}

/**
 * The milestone to keep when a ticket changes project. Switching to a project
 * that does not own the current milestone drops it (returning `null`, which the
 * caller sends as an explicit clear) instead of pairing the ticket with a
 * milestone from another project.
 */
export function milestoneAfterProjectChange(
  milestoneId: string | null,
  choices: readonly MilestoneChoice[],
): string | null {
  if (!milestoneId) return null;
  return choices.some((choice) => choice.id === milestoneId) ? milestoneId : null;
}

/* ------------------------------------------------------------------------ *
 * Workload & capacity — per-person load planning (MISSING_FEATURES §20).
 * Pure planning helpers over the assignee + estimate data the tickets
 * already carry; no DB, no UI. The panel wiring is a follow-up.
 * ------------------------------------------------------------------------ */

/** Bucket id used for tickets that have no assignee. */
export const UNASSIGNED_BUCKET = "unassigned";

/** Default ratio at which somebody counts as "near" their capacity. */
export const DEFAULT_NEAR_THRESHOLD = 0.8;

/** Anything with an assignee and dates can be workload-planned (tracker rows qualify). */
export type WorkloadTicket = TicketLike & { assigneeId?: string | null };

/** Inclusive date window; omitted/null bounds are unbounded on that side. */
export type DateRangeFilter = {
  start?: string | Date | null;
  end?: string | Date | null;
};

export type WorkloadOptions = {
  /** Scope the workload to an iteration/sprint window (start/due date overlap). */
  dateRange?: DateRangeFilter;
};

export type WorkloadBucket = {
  /** Assignee id, or `UNASSIGNED_BUCKET`. */
  assigneeId: string;
  /** Open (not `done`/`cancelled`, via `isClosed`) tickets in scope. */
  openCount: number;
  /** Summed estimate of those open tickets (`sumEstimates`: dominant unit, 2dp). */
  points: number;
  /** Dominant estimate unit behind `points` (`"points"` when nothing is set). */
  unit: string;
};

function rangeTime(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

/**
 * Does the ticket fall inside `range`? Overlap of `[start..due]` with the
 * window, both ends inclusive. A ticket carrying only one date counts as a
 * one-day span on that date (same fallback as `timelineLayout`); a ticket
 * with no usable dates can only be placed when the window is unbounded, and
 * a `dateRange` without bounds does not filter anything at all.
 */
function inDateRange(ticket: WorkloadTicket, range: DateRangeFilter | undefined): boolean {
  if (!range) return true;
  const from = rangeTime(range.start);
  const to = rangeTime(range.end);
  if (from === null && to === null) return true;
  const begin = rangeTime(ticket.startDate ?? ticket.dueDate);
  const end = rangeTime(ticket.dueDate ?? ticket.startDate);
  if (begin === null || end === null) return false;
  if (from !== null && end < from) return false;
  if (to !== null && begin > to) return false;
  return true;
}

/**
 * Per-person load: one bucket per assignee (plus `UNASSIGNED_BUCKET`) with
 * the number of open tickets and the summed estimate of those tickets.
 * Closed tickets never count, and assignees holding no open ticket in scope
 * get no bucket. Buckets are sorted by load — open count desc, then points
 * desc, then id asc — so a workload panel renders ready-ordered.
 *
 * Note: `points` is the raw sum of whatever estimate unit the tickets use;
 * keep a single unit per view (that is what `unit` reports per bucket).
 */
export function workloadByAssignee<T extends WorkloadTicket>(
  tickets: T[],
  opts: WorkloadOptions = {},
): WorkloadBucket[] {
  const open = tickets.filter(
    (ticket) => !isClosed(ticket.status) && inDateRange(ticket, opts.dateRange),
  );
  const byAssignee = new Map<string, T[]>();
  for (const ticket of open) {
    const raw = ticket.assigneeId?.trim();
    const id = raw ? raw : UNASSIGNED_BUCKET;
    const existing = byAssignee.get(id);
    if (existing) existing.push(ticket);
    else byAssignee.set(id, [ticket]);
  }
  const buckets: WorkloadBucket[] = [];
  for (const [assigneeId, items] of byAssignee) {
    const { total, unit } = sumEstimates(items);
    buckets.push({ assigneeId, openCount: items.length, points: total, unit });
  }
  return buckets.sort((a, b) => {
    if (a.openCount !== b.openCount) return b.openCount - a.openCount;
    if (a.points !== b.points) return b.points - a.points;
    return a.assigneeId.localeCompare(b.assigneeId);
  });
}

/** What a person's load is measured against: estimate points or open ticket count. */
export type CapacityBasis = "points" | "tickets";

/** Per-person capacity limits; the field not matching the basis is ignored. */
export type CapacityLimits = {
  /** Max estimate points one person may hold at once. */
  maxPoints?: number | null;
  /** Max open tickets one person may hold at once. */
  maxOpenTickets?: number | null;
};

export type CapacityState = "over" | "near" | "under" | "unknown";

export type CapacityRow = {
  assigneeId: string;
  /** Load on the requested basis. */
  used: number;
  /** Resolved limit, or null when the capacity is missing/unusable. */
  limit: number | null;
  /** `used / limit` rounded to 4dp; null whenever no ratio could be computed. */
  utilization: number | null;
  /** `over` ≥ limit, `near` ≥ threshold, `under` below, `unknown` without a limit. */
  state: CapacityState;
};

export type CapacityOptions = {
  /** Which limit to measure. Default `"points"`. */
  basis?: CapacityBasis;
  /** Ratio at/above which a person counts as "near" capacity. Default 0.8. */
  nearThreshold?: number;
};

function capacityRow(
  assigneeId: string,
  used: number,
  limits: CapacityLimits | undefined,
  basis: CapacityBasis,
  nearThreshold: number,
): CapacityRow {
  const raw = limits == null
    ? null
    : basis === "tickets"
      ? limits.maxOpenTickets
      : limits.maxPoints;
  const limit = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  // Fail-safe: missing/invalid capacity never gets divided — report unknown.
  if (limit === null || limit < 0) {
    return { assigneeId, used, limit: null, utilization: null, state: "unknown" };
  }
  // Zero capacity has no meaningful ratio; only flag it when there is load.
  if (limit === 0) {
    return { assigneeId, used, limit: 0, utilization: null, state: used > 0 ? "over" : "unknown" };
  }
  const utilization = Math.round((used / limit) * 10000) / 10000;
  const state: CapacityState =
    utilization >= 1 ? "over" : utilization >= nearThreshold ? "near" : "under";
  return { assigneeId, used, limit, utilization, state };
}

/**
 * Turn workload buckets + per-person capacity limits into utilization rows:
 * one per bucket, plus anyone who declared capacity but holds no open work
 * (shown with 0 used, so idle people are visible). The utilization ratio is
 * rounded to 4dp and the over/near/under flag is derived from that rounded
 * number, so the displayed ratio and the flag always agree. A missing,
 * non-finite or negative limit yields `utilization: null` / `state:
 * "unknown"` — never NaN or Infinity.
 */
export function capacityStatus(
  workload: WorkloadBucket[],
  capacityByUser: Partial<Record<string, CapacityLimits>>,
  opts: CapacityOptions = {},
): CapacityRow[] {
  const basis = opts.basis ?? "points";
  const nearThreshold = opts.nearThreshold ?? DEFAULT_NEAR_THRESHOLD;
  const usedOf = (bucket: WorkloadBucket) =>
    basis === "tickets" ? bucket.openCount : bucket.points;

  const rows = workload.map((bucket) =>
    capacityRow(bucket.assigneeId, usedOf(bucket), capacityByUser[bucket.assigneeId], basis, nearThreshold),
  );
  const known = new Set(workload.map((bucket) => bucket.assigneeId));
  for (const assigneeId of Object.keys(capacityByUser)) {
    if (known.has(assigneeId)) continue;
    rows.push(capacityRow(assigneeId, 0, capacityByUser[assigneeId], basis, nearThreshold));
  }
  return rows;
}

export type RebalanceOptions = WorkloadOptions & { basis?: CapacityBasis };

export type RebalanceSuggestion = {
  /** Assignee holding the most open work (null when there is none to move). */
  from: string | null;
  /** Least-loaded eligible colleague (null when there is no alternative). */
  to: string | null;
  fromLoad: number;
  toLoad: number | null;
};

/**
 * Who should hand work to whom? Deterministic, intentionally simple
 * heuristic (documented so the UI copy can mirror it):
 *
 *  1. Scope the tickets exactly like `workloadByAssignee` — open tickets
 *     only, optional `dateRange` window.
 *  2. `from` must actually hold open work: the non-`unassigned` bucket with
 *     the highest load (points by default), ties broken by open count desc,
 *     then assignee id asc.
 *  3. `to` is the *least* loaded eligible candidate, excluding `from`:
 *     everyone with open work in scope plus anyone listed in
 *     `capacityByUser` (they can absorb new work), ties broken by load asc,
 *     open count asc, then id asc.
 *  4. `unassigned` is never a sender or a receiver — there is no person at
 *     that end of the move.
 *  5. No open work at all → nothing to suggest; only one candidate → `to`
 *     stays null.
 */
export function suggestRebalance(
  tickets: WorkloadTicket[],
  capacityByUser: Partial<Record<string, CapacityLimits>>,
  opts: RebalanceOptions = {},
): RebalanceSuggestion {
  const basis = opts.basis ?? "points";
  const workload = workloadByAssignee(tickets, opts);
  const load = (bucket: WorkloadBucket) =>
    basis === "tickets" ? bucket.openCount : bucket.points;

  const holders = new Map<string, { assigneeId: string; openCount: number; load: number }>();
  for (const bucket of workload) {
    if (bucket.assigneeId === UNASSIGNED_BUCKET) continue;
    holders.set(bucket.assigneeId, {
      assigneeId: bucket.assigneeId,
      openCount: bucket.openCount,
      load: load(bucket),
    });
  }
  if (holders.size === 0) return { from: null, to: null, fromLoad: 0, toLoad: null };

  const from = [...holders.values()].sort(
    (a, b) =>
      b.load - a.load ||
      b.openCount - a.openCount ||
      a.assigneeId.localeCompare(b.assigneeId),
  )[0];

  const eligible = new Map(holders);
  eligible.delete(from.assigneeId);
  for (const assigneeId of Object.keys(capacityByUser)) {
    if (assigneeId === UNASSIGNED_BUCKET || assigneeId === from.assigneeId) continue;
    if (eligible.has(assigneeId)) continue; // already holds work; keep their real load
    eligible.set(assigneeId, { assigneeId, openCount: 0, load: 0 });
  }
  if (eligible.size === 0) {
    return { from: from.assigneeId, to: null, fromLoad: from.load, toLoad: null };
  }

  const to = [...eligible.values()].sort(
    (a, b) =>
      a.load - b.load ||
      a.openCount - b.openCount ||
      a.assigneeId.localeCompare(b.assigneeId),
  )[0];
  return { from: from.assigneeId, to: to.assigneeId, fromLoad: from.load, toLoad: to.load };
}
