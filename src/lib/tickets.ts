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

export const LABEL_COLORS = [
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
  const color = LABEL_COLORS.includes(requested as (typeof LABEL_COLORS)[number])
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
